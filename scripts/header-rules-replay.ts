#!/usr/bin/env bun
/**
 * Replay the header ledger rules over a node's chain (immutable chunks, then the volatile blocks of
 * its selected chain), read-only, headers only:
 *
 *  OCERT (bug 276): the Praos/TPraos counter rule along the chain (m ≤ n, from Babbage n ≤ m + 1;
 *    m = 0 for a pool never seen), and the node's mechanism for headers checked ahead of apply —
 *    `LeaderChecker.counterAsOf` with the store "applied" `--lag` headers behind, every header in
 *    between known only as a validated header — must give the chain's m for every header.
 *  σ (bug 275): every Praos header of an epoch whose leader distribution an `--exact` LMDB store holds
 *    (the snapshot taken at the start of the previous epoch) must clear `isSlotLeader` with the exact
 *    σ = pool stake / total active stake. `--approx` stores (e.g. one seeded from SQLite) are judged
 *    the same way and reported separately, with a per-pool comparison where both hold a snapshot.
 *
 *   bun scripts/header-rules-replay.ts --node <node dir> [--exact <ledger dir>[,<ledger dir>]] [--approx <ledger dir>]
 *       [--lag 500] [--network preview] [--from-slot N] [--out result.json]
 * Ledger dirs are opened read-only; their volatile diffs are read along each store's own selected
 * chain (`<ledger dir>/../db/gerolamo/selected-tip.hex` when present).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { ChunkStore } from "../src/storage/chunkStore";
import { VolatileStore } from "../src/storage/volatileStore";
import { LedgerStore } from "../src/ledger/LedgerStore";
import { StakeReads } from "../src/ledger/stakeStore";
import { GovReads } from "../src/ledger/govStore";
import { decodeCbor, type Cbor } from "../src/consensus/governance/govTxDecode";
import { isSlotLeader } from "../src/consensus/rules/leaderMath";
import { LeaderChecker, opcertCounterVerdict, type CounterStateSource } from "../src/consensus/rules/leaderCheck";
import { epochForSlot, setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { logger, LogLevel } from "../src/utils/logger";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const node = opt("node")!;
if (!node) { console.error("usage: bun scripts/header-rules-replay.ts --node <node dir> [--exact <ledger dir>] [--approx <ledger dir>] [--lag 500]"); process.exit(2); }
const network = opt("network", "preview")!;
setEpochNetwork(network);
logger.setLogConfig({ logLevel: LogLevel.ERROR, logToFile: false, logToConsole: true } as any);
const lag = Number(opt("lag", "500"));
const fromSlot = Number(opt("from-slot", "0"));
const genesis = JSON.parse(readFileSync(`${import.meta.dir}/../src/config/${network}/shelley-genesis.json`, "utf8"));
const f = Number(genesis.activeSlotsCoeff ?? 0.05);

// ---- stake distributions per epoch (takenAt = epoch − 1), from each store's selected chain
type Dist = { total: bigint; stake: Map<string, bigint> };
function openStore(dir: string): { st: LedgerStore; sr: StakeReads; gr: GovReads } {
    const st = LedgerStore.open(dir, { readOnly: true });
    const tipFile = join(dirname(dir), "db", "gerolamo", "selected-tip.hex");
    if (existsSync(tipFile)) { const h = readFileSync(tipFile, "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(h) && st.knows(Uint8Array.from(Buffer.from(h, "hex")))) st.selectTip(Uint8Array.from(Buffer.from(h, "hex"))); }
    return { st, sr: new StakeReads(st), gr: new GovReads(st as any) };
}
function distributions(dirs: string[]): { byEpoch: Map<number, Dist>; d: Map<number, string> } {
    const byEpoch = new Map<number, Dist>(), d = new Map<number, string>();
    for (const dir of dirs) {
        const { st, sr, gr } = openStore(dir);
        for (const takenAt of sr.snapshotEpochs()) {
            const t = sr.snapshotTotals(takenAt);
            if (!t || byEpoch.has(takenAt + 1)) continue;
            const stake = sr.snapshotPoolStake(takenAt);
            if (stake.size === 0 && t.total > 0n) continue; // per-pool stake pruned (ledgerBoundaryPrune keeps 30 epochs), totals kept
            byEpoch.set(takenAt + 1, { total: t.total, stake });
        }
        for (const e of byEpoch.keys()) { const p = gr.epochParams(e)?.params; if (p && !d.has(e)) d.set(e, String(p.decentralisation_param ?? "0")); }
        st.close();
    }
    return { byEpoch, d };
}
const exactDirs = (opt("exact") ?? "").split(",").filter(Boolean), approxDirs = (opt("approx") ?? "").split(",").filter(Boolean);
const exact = distributions(exactDirs), approx = distributions(approxDirs);
console.log(`exact leader distributions for epochs ${[...exact.byEpoch.keys()].sort((a, b) => a - b).join(",") || "-"}; approximate for ${approx.byEpoch.size} epoch(s)`);
// where both hold a snapshot: how far the approximate one is from the exact one
const drift: Array<{ epoch: number; totalDiff: string; poolsDiffering: number; maxRel: number }> = [];
for (const [e, x] of exact.byEpoch) {
    const a = approx.byEpoch.get(e); if (!a) continue;
    let n = 0, maxRel = 0;
    for (const id of new Set([...x.stake.keys(), ...a.stake.keys()])) { const xs = x.stake.get(id) ?? 0n, as = a.stake.get(id) ?? 0n; if (xs !== as) { n++; if (xs > 0n) maxRel = Math.max(maxRel, Math.abs(Number(as - xs)) / Number(xs)); } }
    drift.push({ epoch: e, totalDiff: (a.total - x.total).toString(), poolsDiffering: n, maxRel });
}
if (drift.length) console.log(`approximate vs exact snapshots: ${JSON.stringify(drift)}`);

// ---- the chain
const imm = await ChunkStore.open(join(node, "db", "immutable"), { chunkSlots: network === "preview" ? 4320 : 21600, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const vol = await VolatileStore.open(join(node, "db", "volatile"), { readOnly: true });
const immTip = await imm.tip();
const tipHex = (() => { try { return readFileSync(join(node, "db", "gerolamo", "selected-tip.hex"), "utf8").trim(); } catch { return ""; } })();
const volChain: Array<{ slot: number; hash: Uint8Array; bytes: Uint8Array; headerOffset: number; headerSize: number }> = [];
{ let cur = tipHex ? vol.get(Uint8Array.from(Buffer.from(tipHex, "hex"))) : undefined; const seen = new Set<string>(); while (cur && !seen.has(toHex(cur.hash)) && (!immTip || cur.slot > immTip.slot)) { seen.add(toHex(cur.hash)); volChain.push(cur); cur = cur.prevHash ? vol.get(cur.prevHash) : undefined; } volChain.reverse(); }

async function* chain(): AsyncGenerator<{ slot: number; hash: Uint8Array; bytes: Uint8Array; headerOffset: number; headerSize: number }> {
    for await (const b of imm.iterate(fromSlot)) yield b;
    for (const b of volChain) yield b;
}
const arr = (c: Cbor | undefined): Cbor[] => { if (!c || c.t !== "a") throw new Error("expected array"); return c.v; };
const byt = (c: Cbor | undefined): Uint8Array => { if (!c || c.t !== "b") throw new Error("expected bytes"); return c.v; };
const num = (c: Cbor | undefined): number => { if (!c || c.t !== "u") throw new Error("expected uint"); return Number(c.v); };

const ocert = { headers: 0, tooSmall: 0, overIncremented: 0, mechanism: { agree: 0, disagree: 0, unknown: 0 }, examples: [] as string[] };
const sigma = { exact: { headers: 0, fail: 0, byEpoch: {} as Record<number, { headers: number; fail: number }>, examples: [] as string[] }, approx: { headers: 0, fail: 0, epochs: 0, byEpoch: {} as Record<number, { headers: number; fail: number }>, examples: [] as string[] } };
const counters = new Map<string, { counter: number; slot: number }>();          // the chain's, as of the parent of the current header
const applied = new Map<string, { counter: number; slot: number }>();           // as of the lagging "applied" block
const window: Array<{ hash: string; issuer: string; counter: number; slot: number }> = [];
let appliedHash: string | null = null;
const lagSource: CounterStateSource = { holds: (h) => h === appliedHash, counterAt: (_h, pool) => applied.get(pool) ?? null };
const checker = new LeaderChecker({}, genesis, { counters: lagSource, stateExact: () => ({ exact: true, why: "" }) });
const t0 = performance.now();
let n = 0, lastEpoch = -1;
for await (const b of chain()) {
    n++;
    const era = b.bytes[1]!;                          // 0x82 <era> …: eras 0–7 are one-byte uints
    if (era < 2) continue;
    const header = arr(decodeCbor(b.bytes, b.headerOffset).v);
    const hb = arr(header[0]);
    const praos = hb.length === 10;
    const slot = num(hb[1]), prev = hb[2]?.t === "b" ? toHex(hb[2].v) : null;
    const hash = toHex(b.hash);
    const issuer = toHex(blake2b_224(byt(hb[3])));
    const counter = praos ? num(arr(hb[8])[1]) : num(hb[10]);
    const epoch = Number(epochForSlot(slot));
    // ---- OCERT along the chain
    ocert.headers++;
    const last = counters.get(issuer) ?? null;
    const v = opcertCounterVerdict(era, last?.counter ?? null, counter);
    if (v.tooSmall || v.overIncremented) { if (v.tooSmall) ocert.tooSmall++; else ocert.overIncremented++; if (ocert.examples.length < 20) ocert.examples.push(`slot ${slot} ${issuer.slice(0, 12)} n ${counter} m ${v.m}`); }
    // ---- the node's mechanism: state of the lagging applied block + the validated headers since
    const asOf = checker.counterAsOf(prev, issuer);
    if (!asOf) ocert.mechanism.unknown++;
    else if ((asOf.state?.counter ?? null) === (last?.counter ?? null)) ocert.mechanism.agree++;
    else { ocert.mechanism.disagree++; if (ocert.examples.length < 20) ocert.examples.push(`mechanism slot ${slot} ${issuer.slice(0, 12)}: ${asOf.state?.counter} vs chain ${last?.counter}`); }
    checker.noteHeader(hash, prev, issuer, counter, slot);
    counters.set(issuer, { counter, slot });
    window.push({ hash, issuer, counter, slot });
    if (window.length > lag) { const a = window.shift()!; applied.set(a.issuer, { counter: a.counter, slot: a.slot }); appliedHash = a.hash; }
    // ---- σ
    let leaderValue: Uint8Array | null = null;
    for (const [kind, src] of [["exact", exact], ["approx", approx]] as const) {
        const dist = src.byEpoch.get(epoch);
        if (!dist || Number(src.d.get(epoch) ?? 0) !== 0) continue; // overlay epochs (d > 0) are not σ's
        leaderValue ??= praos ? blake2b_256(Uint8Array.from([0x4c, ...byt(arr(hb[5])[0])])) : byt(arr(hb[6])[0]);
        const stake = dist.stake.get(issuer) ?? 0n;
        const leads = dist.total > 0n && isSlotLeader(leaderValue, { num: stake, den: dist.total }, f);
        if (kind === "exact") {
            sigma.exact.headers++;
            const be = (sigma.exact.byEpoch[epoch] ??= { headers: 0, fail: 0 }); be.headers++;
            if (!leads) { sigma.exact.fail++; be.fail++; if (sigma.exact.examples.length < 20) sigma.exact.examples.push(`slot ${slot} ${issuer.slice(0, 12)} σ=${stake}/${dist.total}`); }
        } else {
            sigma.approx.headers++;
            const be = (sigma.approx.byEpoch[epoch] ??= { headers: 0, fail: 0 }); be.headers++;
            if (!leads) { sigma.approx.fail++; be.fail++; if (sigma.approx.examples.length < 20) sigma.approx.examples.push(`slot ${slot} epoch ${epoch} ${issuer.slice(0, 12)} σ=${stake}/${dist.total}`); }
        }
    }
    if (epoch !== lastEpoch) { lastEpoch = epoch; if (epoch % 100 === 0) console.log(`epoch ${epoch}: ${n} blocks, ${ocert.headers} headers, ${((performance.now() - t0) / 1000).toFixed(0)} s, σ exact ${sigma.exact.headers}/${sigma.exact.fail} fail, mechanism ${JSON.stringify(ocert.mechanism)}`); }
}
sigma.approx.epochs = approx.byEpoch.size;
const result = { node, lag, blocks: n, secs: Math.round((performance.now() - t0) / 1000), ocert, sigma, drift };
console.log(JSON.stringify(result, null, 2));
if (opt("out")) writeFileSync(opt("out")!, JSON.stringify(result, null, 2));
process.exit(ocert.tooSmall + ocert.overIncremented + ocert.mechanism.disagree + sigma.exact.fail ? 1 : 0);
