/**
 * Length and SHA-256 of a node's raw LocalStateQuery answer, for comparing huge answers (GetUTxOWhole, the debug
 * dumps) across machines without moving them: run it beside each node and compare the hashes.
 *
 *   bun scripts/lsq-answer-hash.ts --socket <node.socket> [--magic 2] [--era 6] [--query 7] [--point slot:hash]
 *
 * `--query` is the BlockQuery tag (7 GetUTxOWhole, 8 DebugEpochState, 12 DebugNewEpochState). With `--point` the
 * state is acquired at that block, so two nodes answer for the same chain state; otherwise each at its own tip
 * (the acquired point is printed).
 */
import { createHash } from "node:crypto";
import { CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";
import { openLsq } from "./lib/lsq";
import { A, U, ledger } from "./lib/n2cCompare";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const sock = arg("socket"); if (!sock) { console.error("usage: lsq-answer-hash.ts --socket <path> [--magic 2] [--era 6] [--query 7] [--point slot:hash]"); process.exit(2); }
const magic = Number(arg("magic", "2")), era = Number(arg("era", "6")), tag = Number(arg("query", "7"));
const c = await openLsq(sock, magic, { acquire: false, timeoutMs: 600_000 });
try {
    const point = arg("point");
    if (point) { const [s, h] = point.split(":"); const r = await c.acquire({ slot: BigInt(s!), hash: h! }); if (!r.ok) throw new Error(`acquire ${point}: ${r.failure}`); }
    else await c.acquire("tip");
    const tip = (await c.query(A([U(3)]))) as CborArray;
    const at = `${(tip.array[0] as CborUInt).num}:${Buffer.from((tip.array[1] as CborBytes).bytes).toString("hex")}`;
    const t0 = performance.now();
    const raw = await c.queryRaw(ledger([U(tag)], era));
    console.log(`query ${tag} at ${at}: ${raw.length} bytes sha256 ${createHash("sha256").update(raw).digest("hex")} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
} finally { c.close(); }
