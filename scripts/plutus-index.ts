#!/usr/bin/env bun
/**
 * List every Plutus transaction (one with redeemers) of an immutable chunk directory, read-only,
 * without parsing blocks through the ledger library: one JSON line per transaction with its slot,
 * position, hash, is_valid flag and declared redeemer budgets. Feeds `scripts/plutus-replay.ts`.
 *
 *   bun scripts/plutus-index.ts <immutable dir> --out plutus-txs.jsonl [--k 432] [--from-chunk N] [--to-chunk N]
 */
import { ChunkStore } from "../src/storage/chunkStore";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { scanBlock, witnessRedeemers } from "./lib/cborWalk";
import { createWriteStream } from "node:fs";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
if (!dir || !opt("out")) { console.error("usage: plutus-index.ts <immutable dir> --out <file.jsonl> [--k 432] [--from-chunk N] [--to-chunk N]"); process.exit(2); }
const k = Number(opt("k") ?? 432);
const store = await ChunkStore.open(dir, { chunkSlots: 10 * k, cacheChunks: 4, readOnly: true, hashIndexPath: false });
const chunks = store.chunks();
const from = Number(opt("from-chunk") ?? chunks[0]), to = Number(opt("to-chunk") ?? chunks[chunks.length - 1]);
const out = createWriteStream(opt("out")!);
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
let blocks = 0, txs = 0, plutusTxs = 0, invalidTxs = 0, redeemers = 0, errors = 0;
const t0 = performance.now();
for await (const blk of store.iterate(from * 10 * k, (to + 1) * 10 * k - 1)) {
    blocks++;
    let s;
    try { s = scanBlock(blk.bytes); } catch (e) { errors++; if (errors < 10) console.error(`slot ${blk.slot}: ${(e as Error).message}`); continue; }
    if (!s || s.era < 5) continue;
    txs += s.bodies.length;
    for (let i = 0; i < s.witnessStarts.length; i++) {
        let rs;
        try { rs = witnessRedeemers(blk.bytes, s.witnessStarts[i]!); } catch (e) { errors++; if (errors < 10) console.error(`slot ${blk.slot} tx ${i}: ${(e as Error).message}`); continue; }
        if (rs.length === 0) continue;
        const [a, b] = s.bodies[i]!;
        const valid = !s.invalid.has(i);
        plutusTxs++; redeemers += rs.length; if (!valid) invalidTxs++;
        out.write(JSON.stringify({ slot: blk.slot, i, tx: hex(blake2b_256(blk.bytes.subarray(a, b))), era: s.era, valid, r: rs.map((r) => [r.tag, r.index, r.mem, r.cpu]) }) + "\n");
    }
    if (blocks % 100000 === 0) console.log(`chunk ${blk.chunkNo} slot ${blk.slot}: ${blocks} blocks, ${plutusTxs} plutus txs (${invalidTxs} invalid), ${redeemers} redeemers, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
out.end();
console.log(`done: ${blocks} blocks, ${txs} Alonzo+ txs, ${plutusTxs} plutus txs (${invalidTxs} is_valid=false), ${redeemers} redeemers, ${errors} scan errors, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
