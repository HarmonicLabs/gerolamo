/**
 * Verify a cardano-node immutable directory with Gerolamo's ChunkStore reader: index shape, CRC-32 of
 * every block, header location and slot mapping for every chunk (docs/PLAN_CHUNK_STORE.md phase 1).
 *
 *   bun scripts/chunk-store-check.ts <immutable dir> [--k 432] [--from N] [--to N]
 */
import { ChunkStore } from "../src/storage/chunkStore";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: bun scripts/chunk-store-check.ts <immutable dir> [--k 432] [--from N] [--to N]"); process.exit(2); }
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const k = Number(opt("k") ?? 432);
const store = await ChunkStore.open(dir, { chunkSlots: 10 * k, cacheChunks: 8, readOnly: true });
const all = store.chunks();
const from = Number(opt("from") ?? all[0] ?? 0), to = Number(opt("to") ?? all[all.length - 1] ?? 0);
const todo = all.filter((n) => n >= from && n <= to);
console.log(`${dir}: ${all.length} chunks (${all[0]}…${all[all.length - 1]}), checking ${todo.length}, chunkSlots=${10 * k}`);
const t0 = performance.now();
let blocks = 0, bytes = 0, bad = 0;
for (let i = 0; i < todo.length; i++) {
    const n = todo[i]!;
    const r = await store.verifyChunk(n);
    blocks += r.blocks; bytes += r.bytes;
    if (r.errors.length) { bad++; for (const e of r.errors.slice(0, 5)) console.log("  " + e); }
    if ((i + 1) % 2000 === 0 || i === todo.length - 1) {
        const s = (performance.now() - t0) / 1000;
        console.log(`  ${i + 1}/${todo.length} chunks, ${blocks} blocks, ${(bytes / 1e9).toFixed(2)} GB, ${s.toFixed(0)} s, ${bad} bad chunk(s)`);
    }
}
const tip = await store.tip();
console.log(`tip: slot ${tip?.slot} hash ${tip ? Buffer.from(tip.hash).toString("hex").slice(0, 16) : "-"} chunk ${tip?.chunkNo}`);
console.log(bad ? `FAIL: ${bad} chunk(s) with errors` : `OK: ${todo.length} chunks, ${blocks} blocks consistent`);
process.exit(bad ? 1 : 0);
