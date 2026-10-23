/**
 * Byte-compare Gerolamo's node-to-client LocalStateQuery answers with a cardano-node's, for every
 * Conway BlockQuery cardano-node 11 serves (ouroboros-consensus-cardano 3.0.1), the hard-fork and
 * top-level queries, and the acquire failures.
 *
 * Both sides acquire the same block: ours acquires its volatile tip (or --point slot:hash) and the
 * reference acquires that point, so the answers are of one ledger state; when the reference cannot
 * acquire it (its tip is behind, or it forked), both use their own tips and live answers are
 * retried. Arguments are real: our pool, and DReps, committee members, stake credentials and
 * governance actions picked from the reference's own answers.
 *   bun scripts/n2c-compare.ts --ours <node.socket> --ref <node.socket> [--magic 2] [--era 6]
 *       [--pools id,id] [--point slot:hash] [--only name,name] [--no-extra] [--huge] [--save <dir>]
 * Debug dumps (DebugEpochState, DebugNewEpochState, GetUTxOWhole: hundreds of MB on preview) run
 * only with --huge; the reward queries and DebugLedgerConfig (lib/n2cCompare.ts EXTRA_QUERY_NAMES)
 * unless --no-extra. `--save <dir>` writes both sides of every differing answer (`<name>.ours.cbor`,
 * `.ref.cbor`) for scripts/cbor-diff.ts. The query set and the comparison live in lib/n2cCompare.ts
 * (shared with scripts/parity-probe.ts, the watchdog's periodic check).
 */
import { CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";
import { mkdirSync, writeFileSync } from "node:fs";
import { openLsq, type LsqClient } from "./lib/lsq";
import { A, U, DEFAULT_POOL, ledger as ledgerQ, acquirePoint, acquireShared, buildQuerySet, compareQueries, formatResult } from "./lib/n2cCompare";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const magic = Number(arg("magic", "2")), era = Number(arg("era", "6"));
const only = arg("only")?.split(",");
const pools = (arg("pools", DEFAULT_POOL)!).split(",");
const ledger = (q: Parameters<typeof ledgerQ>[0], e = era) => ledgerQ(q, e);

// a dropped connection can reject a waiter nobody awaits any more (a timed-out query, an abandoned client): log, go on
process.on("unhandledRejection", (e) => { console.log(`note: unhandled rejection ignored: ${(e as Error)?.message ?? e}`); });
process.on("uncaughtException", (e) => { console.log(`note: uncaught exception ignored: ${(e as Error)?.message ?? e}`); });
let ours = await openLsq(arg("ours")!, magic, { acquire: false, timeoutMs: 600_000 });
let ref = await openLsq(arg("ref")!, magic, { acquire: false, timeoutMs: 600_000 });
let sharedPt: { slot: bigint; hash: string } | null = null;
console.log(`negotiated N2C versions: ours ${ours.version}, ref ${ref.version}`);

// ---------------------------------------------------------------- one ledger state on both sides
const point = arg("point");
let shared = false;
if (point) {
    const [slot, hash] = point.split(":");
    const r = await acquirePoint(ours, ref, BigInt(slot!), hash!);
    console.log(r.note);
    shared = r.ok;
    if (!shared) process.exit(1);
    sharedPt = { slot: BigInt(slot!), hash: hash! };
} else {
    const r = await acquireShared(ours, ref);
    shared = r.shared;
    console.log(r.note);
    if (r.shared && r.slot != null && r.hash) sharedPt = { slot: r.slot, hash: r.hash };
}
// a side that closes its connection on a query it does not support (Dingo) gets a fresh connection at the same point
const reopen = async (side: "ours" | "ref"): Promise<LsqClient> => {
    const c = await openLsq(side === "ours" ? arg("ours")! : arg("ref")!, magic, { acquire: false, timeoutMs: 60_000 });
    let r = sharedPt ? await c.acquire({ slot: sharedPt.slot, hash: sharedPt.hash }) : await c.acquire("tip");
    if (!r.ok && sharedPt) {
        // the point aged out on this side (Dingo keeps only a short window): share a new one, the tip of this side
        r = await c.acquire("tip");
        if (!r.ok) throw new Error(`reopen ${side}: acquire failed: ${r.failure}`);
        const t = (await c.query(A([U(3)]))) as CborArray;
        const pt = { slot: BigInt((t.array[0] as CborUInt).num), hash: Buffer.from((t.array[1] as CborBytes).bytes).toString("hex") };
        const other = side === "ours" ? ref : ours;
        const o = await other.acquire({ slot: pt.slot, hash: pt.hash });
        if (o.ok) { sharedPt = pt; console.log(`note: re-shared at ${pt.slot}:${pt.hash.slice(0, 16)}… after the reference closed the connection`); }
        else { sharedPt = null; shared = false; console.log(`note: no shared point any more (${o.failure}); live answers are retried`); }
    } else if (!r.ok) throw new Error(`reopen ${side}: acquire failed: ${r.failure}`);
    if (side === "ours") ours = c; else ref = c;
    return c;
};

// ---------------------------------------------------------------- real arguments from the reference
const queries = (await buildQuerySet(ref, { era, pools, huge: flag("huge"), extra: !flag("no-extra"), reopenRef: () => reopen("ref") })).filter(([name]) => !only || only.some((o) => name.includes(o)));
const saveDir = arg("save");
const onDiff = saveDir ? (name: string, a: Uint8Array, b: Uint8Array) => { mkdirSync(saveDir, { recursive: true }); const slug = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""); writeFileSync(`${saveDir}/${slug}.ours.cbor`, a); writeFileSync(`${saveDir}/${slug}.ref.cbor`, b); } : undefined;
const results = await compareQueries(ours, ref, queries, { shared, onResult: (r) => console.log(formatResult(r)), onDiff, reopen });
const diffs = results.filter((r) => !r.same && !r.err).map((r) => r.name);
const unsupported = results.filter((r) => r.err).map((r) => r.name);
console.log(`${results.filter((r) => r.same).length} of ${results.length} byte-identical${diffs.length ? `; different: ${diffs.join(", ")}` : ""}${unsupported.length ? `; not answered by one side: ${unsupported.join(", ")}` : ""}`);

