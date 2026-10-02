#!/usr/bin/env bun
/**
 * Offline replay of the Shelley+ body rules (rules/txRules.ts, rules/ledgerChecks.ts, the
 * block-level Conway checks) over an immutable chunk directory, read-only, with the UTxO,
 * pool, stake-deposit and DRep-delegation state rebuilt from genesis by this script. Every
 * failure a rule reports on a block the chain adopted is a false rejection.
 *
 *   bun scripts/utxo-rules-replay.ts --immutable <db/immutable> --params-db <node.db> \
 *       [--network preview] [--to-slot N] [--progress 200000] [--out result.json]
 *
 * Signatures are not re-verified (every witness counts as proven: `preVerified`), Plutus is
 * not evaluated, reward balances are not modelled (withdrawal amounts unchecked). The opcert
 * counter rule (Praos `m ≤ n ≤ m + 1`, m = 0 for a pool never seen) runs on every header.
 */
import { MultiEraBlock, TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { Database } from "bun:sqlite";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Cbor, CborMap, CborUInt } from "@harmoniclabs/cbor";
import { writeFileSync, readFileSync } from "node:fs";
import { ChunkStore } from "../src/storage/chunkStore";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import { evaluateShelleyBlockWithInputs, outputLike, shelleyBlockReads, drepDelegationEffect } from "../src/consensus/rules/blockRulesPure";
import { collectShelleyWitnesses } from "../src/consensus/rules/witnesses";
import { utxoRefOf, type ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";
import { bodyOutputBytes } from "../src/consensus/rules/scriptDataHash";
import { typedCredHexOf } from "../src/db/stakeCred";
import { rewardAccountKey, serializedValueSize, txRefScriptsSize } from "../src/consensus/rules/ledgerChecks";
import { unitsOf } from "../src/consensus/rules/value";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const immutable = opt("immutable")!;
const paramsDb = opt("params-db")!;
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const network = opt("network", "preview")!;
setEpochNetwork(network); // slot geometry for the rules and the Plutus script contexts
const toSlot = Number(opt("to-slot", String(Number.MAX_SAFE_INTEGER)));
/** Evaluate the rules only from this slot on (the state is still rebuilt from genesis). */
const checkFrom = Number(opt("check-from", "0"));
const progressEvery = Number(opt("progress", "200000"));
const outFile = opt("out");
/** Optional: write the replayed stake registrations, DRep delegations and pools here (to diff against a node's ledger store). */
const stateFile = opt("state-out");
if (!immutable || !paramsDb) { console.error("usage: --immutable <dir> --params-db <node.db> [--network preview]"); process.exit(2); }

const genesisDir = `${import.meta.dir}/../src/config/${network}`;
const shelleyGenesis = JSON.parse(readFileSync(`${genesisDir}/shelley-genesis.json`, "utf8"));
const epochLength = Number(shelleyGenesis.epochLength ?? 86400);
const config = { network: network === "mainnet" ? "mainnet" : "testnet", networkMagic: Number(shelleyGenesis.networkMagic) };

// ---- epoch parameters (read-only)
const pdb = new Database(paramsDb, { readonly: true });
const paramRows = new Map<number, Record<string, unknown>>();
for (const r of pdb.query("SELECT epoch, params FROM epoch_params").all() as Array<{ epoch: number; params: string }>) paramRows.set(Number(r.epoch), JSON.parse(r.params));
const genesisUtxo = pdb.query("SELECT utxo_ref, address, lovelace FROM genesis_utxo").all() as Array<{ utxo_ref: string; address: string; lovelace: string }>;
pdb.close();
const paramsCache = new Map<number, ReturnType<typeof epochParamsFromRecord> | null>();
function paramsFor(epoch: number) {
    if (!paramsCache.has(epoch)) paramsCache.set(epoch, paramRows.has(epoch) ? epochParamsFromRecord(epoch, paramRows.get(epoch)!) : null);
    return paramsCache.get(epoch)!;
}

// ---- ledger state rebuilt by the replay
/** Outputs are kept as latin1 strings of their original bytes: ~1 byte per byte, where a Uint8Array per entry cost ~2 KB of RSS (3.2 M preview UTxOs). */
type Stored = Uint8Array | { byron: ResolvedUtxo };
/**
 * The replayed UTxO set lives in a scratch SQLite file (`--utxo-db`, default beside `--out` or
 * in $TMPDIR): 3.2 M preview outputs held as JS values cost 5.7 GB of RSS (run of 2026-09-28,
 * stopped at slot 70.9 M). Writes are batched per block in one transaction.
 */
const utxoDbPath = opt("utxo-db", `${outFile ? outFile + "." : (process.env.TMPDIR ?? "/tmp") + "/utxo-rules-replay."}utxo.sqlite`);
try { require("node:fs").rmSync(utxoDbPath, { force: true }); require("node:fs").rmSync(utxoDbPath + "-wal", { force: true }); require("node:fs").rmSync(utxoDbPath + "-shm", { force: true }); } catch { /* */ }
const udb = new Database(utxoDbPath, { create: true });
udb.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -400000; PRAGMA temp_store = MEMORY; CREATE TABLE u (ref TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
const qGet = udb.prepare("SELECT bytes FROM u WHERE ref = ?"), qPut = udb.prepare("INSERT OR REPLACE INTO u (ref, bytes) VALUES (?, ?)"), qDel = udb.prepare("DELETE FROM u WHERE ref = ?"), qCount = udb.prepare("SELECT COUNT(*) c FROM u");
const genesisMap = new Map<string, Stored>();
/**
 * Write-back cache of the newest outputs (insertion order): most preview outputs are spent
 * within minutes, so they are created and deleted here without ever reaching SQLite. When
 * the cache overflows, the oldest half spills to the file in one transaction.
 */
const CACHE_CAP = Number(opt("cache", "400000"));
const cache = new Map<string, Uint8Array>();
const spill = udb.transaction((n: number) => { let i = 0; for (const [k, v] of cache) { if (i++ >= n) break; qPut.run(k, v); cache.delete(k); } });
const utxo = {
    get(ref: string): Stored | undefined { const c = cache.get(ref); if (c) return c; const g = genesisMap.get(ref); if (g) return g; const r = qGet.get(ref) as { bytes: Uint8Array } | null; return r ? new Uint8Array(r.bytes) : undefined; },
    set(ref: string, v: Stored): void { if (v instanceof Uint8Array) { cache.set(ref, v); if (cache.size > CACHE_CAP) spill(CACHE_CAP >> 1); } else genesisMap.set(ref, v); },
    delete(ref: string): void { if (cache.delete(ref) || genesisMap.delete(ref)) return; qDel.run(ref); },
    count(): number { return cache.size + genesisMap.size + Number((qCount.get() as any).c); },
};
const applyBlock = udb.transaction((f: () => void) => f());
for (const g of genesisUtxo) utxo.set(g.utxo_ref, { byron: { ref: g.utxo_ref, address: g.address, value: new Map([["lovelace", BigInt(g.lovelace)]]), referenceScriptHash: null, hasDatum: false } });
const pools = new Set<string>();
const poolRetiring = new Map<string, number>();
const stakeRegistered = new Set<string>();
const drepRegistered = new Set<string>(); // `${type}:${hash}`
const drepDeleg = new Map<string, string>(); // stake typed hex → `${type}:${hash}` (2/3: always abstain / no confidence)
const opcert = new Map<string, bigint>();

function decodeStored(ref: string, s: Stored): ResolvedUtxo {
    if (!(s instanceof Uint8Array)) return s.byron;
    const o = outputLike(TxOut.fromCbor(s));
    return { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null };
}

/** Original bytes of body key 16 (collateral return). */
function collateralReturnBytes(body: any): Uint8Array | null {
    try {
        const own = body.collateralReturn?.cborRef?.toBuffer?.();
        if (own) return own;
        const bb = body.cborRef?.toBuffer?.();
        if (!bb) return null;
        const root: any = Cbor.parse(bb, { keepRef: true } as any);
        if (!(root instanceof CborMap)) return null;
        for (const { k, v } of root.map) if (k instanceof CborUInt && Number(k.num) === 16) { const ref: any = (v as any).subCborRef ?? (v as any).cborRef; return ref?.toBuffer ? ref.toBuffer() : Cbor.encode(v).toBuffer(); }
    } catch { /* */ }
    try { return body.collateralReturn?.toCborBytes?.() ?? null; } catch { return null; }
}

const bytesOf = (x: any): Uint8Array | null => x instanceof Uint8Array ? x : x?.toBuffer?.() ?? x?.bytes ?? (typeof x?.toString === "function" && /^[0-9a-f]+$/i.test(String(x)) ? fromHex(String(x)) : null);
const drepId = (d: any): string | null => { const t = Number(d?.drepType ?? d?.type ?? -1); if (t === 2 || t === 3) return `${t}:`; if (t === 0 || t === 1) return `${t}:${String(d?.hash?.toString?.() ?? "").toLowerCase()}`; return null; };
const credDrepId = (c: any): string => `${Number(c?.type) === 1 || c?.type === "script" ? 1 : 0}:${String(c?.hash?.toString?.() ?? "").toLowerCase()}`;

// ---- accounting
const stats = {
    blocks: 0, txs: 0, invalidTxs: 0, byEra: {} as Record<string, { blocks: number; txs: number }>, firstSlot: null as number | null, lastSlot: 0,
    failures: {} as Record<string, number>, reports: {} as Record<string, number>, examples: {} as Record<string, string[]>, reportExamples: {} as Record<string, string[]>,
    coverage: { refScriptTxs: 0, refScriptBytesMax: 0, refScriptBlockBytesMax: 0, inputsAlsoReferenced: 0, withdrawalsPv10Key: 0, withdrawalsPv10Script: 0, auxData: 0, witnessDatums: 0, collateralReturns: 0, byronOutputs: 0, treasuryClaims: 0, voteRedeemers: 0, proposeRedeemers: 0, guardedProposals: 0, drepRegs: 0, unregCerts: 0, maxValueSize: 0, scriptWitnessTxs: 0 },
    opcert: { headers: 0, tooSmall: 0, overIncremented: 0, examples: [] as string[] },
};
const classify = (m: string) => m.replace(/^tx\[\d+\]: /, "").replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 110);
function note(kind: "failures" | "reports", msg: string, where: string) {
    const k = classify(msg);
    stats[kind][k] = (stats[kind][k] ?? 0) + 1;
    if (kind === "reports") { const ex = (stats.reportExamples[k] ??= []); if (ex.length < 3) ex.push(`${where} ${msg.slice(0, 200)}`); }
    if (kind === "failures") {
        const ex = (stats.examples[k] ??= []);
        if (ex.length < 5) ex.push(`${where} ${msg.slice(0, 300)}`);
        if (stats.failures[k]! <= 3) console.log(`FAILURE ${where}: ${msg.slice(0, 400)}`);
    }
}

const store = await ChunkStore.open(immutable, { chunkSlots: network === "mainnet" ? 21600 : 4320, readOnly: true, hashIndexPath: false });
const t0 = performance.now();
let lastEpoch = -1;
let prevMajor: number | null = null;

for await (const sb of store.iterate(0, toSlot)) {
    const block: any = MultiEraBlock.fromCbor(sb.bytes);
    const era = Number(block.era);
    const slot = sb.slot;
    const epoch = Math.floor(slot / epochLength);
    stats.blocks++;
    stats.firstSlot ??= slot;
    stats.lastSlot = slot;
    const eraKey = String(era);
    (stats.byEra[eraKey] ??= { blocks: 0, txs: 0 }).blocks++;
    if (era < 2) continue; // Byron: no Byron blocks on preview (genesis UTxO seeded above)

    const params = paramsFor(epoch);
    const major = params?.protocolMajor ?? null;
    if (epoch !== lastEpoch) {
        // POOLREAP at the boundary into `epoch`
        for (const [p, e] of poolRetiring) if (e <= epoch) { pools.delete(p); poolRetiring.delete(p); }
        // Conway HARDFORK into protocol 10: delegations to DReps that do not exist are dropped
        if (prevMajor != null && prevMajor < 10 && major != null && major >= 10) {
            for (const [k, d] of drepDeleg) if (!d.startsWith("2:") && !d.startsWith("3:") && !drepRegistered.has(d)) drepDeleg.delete(k);
        }
        prevMajor = major;
        lastEpoch = epoch;
    }

    // ---- header: opcert counter (Praos / TPraos OCERT: m ≤ n ≤ m + 1)
    const hb = block.block.header?.body;
    const issuer = bytesOf(hb?.issuerPubKey);
    if (issuer && hb?.opCert) {
        const pool = toHex(blake2b_224(issuer));
        const n = BigInt(hb.opCert.sequenceNumber);
        const m = opcert.get(pool) ?? 0n;
        stats.opcert.headers++;
        if (n < m) { stats.opcert.tooSmall++; if (stats.opcert.examples.length < 10) stats.opcert.examples.push(`slot ${slot} pool ${pool.slice(0, 12)} n ${n} < m ${m}`); }
        else if (n > m + 1n) { stats.opcert.overIncremented++; if (stats.opcert.examples.length < 10) stats.opcert.examples.push(`slot ${slot} pool ${pool.slice(0, 12)} n ${n} > m ${m} + 1`); }
        opcert.set(pool, n);
    }

    const bodies: any[] = block.block.transactionBodies ?? [];
    const wits: any[] = block.block.transactionWitnessSets ?? [];
    const invalid = new Set<number>(((block.block.invalidTransactions ?? []) as any[]).map(Number));
    stats.txs += bodies.length;
    stats.byEra[eraKey]!.txs += bodies.length;
    if (bodies.length === 0) continue;

    // ---- inputs for the block rules from the replayed state
    const { refs, poolIds, wdCreds } = shelleyBlockReads(block);
    const resolved = new Map<string, ResolvedUtxo>();
    for (const r of refs) { const s = utxo.get(r); if (s) resolved.set(r, decodeStored(r, s)); }
    const poolSet = new Set<string>(); for (const p of poolIds) if (pools.has(p)) poolSet.add(p);
    const drepDelegated = era >= 7 ? new Map<string, boolean>(wdCreds.filter((k) => k.length === 56).map((k) => [k, drepDeleg.has(k)])) : undefined;
    let witnessItems = 0;
    for (let i = 0; i < bodies.length; i++) {
        const bh = bodies[i].hash?.toString?.();
        witnessItems += collectShelleyWitnesses(bh ? fromHex(String(bh)) : blake2b_256(bodies[i].toCborBytes()), wits[i]).items.length;
    }

    // coverage counters (what the new rules actually saw)
    const cov = stats.coverage;
    let blockRs = 0;
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (invalid.has(i)) stats.invalidTxs++;
        if (era >= 7) {
            const rs = txRefScriptsSize(b, (r) => resolved.get(r));
            if (rs > 0) { cov.refScriptTxs++; cov.refScriptBytesMax = Math.max(cov.refScriptBytesMax, rs); blockRs += rs; }
            const spend = new Set(((b.inputs ?? []) as any[]).map(utxoRefOf));
            if (((b.refInputs ?? []) as any[]).some((r) => spend.has(utxoRefOf(r)))) cov.inputsAlsoReferenced++;
            if ((major ?? 0) >= 10) for (const w of (b.withdrawals?.map ?? []) as any[]) (rewardAccountKey(w.rewardAccount).length === 58 ? cov.withdrawalsPv10Script++ : cov.withdrawalsPv10Key++);
            if (b.currentTreasuryValue != null) cov.treasuryClaims++;
            for (const pp of (b.proposalProcedures ?? []) as any[]) if (pp?.govAction?.policyHash) cov.guardedProposals++;
        }
        if (block.block.auxiliaryDataSet?.[i]) cov.auxData++;
        if ((wits[i]?.datums?.length ?? 0) > 0) cov.witnessDatums++;
        if (b.collateralReturn) cov.collateralReturns++;
        for (const o of (b.outputs ?? []) as any[]) {
            cov.maxValueSize = Math.max(cov.maxValueSize, serializedValueSize(unitsOf(o.value)));
            if (String(o.address?.type ?? "").toLowerCase() === "byron" || o.address?.constructor?.name === "ByronAddress") cov.byronOutputs++;
        }
        const ws = wits[i] ?? {};
        if ((ws.nativeScripts?.length ?? 0) + (ws.plutusV1Scripts?.length ?? 0) + (ws.plutusV2Scripts?.length ?? 0) + (ws.plutusV3Scripts?.length ?? 0) > 0) cov.scriptWitnessTxs++;
        for (const r of (ws.redeemers ?? []) as any[]) { if (Number(r.tag) === 4) cov.voteRedeemers++; if (Number(r.tag) === 5) cov.proposeRedeemers++; }
    }
    cov.refScriptBlockBytesMax = Math.max(cov.refScriptBlockBytesMax, blockRs);

    const outcome = slot < checkFrom ? { failures: [] as string[], reports: [] as string[] } : await evaluateShelleyBlockWithInputs(block, {
        config, pool: null, params, genesis: shelleyGenesis, slot: BigInt(slot), phase: "rules", preVerified: new Array(witnessItems).fill(true),
    }, { resolved, pools: poolSet, rewardBalances: undefined, drepDelegated, stakeRegistered: new Map(wdCreds.map((k) => [k, stakeRegistered.has(k)])), treasury: null });
    const where = `slot ${slot} ${toHex(sb.hash).slice(0, 12)}`;
    for (const f of outcome.failures) note("failures", f, where);
    for (const r of outcome.reports) note("reports", r, where);

    // ---- apply the block to the replayed state
    applyBlock(() => { for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const txHash = String(b.hash?.toString?.() ?? "").toLowerCase();
        if (invalid.has(i)) {
            for (const c of (b.collateralInputs ?? []) as any[]) { const r = utxoRefOf(c); if (r) utxo.delete(r); }
            const rb = b.collateralReturn ? collateralReturnBytes(b) : null;
            if (rb) utxo.set(`${txHash}:${(b.outputs ?? []).length}`, rb);
            continue;
        }
        for (const inp of (b.inputs ?? []) as any[]) { const r = utxoRefOf(inp); if (r) utxo.delete(r); }
        const outs: any[] = b.outputs ?? [];
        let slices: Uint8Array[] | null | undefined;
        for (let k = 0; k < outs.length; k++) {
            let bytes: Uint8Array | null = null;
            try { bytes = outs[k].cborRef?.toBuffer?.() ?? null; } catch { bytes = null; }
            if (!bytes) { if (slices === undefined) slices = bodyOutputBytes(b.cborRef.toBuffer()); bytes = slices?.[k] ?? outs[k].toCborBytes(); }
            utxo.set(`${txHash}:${k}`, bytes!);
        }
        for (const c of (b.certs ?? []) as any[]) {
            const t = Number(c.certType);
            const key = c.stakeCredential ? typedCredHexOf(c.stakeCredential) : null;
            if ((t === 0 || t === 7 || t === 11 || t === 12 || t === 13) && key) stakeRegistered.add(key);
            if ((t === 1 || t === 8) && key) { stakeRegistered.delete(key); stats.coverage.unregCerts++; }
            if (t === 3) { const p = String(c.poolParams?.operator?.toString?.() ?? "").toLowerCase(); pools.add(p); poolRetiring.delete(p); }
            if (t === 4) { const p = String(c.poolHash?.toString?.() ?? c.poolKeyHash?.toString?.() ?? "").toLowerCase(); poolRetiring.set(p, Number(c.epoch)); }
            if (t === 16) { drepRegistered.add(credDrepId(c.drepCredential)); stats.coverage.drepRegs++; }
            if (t === 17) { const id = credDrepId(c.drepCredential); drepRegistered.delete(id); for (const [k, d] of drepDeleg) if (d === id) drepDeleg.delete(k); }
            const eff = drepDelegationEffect(c);
            if (eff) { if (eff.delegated) { const d = drepId(c.drep); if (d) drepDeleg.set(eff.key, d); } else drepDeleg.delete(eff.key); }
        }
    } });

    if (stats.blocks % 20000 === 0) {
        Bun.gc(stats.blocks % 200000 === 0);
        const rss = process.memoryUsage().rss;
        if (rss > 5.5e9) { console.error(`RSS ${(rss / 1e9).toFixed(2)} GB over the 5.5 GB budget at slot ${slot}; stopping`); break; }
    }
    if (stats.blocks % progressEvery === 0) {
        const s = (performance.now() - t0) / 1000;
        const fails = Object.values(stats.failures).reduce((a, b) => a + b, 0);
        console.log(`${stats.blocks} blocks, ${stats.txs} txs, slot ${slot} (epoch ${epoch}, pv ${major}), utxo ${utxo.count()}, ${fails} failure(s), ${s.toFixed(0)} s, rss ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`);
    }
}

Bun.gc(true);
const { heapSize, objectCount } = (await import("bun:jsc")).heapStats();
console.log(`heap after GC: ${(heapSize / 1e9).toFixed(2)} GB, ${objectCount} objects, rss ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`);
const secs = (performance.now() - t0) / 1000;
const result = { network, immutable, secs: Math.round(secs), utxoSize: utxo.count(), pools: pools.size, stakeRegistered: stakeRegistered.size, drepDelegations: drepDeleg.size, ...stats };
console.log(JSON.stringify(result, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2));
if (stateFile) writeFileSync(stateFile, JSON.stringify({ lastSlot: stats.lastSlot, stakeRegistered: [...stakeRegistered], drepDeleg: [...drepDeleg], pools: [...pools], opcert: [...opcert].map(([k, v]) => [k, Number(v)]) }));
