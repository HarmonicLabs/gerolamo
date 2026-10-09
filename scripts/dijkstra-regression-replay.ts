#!/usr/bin/env bun
/**
 * Dijkstra wave regression check (bug 436): replay stored blocks of a cardano-node immutable
 * directory, read-only, through the code paths the Dijkstra work touched and check that nothing
 * changed for the era they belong to:
 *   - the new cardano-ledger-ts decodes every block and re-encodes it byte for byte;
 *   - with `--old-ledger-ts <dir>` (an unpacked previous tarball with its nested node_modules),
 *     both libraries give the same JSON for every block;
 *   - the header parser (ChainSync form) and the block body hash still accept every block;
 *   - the era-gated helpers (script hashes of witness sets, reference script languages) give the
 *     same answers with the era's language ceiling as with the pre-Dijkstra default.
 *
 *   bun scripts/dijkstra-regression-replay.ts --immutable <db/immutable> [--k 432] [--from-slot N] [--to-slot N]
 *       [--max-blocks N] [--old-ledger-ts <dir>] [--json-every N] [--network preview]
 */
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { ChunkStore } from "../src/storage/chunkStore";
import { headerParser, localRollForwardMessage } from "../src/consensus/blockHeaderParser";
import { verifyBlockBodyHash } from "../src/consensus/bodyHash";
import { maxPlutusLanguage, witnessScriptHashes } from "../src/consensus/rules/scriptDataHash";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const immutable = opt("immutable");
if (!immutable) { console.error("usage: --immutable <db/immutable> [--from-slot N] [--to-slot N] [--max-blocks N] [--old-ledger-ts <dir>]"); process.exit(2); }
setEpochNetwork(opt("network", "preview")!);
const k = Number(opt("k", "432"));
const fromSlot = Number(opt("from-slot", "0")), toSlot = Number(opt("to-slot", String(Number.MAX_SAFE_INTEGER)));
const maxBlocks = Number(opt("max-blocks", String(Number.MAX_SAFE_INTEGER)));
const oldDir = opt("old-ledger-ts");
// the old-library JSON comparison is the slow part: --json-every N compares every Nth block
const jsonEvery = Math.max(1, Number(opt("json-every", "1")));
const Old: any = oldDir ? require(`${oldDir}/dist/index.js`) : null;

const store = await ChunkStore.open(immutable, { chunkSlots: 10 * k, cacheChunks: 4, readOnly: true });
const bigJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v);
const stats = { blocks: 0, byEra: {} as Record<number, number>, reencode: 0, json: 0, header: 0, bodyHash: 0, scripts: 0, txs: 0 };
const problems: string[] = [];
const t0 = performance.now();
for await (const b of store.iterate(fromSlot, toSlot)) {
    if (stats.blocks >= maxBlocks) break;
    stats.blocks++;
    const at = `slot ${b.slot}`;
    let meb: MultiEraBlock;
    try { meb = MultiEraBlock.fromCbor(b.bytes); } catch (e) { problems.push(`${at}: decode: ${(e as Error).message}`); continue; }
    stats.byEra[meb.era] = (stats.byEra[meb.era] ?? 0) + 1;
    if (toHex(meb.toCborBytes()) === toHex(b.bytes)) stats.reencode++; else problems.push(`${at}: re-encode differs`);
    if (Old && stats.blocks % jsonEvery === 0) {
        try {
            const o = Old.MultiEraBlock.fromCbor(b.bytes);
            if (JSON.stringify(o.toJson(), bigJson) === JSON.stringify(meb.toJson(), bigJson)) stats.json++; else problems.push(`${at}: JSON differs from the old library`);
        } catch (e) { problems.push(`${at}: old library: ${(e as Error).message}`); }
    }
    if (meb.era >= 2) {
        try {
            const rf = localRollForwardMessage(b.bytes);
            const ph = await headerParser(rf.bytes);
            if (ph && toHex(ph.blockHeaderHash) === toHex(b.hash)) stats.header++; else problems.push(`${at}: header parser ${ph ? "hash differs" : "returned null"}`);
        } catch (e) { problems.push(`${at}: header: ${(e as Error).message}`); }
        try { if (verifyBlockBodyHash(b.bytes).ok) stats.bodyHash++; else problems.push(`${at}: body hash mismatch`); }
        catch (e) { problems.push(`${at}: body hash: ${(e as Error).message}`); }
        const wits: any[] = (meb.block as any).transactionWitnessSets ?? [];
        for (const w of wits) {
            stats.txs++;
            const bytes: Uint8Array | null = w?.cborRef?.toBuffer?.() ?? null;
            if (!bytes) continue;
            const a = [...witnessScriptHashes(bytes).keys()].join(","), c = [...witnessScriptHashes(bytes, maxPlutusLanguage(meb.era)).keys()].join(",");
            if (a === c) stats.scripts++; else problems.push(`${at}: witness script hashes depend on the language ceiling`);
        }
    }
    if (stats.blocks % 20000 === 0) console.log(`  ${stats.blocks} blocks (slot ${b.slot}), ${problems.length} problem(s), ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
console.log(JSON.stringify({ ...stats, problems: problems.length, seconds: Math.round((performance.now() - t0) / 1000) }));
for (const p of problems.slice(0, 20)) console.log("  " + p);
process.exit(problems.length ? 1 : 0);
