#!/usr/bin/env bun
/**
 * Replay a network's governance history through the node's own governance code, read-only on
 * every input, and compare it with the chain.
 *
 *   bun scripts/gov-replay.ts --chunks <immutable dir> --ref-db <node sqlite> --work <dir>
 *       [--network preview] [--genesis src/config/preview/conway-genesis.json]
 *       [--koios-proposals proposals.json] [--koios-totals totals.json]
 *       [--nes <slot>=<state file> ...] [--to-slot N] [--phase pre|conway|all] [--report-every N]
 *       [--koios-dist <cache dir> [--koios-dist-epochs ratified|<e1,e2,…>]]
 *       [--verbose] (the node's INFO log lines)
 *
 * Phase `pre` scans every block before the Conway era with a raw CBOR walk (no ledger-ts) for the
 * stake registrations, pool delegations, pool registrations and retirements the governance rules
 * read, and saves `<work>/pre-conway.db`. Phase `conway` starts from a copy of it and, block by
 * block, runs `checkBlockGovernance` (GOV / GOVCERT / DELEG / POOL, the body validator's call)
 * against the state before the block, then applies the block's certificates, proposals and votes
 * with the functions `applyTransaction` uses (ledger-ts decode, as the node). At every boundary it
 * runs the node's `enactPending` / POOLREAP / `ratifyForNext` with the node's stored stake
 * snapshots (`epoch_pool_stake`, `epoch_drep_stake` of --ref-db) and the chain's treasury (Koios
 * `totals`), and compares ratified / expiring / enacted / expired / dropped actions with Koios
 * `proposal_list`. At each `--nes` slot it compares the governance state with the decoded
 * NewEpochState (Mithril / cardano-node ledger snapshot). With `--koios-dist`, the boundaries of the
 * chosen epochs (default: every epoch where the chain ratified something, and the one before) are
 * ratified with Koios' DRep and SPO voting distributions instead (`drep_history`,
 * `pool_voting_power_history`, cached in the directory), which isolates the rule from our stake
 * computation. Nothing outside `--work` and the cache is written.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { initSql, sql } from "../src/sql";
import { applyCertificates, ensureInitialized } from "../src/db";
import { ChunkStore } from "../src/storage/chunkStore";
import { epochForSlot, firstSlotOfEpoch, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { blockTxBodies, bodyHasKey, decodeGovTx } from "../src/consensus/governance/govTxDecode";
import { checkBlockGovernance } from "../src/consensus/governance/govValidate";
import { enactPending, ratifyForNext, recordProposals, recordVotes, seedGovernance } from "../src/consensus/governance/state";
import { loadCommitteeView, loadDReps, loadLiveProposals, loadRoots } from "../src/consensus/governance/govLedgerView";
import { promotePendingPoolParams, recordPoolRegistration, recordPoolRetirement, retirePoolsAtEpochDetailed } from "../src/db/leaderState";
import { logger, LogLevel } from "../src/utils/logger";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const opts = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]!] : []));
const network = opt("network", "preview")!;
const chunksDir = opt("chunks")!, refDbPath = opt("ref-db")!, work = opt("work")!;
const genesisPath = opt("genesis", `src/config/${network}/conway-genesis.json`)!;
const phase = opt("phase", "all")!;
const toSlot = Number(opt("to-slot", String(Number.MAX_SAFE_INTEGER)));
const reportEvery = Number(opt("report-every", "20"));
const koiosProposalsPath = opt("koios-proposals"), koiosTotalsPath = opt("koios-totals");
const koiosDistDir = opt("koios-dist");
const nesChecks = opts("nes").map((x) => { const [s, f] = x.split("="); return { slot: Number(s), file: f! }; }).sort((a, b) => a.slot - b.slot);
if (!chunksDir || !refDbPath || !work) { console.error("usage: see the header of scripts/gov-replay.ts"); process.exit(2); }
mkdirSync(work, { recursive: true });
setEpochNetwork(network);
logger.setLogConfig({ logLevel: argv.includes("--verbose") ? LogLevel.INFO : LogLevel.ERROR, logToFile: false, logToConsole: true } as any);

const ref = new Database(refDbPath, { readonly: true });
const paramsCache = new Map<number, Record<string, unknown>>();
function rawParams(e: number): Record<string, unknown> {
    let p = paramsCache.get(e);
    if (!p) { const r = ref.query("SELECT params FROM epoch_params WHERE epoch = ?").get(e) as { params: string } | null; p = r ? JSON.parse(r.params) : {}; paramsCache.set(e, p!); }
    return p!;
}
const conwayStart = (() => { for (let e = 0; e < 5000; e++) if (Number(rawParams(e).protocol_major_ver ?? 0) >= 9) return e; throw new Error("no Conway epoch in the reference parameters"); })();
const conwayStartSlot = Number(firstSlotOfEpoch(conwayStart));
const store = await ChunkStore.open(chunksDir, { chunkSlots: network === "mainnet" ? 21600 : 4320, cacheChunks: 4, readOnly: true });
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(0);

// ───────────────────────────── phase pre: accounts and pools before Conway ─────────────────────────────

const preDb = join(work, "pre-conway.db"), dbPath = join(work, "replay.db");
async function phasePre(): Promise<void> {
    for (const f of [preDb, `${preDb}-wal`, `${preDb}-shm`]) if (existsSync(f)) rmSync(f);
    initSql(preDb);
    await ensureInitialized();
    await sql`PRAGMA synchronous = OFF`;
    const CERTS = new Set([4]);
    let epoch = -1, blocks = 0, certs = 0;
    await sql`BEGIN`;
    for await (const b of store.iterate(0, conwayStartSlot - 1)) {
        const e = Number(epochForSlot(b.slot));
        if (e !== epoch) {
            if (epoch >= 0) { await promotePendingPoolParams(sql); await retirePoolsAtEpochDetailed(sql, e); await sql`COMMIT`; await sql`BEGIN`; }
            epoch = e;
            if (e % 50 === 0) console.log(`[pre ${secs()}s] epoch ${e}: ${blocks} blocks, ${certs} certificates`);
        }
        blocks++;
        let parsed; try { parsed = blockTxBodies(b.bytes); } catch { continue; }
        if (parsed.era < 2) continue;
        for (let i = 0; i < parsed.bodies.length; i++) {
            if (parsed.invalid.has(i) || !bodyHasKey(parsed.bodies[i]!, CERTS)) continue;
            const m = decodeGovTx(parsed.bodies[i]!);
            for (const c of m.certs) { await applyPreCert(c, b.slot); certs++; }
        }
    }
    await promotePendingPoolParams(sql); await retirePoolsAtEpochDetailed(sql, conwayStart);
    await sql`COMMIT`;
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    console.log(`[pre ${secs()}s] done: ${blocks} blocks to slot ${conwayStartSlot - 1}, ${certs} certificates; pools reaped at ${conwayStart}`);
}
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
async function applyPreCert(c: ReturnType<typeof decodeGovTx>["certs"][number], slot: number): Promise<void> {
    const cred = c.cred, t = cred && cred.length === 58 ? 1 : 0, hash = cred ? (t ? cred.slice(2) : cred) : "";
    switch (c.type) {
        case 0: await sql`INSERT OR REPLACE INTO stake (stake_credentials, cred_type, amount) VALUES (${hexBytes(hash)}, ${t}, 0)`; break;
        case 1:
            await sql`DELETE FROM stake WHERE stake_credentials = ${hexBytes(hash)} AND cred_type = ${t}`;
            await sql`DELETE FROM delegations WHERE stake_credentials = ${hexBytes(hash)} AND cred_type = ${t}`;
            break;
        case 2:
            await sql`DELETE FROM delegations WHERE stake_credentials = ${hexBytes(hash)} AND cred_type = ${t}`;
            await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${hexBytes(hash)}, ${t}, ${hexBytes(c.pool!)})`;
            break;
        case 3: await recordPoolRegistration(sql, c.pool!, c.poolReg!.vrf, slot, { pledge: "0", cost: String(c.poolReg!.cost), marginNum: "0", marginDen: "1", rewardAccount: c.poolReg!.rewardAccount.cred, owners: [] }); break;
        case 4: await recordPoolRetirement(sql, c.pool!, c.epoch!); break;
    }
}

// ───────────────────────────── phase conway ─────────────────────────────

type KP = { proposal_tx_hash: string; proposal_index: number; proposal_type: string; ratified_epoch: number | null; enacted_epoch: number | null; dropped_epoch: number | null; expired_epoch: number | null };
const koios: KP[] = koiosProposalsPath ? JSON.parse(await Bun.file(koiosProposalsPath).text()) : [];
const kid = (p: KP) => `${p.proposal_tx_hash}:${p.proposal_index}`;
const treasuryAt = new Map<number, bigint>();
if (koiosTotalsPath) for (const t of JSON.parse(await Bun.file(koiosTotalsPath).text()) as Array<{ epoch_no: number; treasury: string }>) treasuryAt.set(t.epoch_no, BigInt(t.treasury));
const genesis = JSON.parse(await Bun.file(genesisPath).text());

const summary = { blocks: 0, govBlocks: 0, govTxs: 0, failures: [] as string[], reports: 0, boundaryMismatches: [] as string[], nes: [] as string[] };

function setDiff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[] } { return { onlyA: [...a].filter((x) => !b.has(x)), onlyB: [...b].filter((x) => !a.has(x)) }; }
function cmp(epoch: number, what: string, ours: Set<string>, chain: Set<string>): void {
    const d = setDiff(ours, chain);
    if (d.onlyA.length || d.onlyB.length) summary.boundaryMismatches.push(`epoch ${epoch} ${what}: ours-only [${d.onlyA.map((x) => x.slice(0, 12)).join(", ")}] chain-only [${d.onlyB.map((x) => x.slice(0, 12)).join(", ")}]`);
}


const koiosDistEpochs = new Set<number>();
function initKoiosDistEpochs(): void {
    if (!koiosDistDir) return;
    const spec = opt("koios-dist-epochs", "ratified")!;
    if (spec === "ratified") { for (const p of koios) if (p.ratified_epoch != null) { koiosDistEpochs.add(p.ratified_epoch); koiosDistEpochs.add(p.ratified_epoch - 1); } }
    else for (const e of spec.split(",")) koiosDistEpochs.add(Number(e));
    mkdirSync(koiosDistDir, { recursive: true });
}
async function koiosPages(path: string, cache: string): Promise<any[]> {
    if (existsSync(cache)) return JSON.parse(await Bun.file(cache).text());
    const out: any[] = [];
    for (let off = 0; ; off += 1000) {
        let d: any[] | null = null;
        for (let attempt = 0; attempt < 6 && !d; attempt++) {
            try { const res = await fetch(`https://${network}.koios.rest/api/v1/${path}&offset=${off}&limit=1000`); if (res.ok) d = (await res.json()) as any[]; } catch { /* retry */ }
            if (!d) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
        if (!d) throw new Error(`koios ${path} offset ${off}: no answer`);
        out.push(...d);
        if (d.length < 1000) break;
        await new Promise((r) => setTimeout(r, 300)); // stay well under the public rate limit
    }
    await Bun.write(cache, JSON.stringify(out));
    return out;
}
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Bytes(s: string): Uint8Array { const data = [...s.slice(s.lastIndexOf("1") + 1, -6)].map((c) => B32.indexOf(c)); let acc = 0, bits = 0; const out: number[] = []; for (const v of data) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } } return Uint8Array.from(out); }
async function koiosDistributions(e: number): Promise<{ drepDistr: Map<string, bigint>; poolDistr: Map<string, bigint> }> {
    const dreps = await koiosPages(`drep_history?_epoch_no=${e}`, join(koiosDistDir!, `drep-${e}.json`));
    const pools = await koiosPages(`pool_voting_power_history?_epoch_no=${e}`, join(koiosDistDir!, `pool-${e}.json`));
    const drepDistr = new Map<string, bigint>();
    for (const d of dreps) {
        const id = String(d.drep_id);
        const k = id === "drep_always_abstain" ? "abstain" : id === "drep_always_no_confidence" ? "noconfidence" : (() => { const b = bech32Bytes(id); const hx = Buffer.from(b).toString("hex"); return b.length === 29 ? (b[0] === 0x23 ? "01" + hx.slice(2) : hx.slice(2)) : hx; })();
        drepDistr.set(k, (drepDistr.get(k) ?? 0n) + BigInt(d.amount));
    }
    const poolDistr = new Map<string, bigint>();
    for (const p of pools) { const v = BigInt(p.amount); if (v > 0n) poolDistr.set(Buffer.from(bech32Bytes(String(p.pool_id_bech32))).toString("hex"), v); }
    return { drepDistr, poolDistr };
}

