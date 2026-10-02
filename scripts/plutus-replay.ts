#!/usr/bin/env bun
/**
 * Replay Plutus phase 2 over an immutable chunk directory, read-only: every transaction with
 * redeemers in the chosen chunk range is evaluated with its inputs resolved from the chain
 * itself, and the verdict is compared with the block's is_valid flag.
 *
 *   bun scripts/plutus-replay.ts <immutable dir> --params <db with epoch_params> [--network preview]
 *       [--from-chunk N] [--to-chunk N] [--workers 6] [--out results.jsonl] [--slot S] [--dump-dir D]
 *
 * Two sequential passes, no random reads and no ledger database:
 *  A. (range only) the refs every Plutus transaction reads: inputs, collateral, reference inputs;
 *  B. (chunk 0 … range end) every transaction's outputs whose ref is needed are kept (raw bytes)
 *     until spent; a Plutus transaction in range is resolved from them and evaluated.
 * `--params` is a SQLite file with the node's `epoch_params` table (copy it off a live node:
 * `sqlite3 'file:preview.db?mode=ro' '.mode insert epoch_params' 'select * from epoch_params'`).
 * `--dump-dir` writes each evaluated transaction as a JSON fixture (`<slot>-<i>.json`);
 * `--jobs-out f.jsonl` writes every job (one per line) and `--jobs-in f.jsonl` re-evaluates such a
 * file without scanning the chain (quick iteration on a range).
 */