// ---------------------------------------------------------------- behaviour on bad input (fresh connections)
if (!only || flag("probes")) {
    const probe = async (label: string, run: (c: LsqClient) => Promise<string>) => {
        const out: string[] = [];
        for (const sock of [arg("ours")!, arg("ref")!]) {
            const c = await openLsq(sock, magic, { acquire: false, timeoutMs: 30_000 });
            try { out.push(await run(c)); } catch (e) { out.push(c.isClosed() ? "connection closed" : (e as Error).message); }
            c.close();
        }
        console.log(`${out[0] === out[1] ? "SAME " : "DIFF "} ${label.padEnd(44)} ours: ${out[0]}; ref: ${out[1]}`);
    };
    const tipSlot = BigInt((((await ours.query(A([U(3)]))) as CborArray).array[0] as CborUInt).num);
    await probe("acquire an unknown block below the immutable tip", async (c) => { const r = await c.acquire({ slot: 123_000_000, hash: "00".repeat(32) }); return r.ok ? "acquired" : r.failure; });
    await probe("acquire an unknown block in the volatile window", async (c) => { const r = await c.acquire({ slot: tipSlot - 60n, hash: "00".repeat(32) }); return r.ok ? "acquired" : r.failure; });
    await probe("acquire origin", async (c) => { const r = await c.acquire("origin"); return r.ok ? "acquired" : r.failure; });
    await probe("unknown BlockQuery tag 40", async (c) => { await c.acquire("tip"); return Buffer.from(await c.queryRaw(ledger([U(40)]))).toString("hex"); });
    await probe("GetConstitution in Babbage (Conway-only)", async (c) => { await c.acquire("tip"); return Buffer.from(await c.queryRaw(ledger([U(23)], 5))).toString("hex"); });
    await probe("GetStakePools with an argument", async (c) => { await c.acquire("tip"); return Buffer.from(await c.queryRaw(ledger([U(16), U(1)]))).toString("hex"); });
    await probe("acquire the immutable tip", async (c) => { const r = await c.acquire("immutable"); return r.ok ? "acquired" : r.failure; });
}
ours.close(); ref.close(); process.exit(0);