async function boundary(e: number): Promise<void> {
    const raw = rawParams(e);
    const hasState = ((await sql`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][]).length > 0;
    if (hasState) await enactPending(sql, e);
    await promotePendingPoolParams(sql);
    await retirePoolsAtEpochDetailed(sql, e);
    if (Number(raw.protocol_major_ver ?? 0) < 9) return;
    await seedGovernance(sql, genesis, e);
    // the node's stored stake snapshots of this boundary
    for (const r of ref.query("SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ?").values(e) as any[]) await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${String(r[0])}, ${String(r[1])})`;
    for (const r of ref.query("SELECT drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at = ?").values(e) as any[]) await sql`INSERT OR IGNORE INTO epoch_drep_stake (taken_at, drep_type, drep_hash, stake) VALUES (${e}, ${Number(r[0])}, ${String(r[1] ?? "")}, ${String(r[2])})`;
    // the chain's treasury during the epoch (LEDGER's current_treasury_value check reads the pots)
    const tr = treasuryAt.get(e);
    if (tr != null) { await sql`DELETE FROM reward_pots`; await sql`INSERT INTO reward_pots (id, reserves, treasury, fee_pot, initialized_epoch) VALUES (1, 0, ${tr.toString()}, 0, ${e})`; }
    const dist = koiosDistEpochs.has(e) ? await koiosDistributions(e) : {};
    const pend = await ratifyForNext(sql, e, raw, e, { treasury: tr, ...dist });
    if (!koios.length) return;
    const decided = (await sql`SELECT action_id, status FROM gov_proposals WHERE decided_epoch = ${e}`.values()) as unknown[][];
    const ours = (st: string) => new Set(decided.filter((r) => String(r[1]) === st).map((r) => String(r[0])));
    cmp(e, "ratified", new Set(pend.ratified), new Set(koios.filter((p) => p.ratified_epoch === e).map(kid)));
    cmp(e, "expiring", new Set(pend.expired), new Set(koios.filter((p) => p.expired_epoch === e).map(kid)));
    cmp(e, "enacted", ours("enacted"), new Set(koios.filter((p) => p.enacted_epoch === e).map(kid)));
    cmp(e, "removed-expired", ours("expired"), new Set(koios.filter((p) => p.dropped_epoch === e && p.expired_epoch != null).map(kid)));
    cmp(e, "removed-orphan", ours("dropped"), new Set(koios.filter((p) => p.dropped_epoch === e && p.expired_epoch == null && p.enacted_epoch == null).map(kid)));
}

async function nesCompare(slot: number, file: string): Promise<void> {
    const { decodeLedgerSnapshot, typedHex } = await import("../src/mithril/nesDecoder");
    const s: any = decodeLedgerSnapshot(await Bun.file(file).bytes());
    const out: string[] = [];
    const note = (m: string) => out.push(`NES ${slot} (epoch ${s.epoch}): ${m}`);
    // DReps: typed credential, expiry, deposit
    const ours = await loadDReps();
    let dOk = 0, dBad = 0; const dEx: string[] = [];
    const theirs = new Map<string, { expiry: number; deposit: bigint }>(s.dreps.map((d: any) => [typedHex(d.cred), { expiry: d.expiry, deposit: d.deposit }]));
    for (const [c, d] of theirs) { const o = ours.get(c); if (o && o.expiry === d.expiry && o.deposit === d.deposit) dOk++; else { dBad++; if (dEx.length < 5) dEx.push(`${c.slice(0, 12)} chain ${d.expiry}/${d.deposit} ours ${o ? `${o.expiry}/${o.deposit}` : "absent"}`); } }
    const extra = [...ours.keys()].filter((c) => !theirs.has(c));
    note(`DReps: ${dOk} equal, ${dBad} differ, ${extra.length} only ours${dEx.length ? ` — ${dEx.join("; ")}` : ""}${extra.length ? ` — only ours ${extra.slice(0, 3).map((x) => x.slice(0, 12)).join(", ")}` : ""}`);
    // committee (typed)
    const cv = await loadCommitteeView();
    const cm = s.gov.committee ? new Map<string, number>([...s.gov.committee.members]) : null;
    const memEq = cm == null ? cv.members == null : cv.members != null && [...cm].every(([k, v]) => cv.members!.get(k) === v) && [...cv.rowMembers!.keys()].length === cm.size;
    note(`committee members ${memEq ? "EQUAL" : `DIFFER chain ${cm ? [...cm].map(([k, v]) => `${k.slice(0, 10)}:${v}`).join(",") : "none"} ours ${cv.rowMembers ? [...cv.rowMembers].map(([k, v]) => `${k.slice(0, 10)}:${v}`).join(",") : "none"}`}`);
    const cs = [...s.committeeState].map(([k, v]: any) => `${k}→${v.hot ? typedHex(v.hot) : "resigned"}`).sort();
    const ocs = [...cv.rowCreds].map(([k, v]) => `${k.length === 58 && k.startsWith("00") ? k.slice(2) : k}→${v.resigned ? "resigned" : v.hot}`).sort();
    note(`committee state ${JSON.stringify(cs) === JSON.stringify(ocs) ? "EQUAL" : `DIFFER chain ${cs.map((x) => x.slice(0, 26)).join(",")} ours ${ocs.map((x) => x.slice(0, 26)).join(",")}`}`);
    // proposals and votes
    const live = await loadLiveProposals();
    const lp = new Set(live.map((p) => p.id)), np = new Set<string>(s.gov.proposals.map((p: any) => p.id));
    const pd = setDiff(lp, np);
    note(`live proposals: ours ${lp.size} chain ${np.size}${pd.onlyA.length || pd.onlyB.length ? ` — ours-only ${pd.onlyA.map((x) => x.slice(0, 12)).join(",")} chain-only ${pd.onlyB.map((x) => x.slice(0, 12)).join(",")}` : " EQUAL"}`);
    let vBad = 0;
    for (const p of s.gov.proposals as any[]) {
        const n = ((await sql`SELECT COUNT(*) FROM gov_votes WHERE action_id = ${p.id}`.values()) as unknown[][])[0]![0];
        if (Number(n) !== p.ccVotes.size + p.drepVotes.size + p.spoVotes.size) { vBad++; if (vBad <= 3) note(`votes on ${p.id.slice(0, 12)}: ours ${n} chain ${p.ccVotes.size}+${p.drepVotes.size}+${p.spoVotes.size}`); }
    }
    note(`votes: ${vBad} proposal(s) with a different vote count`);
    const roots = await loadRoots(live);
    const r = s.gov.roots;
    const rEq = roots.pparams === r.pparams && roots.hardfork === r.hardFork && roots.committee === r.committee && roots.constitution === r.constitution;
    note(`roots ${rEq ? "EQUAL" : `DIFFER ours ${JSON.stringify(roots)} chain ${JSON.stringify(r)}`}`);
    const st = ((await sql`SELECT pending, dormant_epochs FROM gov_state WHERE id = 1`.values()) as unknown[][])[0]!;
    const pending = st[0] ? JSON.parse(String(st[0])) : { ratified: [], expired: [] };
    note(`pulser: chain enacted [${s.gov.pulsing.enacted.map((x: string) => x.slice(0, 12))}] expired ${s.gov.pulsing.expired.length}; ours ratified [${pending.ratified.map((x: string) => x.slice(0, 12))}] expired ${pending.expired.length} ${JSON.stringify([...s.gov.pulsing.expired].sort()) === JSON.stringify([...pending.expired].sort()) && JSON.stringify(s.gov.pulsing.enacted) === JSON.stringify(pending.ratified) ? "EQUAL" : "DIFFER"}; dormant chain ${s.dormantEpochs} ours ${st[1]}`);
    // vote delegations of every account
    const dl = new Map<string, string>();
    for (const r of (await sql`SELECT stake_key, drep_type, drep_hash FROM gov_drep_delegations`.values()) as unknown[][]) dl.set(String(r[0]), `${r[1]}:${r[2] ?? ""}`);
    let same = 0, diff = 0; const dex: string[] = [];
    for (const u of s.umap as any[]) {
        const k = typedHex(u.cred);
        const theirsD = u.drep ? `${u.drep.kind}:${u.drep.kind <= 1 ? u.drep.hash : ""}` : null;
        const oursD = dl.get(k) ?? null;
        if (theirsD === (oursD === null ? null : oursD.replace(/:null$/, ":"))) same++; else { diff++; if (dex.length < 4) dex.push(`${k.slice(0, 12)} chain ${theirsD} ours ${oursD}`); }
    }
    note(`vote delegations: ${same} equal, ${diff} differ${dex.length ? ` — ${dex.join("; ")}` : ""}`);
    for (const m of out) { console.log(m); summary.nes.push(m); }
}

async function phaseConway(): Promise<void> {
    initKoiosDistEpochs();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f);
    copyFileSync(preDb, dbPath);
    initSql(dbPath);
    await ensureInitialized();
    await sql`PRAGMA synchronous = OFF`;
    // the parameter records the governance code reads (drep_activity, lifetimes, thresholds)
    await sql`CREATE TABLE IF NOT EXISTS epoch_params (epoch INTEGER PRIMARY KEY, params TEXT NOT NULL, source TEXT, fetched_at INTEGER DEFAULT (strftime('%s','now')))`;
    for (const r of ref.query("SELECT epoch, params, source FROM epoch_params WHERE epoch >= ?").values(conwayStart - 1) as any[]) await sql`INSERT OR REPLACE INTO epoch_params (epoch, params, source) VALUES (${Number(r[0])}, ${String(r[1])}, ${String(r[2] ?? "local")})`;
    const APPLY = new Set([4, 19, 20]);
    let epoch = conwayStart - 1, nesIdx = 0;
    await sql`BEGIN`;
    await boundary(conwayStart); epoch = conwayStart;
    for await (const b of store.iterate(conwayStartSlot, toSlot)) {
        const e = Number(epochForSlot(b.slot));
        while (nesIdx < nesChecks.length && nesChecks[nesIdx]!.slot < b.slot) { await sql`COMMIT`; await nesCompare(nesChecks[nesIdx]!.slot, nesChecks[nesIdx]!.file); await sql`BEGIN`; nesIdx++; }
        if (e !== epoch) {
            for (let x = epoch + 1; x <= e; x++) await boundary(x);
            epoch = e;
            await sql`COMMIT`; await sql`BEGIN`;
            if (e % reportEvery === 0) console.log(`[conway ${secs()}s] epoch ${e}: ${summary.blocks} blocks, ${summary.govTxs} governance txs, ${summary.failures.length} rule failure(s), ${summary.boundaryMismatches.length} boundary mismatch(es)`);
        }
        summary.blocks++;
        let parsed; try { parsed = blockTxBodies(b.bytes); } catch { continue; }
        const raw = rawParams(e);
        const v = await checkBlockGovernance({ slot: b.slot, epoch: e, bodies: parsed.bodies.map((bytes) => ({ bytes })), invalid: parsed.invalid, raw, networkId: network === "mainnet" ? 1 : 0, balancesUnknown: true });
        if (v.checked) { summary.govBlocks++; summary.govTxs += v.checked; }
        summary.reports += v.reports.length;
        for (const f of v.failures) { summary.failures.push(`slot ${b.slot} (epoch ${e}) ${f}`); if (summary.failures.length <= 50) console.log(`FAIL slot ${b.slot} (epoch ${e}) ${f}`); }
        if (!parsed.bodies.some((x, i) => !parsed.invalid.has(i) && bodyHasKey(x, APPLY))) continue;
        // apply as db.ts applyTransaction does (certificates, then proposals, then votes)
        const m: any = MultiEraBlock.fromCbor(b.bytes);
        const txs: any[] = m.block.transactionBodies ?? [];
        for (let i = 0; i < txs.length; i++) {
            if (parsed.invalid.has(i) || !bodyHasKey(parsed.bodies[i]!, APPLY)) continue;
            const body = txs[i];
            const txId = String(body.hash.toString());
            if (Array.isArray(body.certs) && body.certs.length) await applyCertificates(body.certs, b.hash, sql, { slot: b.slot, epoch: e, txIndex: i });
            if (Array.isArray(body.proposalProcedures) && body.proposalProcedures.length) await recordProposals(sql, txId, body.proposalProcedures, e, Number(raw.gov_action_lifetime ?? 6), parsed.bodies[i]!);
            if (Array.isArray(body.votingProcedures?.procedures) && body.votingProcedures.procedures.length) await recordVotes(sql, body.votingProcedures.procedures, b.slot, e);
        }
    }
    await sql`COMMIT`;
    while (nesIdx < nesChecks.length && nesChecks[nesIdx]!.slot <= toSlot) { await nesCompare(nesChecks[nesIdx]!.slot, nesChecks[nesIdx]!.file); nesIdx++; }
}

if (phase === "pre" || phase === "all") await phasePre();
if (phase === "conway" || phase === "all") {
    await phaseConway();
    console.log(`\n=== governance replay (${secs()} s) ===`);
    console.log(`blocks ${summary.blocks}, blocks with governance content ${summary.govBlocks}, transactions checked ${summary.govTxs}, reports ${summary.reports}`);
    console.log(`rule failures: ${summary.failures.length}`);
    for (const f of summary.failures.slice(0, 40)) console.log("  " + f);
    console.log(`boundary mismatches against Koios: ${summary.boundaryMismatches.length}`);
    for (const m of summary.boundaryMismatches.slice(0, 60)) console.log("  " + m);
    for (const m of summary.nes) console.log("  " + m);
    await Bun.write(join(work, "summary.json"), JSON.stringify(summary, null, 1));
}
process.exit(0);