import { Database } from "bun:sqlite";
import { ChunkStore } from "../src/storage/chunkStore";
import { items, scanBlock, skip, uint, witnessRedeemers } from "./lib/cborWalk";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { setEpochNetwork, epochForSlot } from "../src/utils/epochFromSlotCalculations";
import { runReplayJob, type ReplayJob, type ReplayResult } from "./lib/plutusReplayJob";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv[0];
if (!dir || dir.startsWith("--") || !opt("params")) { console.error("usage: plutus-replay.ts <immutable dir> --params <db> [--network preview] [--from-chunk N] [--to-chunk N] [--workers N] [--out f.jsonl] [--slot S]"); process.exit(2); }
const network = opt("network") ?? "preview";
setEpochNetwork(network);
const k = Number(opt("k") ?? (network === "mainnet" ? 2160 : 432));
const chunkSlots = 10 * k;
const store = await ChunkStore.open(dir, { chunkSlots, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const chunks = store.chunks();
const onlySlot = opt("slot") != null ? Number(opt("slot")) : null;
const fromChunk = onlySlot != null ? Math.floor(onlySlot / chunkSlots) : Number(opt("from-chunk") ?? chunks[0]);
const toChunk = onlySlot != null ? fromChunk : Number(opt("to-chunk") ?? chunks[chunks.length - 1]);
const workersN = Number(opt("workers") ?? 0);
const dumpDir = opt("dump-dir");
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
const out = opt("out") ? createWriteStream(opt("out")!) : null;
const jobsOut = opt("jobs-out") ? createWriteStream(opt("jobs-out")!) : null;
const jobsIn = opt("jobs-in");
/** `--only file`: evaluate just the listed transactions (lines `<slot> <index>`, e.g. the mismatches of a previous run). */
const only: Set<string> | null = opt("only") ? new Set((await Bun.file(opt("only")!).text()).split("\n").map((l) => l.trim().split(/\s+/).join(":")).filter(Boolean)) : null;
const paramsDb = new Database(opt("params")!, { readonly: true });
const paramsCache = new Map<number, any>();
const paramsFor = (epoch: number) => {
    if (!paramsCache.has(epoch)) {
        const row = paramsDb.query("SELECT params FROM epoch_params WHERE epoch = ?").get(epoch) as any;
        paramsCache.set(epoch, row ? JSON.parse(row.params) : null);
    }
    return paramsCache.get(epoch);
};
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const txHashOf = (b: Uint8Array) => new Bun.CryptoHasher("blake2b256").update(b).digest("hex");
const rangeFrom = fromChunk * chunkSlots, rangeTo = (toChunk + 1) * chunkSlots - 1;

/** Map key of a body field (0 inputs, 1 outputs, 13 collateral, 16 collateral return, 18 reference inputs). */
function bodyFields(b: Uint8Array, s: number): Map<number, number> {
    const m = items(b, s).starts, f = new Map<number, number>();
    for (let i = 0; i < m.length; i += 2) f.set(uint(b, m[i]!), m[i + 1]!);
    return f;
}
function refsAt(b: Uint8Array, p: number | undefined): string[] {
    if (p == null) return [];
    return items(b, p).starts.map((s) => { const e = items(b, s).starts; const [a, z] = [e[0]!, skip(b, e[0]!)]; return `${hex(b.subarray(a + (z - a - 32), z))}:${uint(b, e[1]!)}`; });
}

// ── pass A: needed refs ── (skipped with --jobs-in)
const t0 = performance.now();
// numeric keys (48 bits of the tx id mixed with the index): a Set of strings for every ref the
// chain's Plutus transactions read took > 5 GB; a collision only keeps one extra output alive
// (sharded: a JS Set holds at most 2^24 entries)
const shards = Array.from({ length: 8 }, () => new Set<number>());
const needed = { add: (k: number) => shards[k % 8]!.add(k), has: (k: number) => shards[k % 8]!.has(k), get size() { return shards.reduce((s, x) => s + x.size, 0); } };
const refKey = (r: string) => { const h = parseInt(r.slice(0, 12), 16); return (h + Number(r.slice(r.indexOf(":") + 1)) * 2654435761) % 9007199254740991; };
let plutusTxs = 0;
for await (const blk of store.iterate(rangeFrom, jobsIn ? -1 : rangeTo)) {
    if (onlySlot != null && blk.slot !== onlySlot) continue;
    const s = scanBlock(blk.bytes);
    if (!s || s.era < 5) continue;
    for (let i = 0; i < s.witnessStarts.length; i++) {
        if (witnessRedeemers(blk.bytes, s.witnessStarts[i]!).length === 0) continue;
        if (only && !only.has(`${blk.slot}:${i}`)) continue;
        plutusTxs++;
        const f = bodyFields(blk.bytes, s.bodies[i]![0]);
        for (const key of [0, 13, 18]) for (const r of refsAt(blk.bytes, f.get(key))) needed.add(refKey(r));
    }
}
console.log(`pass A: ${plutusTxs} plutus txs in chunks ${fromChunk}…${toChunk}, ${needed.size} refs needed, ${((performance.now() - t0) / 1000).toFixed(0)} s`);

// ── workers ──
type Pending = { resolve: (r: ReplayResult) => void };
const pool: Worker[] = [];
const idle: Worker[] = [];
const queue: Array<{ job: ReplayJob; p: Pending }> = [];
const inflight = new Map<Worker, Pending>();
for (let w = 0; w < workersN; w++) {
    const wk = new Worker(new URL("./lib/plutusReplayWorker.ts", import.meta.url).href);
    wk.onmessage = (ev) => { const p = inflight.get(wk)!; inflight.delete(wk); p.resolve(ev.data as ReplayResult); pump(wk); };
    pool.push(wk); idle.push(wk);
}
function pump(wk: Worker) {
    const next = queue.shift();
    if (!next) { idle.push(wk); return; }
    inflight.set(wk, next.p);
    wk.postMessage(next.job);
}
function submit(job: ReplayJob): Promise<ReplayResult> {
    if (workersN === 0) return runReplayJob(job);
    return new Promise((resolve) => {
        const p = { resolve };
        const wk = idle.pop();
        if (wk) { inflight.set(wk, p); wk.postMessage(job); } else queue.push({ job, p });
    });
}

// ── pass B ──
const live = new Map<string, Uint8Array>();
const stats = { exact: 0, evaluated: 0, txs: 0, validOk: 0, invalidOk: 0, validFailed: 0, invalidPassed: 0, overDeclared: 0, notEvaluated: 0, unresolved: 0, redeemers: 0, ms: 0, maxMs: 0 };
const reasons = new Map<string, number>();
const slowest: Array<{ slot: number; i: number; ms: number; cpu: number }> = [];
let outstanding: Promise<void>[] = [];
const t1 = performance.now();
let blocks = 0;
function record(job: ReplayJob, r: ReplayResult) {
    stats.txs++;
    stats.redeemers += r.redeemers;
    stats.exact += r.exact ?? 0;
    stats.ms += r.ms; stats.maxMs = Math.max(stats.maxMs, r.ms);
    if (r.ms > 200) { slowest.push({ slot: job.slot, i: job.i, ms: r.ms, cpu: r.declaredCpu }); slowest.sort((a, b) => b.ms - a.ms); slowest.length = Math.min(slowest.length, 25); }
    let cls: string;
    if (r.error) { stats.notEvaluated++; cls = "error"; const key = r.error.replace(/[0-9a-f]{12,}…?/g, "X").replace(/\d+/g, "N").slice(0, 90); reasons.set(key, (reasons.get(key) ?? 0) + 1); }
    else {
        stats.evaluated++;
        if (r.overDeclared) stats.overDeclared++;
        if (job.valid && r.ok) { stats.validOk++; cls = "ok"; }
        else if (!job.valid && !r.ok) { stats.invalidOk++; cls = "ok"; }
        else if (job.valid) { stats.validFailed++; cls = "valid-failed"; }
        else { stats.invalidPassed++; cls = "invalid-passed"; }
    }
    if (cls !== "ok") console.log(`MISMATCH ${cls} slot ${job.slot} tx ${job.i} ${job.txHash}: ${r.error ?? r.detail ?? ""}`);
    out?.write(JSON.stringify({ slot: job.slot, i: job.i, tx: job.txHash, valid: job.valid, cls, ok: r.ok, ms: Math.round(r.ms * 10) / 10, n: r.redeemers, exact: r.exact, cpu: r.spentCpu, dcpu: r.declaredCpu, l: r.langs, err: r.error ?? undefined, detail: cls !== "ok" ? r.detail : undefined }) + "\n");
}
const progress = () => console.log(`slot ${lastSlot}: ${stats.txs}/${plutusTxs} txs, ${stats.redeemers} redeemers | valid ok ${stats.validOk}, invalid ok ${stats.invalidOk}, valid-failed ${stats.validFailed}, invalid-passed ${stats.invalidPassed}, not evaluated ${stats.notEvaluated} (unresolved ${stats.unresolved}), over-declared ${stats.overDeclared}, redeemers spending exactly the declared units ${stats.exact} | eval ${(stats.ms / 1000).toFixed(0)} s (max ${stats.maxMs.toFixed(0)} ms), wall ${((performance.now() - t1) / 1000).toFixed(0)} s, live ${live.size}`);
let lastSlot = 0;
let lastProgress = performance.now();
if (jobsIn) {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    for await (const line of createInterface({ input: createReadStream(jobsIn) })) {
        if (!line) continue;
        const job = JSON.parse(line) as ReplayJob;
        lastSlot = job.slot;
        outstanding.push(submit(job).then((r) => record(job, r)));
        if (outstanding.length >= Math.max(64, workersN * 16)) { await Promise.all(outstanding); outstanding = []; }
        if (performance.now() - lastProgress > 30000) { lastProgress = performance.now(); progress(); }
    }
}
for await (const blk of store.iterate(0, jobsIn ? -1 : rangeTo)) {
    blocks++;
    lastSlot = blk.slot;
    const b = blk.bytes;
    const s = scanBlock(b);
    if (!s) continue;
    const inRange = blk.slot >= rangeFrom && (onlySlot == null || blk.slot === onlySlot);
    for (let i = 0; i < s.bodies.length; i++) {
        const [a, z] = s.bodies[i]!;
        const txHash = txHashOf(b.subarray(a, z));
        const f = bodyFields(b, a);
        const valid = !s.invalid.has(i);
        if (inRange && s.era >= 5) {
            const rs = only && !only.has(`${blk.slot}:${i}`) ? [] : witnessRedeemers(b, s.witnessStarts[i]!);
            if (rs.length) {
                const refs = new Set([0, 13, 18].flatMap((key) => refsAt(b, f.get(key))));
                const resolved: Array<[string, string]> = [];
                let missing = false;
                for (const r of refs) { const o = live.get(r); if (!o) { missing = true; break; } resolved.push([r, hex(o)]); }
                if (missing) { stats.unresolved++; record({ slot: blk.slot, i, txHash, valid } as any, { ok: false, redeemers: rs.length, ms: 0, declaredCpu: 0, error: "unresolved input" }); }
                else {
                    const wsStart = s.witnessStarts[i]!;
                    const job: ReplayJob = {
                        slot: blk.slot, i, txHash, valid, era: s.era,
                        bodyHex: hex(b.subarray(a, z)), witnessHex: hex(b.subarray(wsStart, skip(b, wsStart))),
                        resolved, params: paramsFor(Number(epochForSlot(blk.slot))), network,
                    };
                    if (dumpDir) writeFileSync(`${dumpDir}/${blk.slot}-${i}.json`, JSON.stringify(job));
                    if (jobsOut) jobsOut.write(JSON.stringify(job) + "\n");
                    outstanding.push(submit(job).then((r) => record(job, r)));
                    if (outstanding.length >= Math.max(64, workersN * 16)) { await Promise.all(outstanding); outstanding = []; }
                }
            }
        }
        // spend, then produce (only the refs some Plutus transaction in range reads)
        if (valid) for (const r of refsAt(b, f.get(0))) live.delete(r);
        else for (const r of refsAt(b, f.get(13))) live.delete(r);
        const outsP = f.get(1);
        const outs = outsP != null ? items(b, outsP).starts : [];
        if (valid) outs.forEach((p, j) => { const r = `${txHash}:${j}`; if (needed.has(refKey(r))) live.set(r, b.slice(p, skip(b, p))); });
        else if (f.get(16) != null) { const r = `${txHash}:${outs.length}`; const p = f.get(16)!; if (needed.has(refKey(r))) live.set(r, b.slice(p, skip(b, p))); }
    }
    if (performance.now() - lastProgress > 30000) { lastProgress = performance.now(); progress(); }
}
await Promise.all(outstanding);
progress();
console.log("not-evaluated reasons:", Object.fromEntries([...reasons].sort((x, y) => y[1] - x[1]).slice(0, 20)));
console.log("slowest:", slowest.slice(0, 15));
out?.end();
jobsOut?.end();
for (const w of pool) w.terminate();
process.exit(0);
