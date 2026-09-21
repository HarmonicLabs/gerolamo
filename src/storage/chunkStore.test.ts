import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, appendFile, truncate, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChunkStore } from "./chunkStore";
import { primaryFileSize } from "./chunkFormat";

const SRC = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const K = 432, CHUNK_SLOTS = 4320;
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
async function scratch(): Promise<string> { const d = await mkdtemp(join(tmpdir(), "chunkstore-")); tmp.push(d); return d; }

describe.skipIf(!existsSync(`${SRC}/28000.primary`))("ChunkStore against the preview snapshot", () => {
    test("reads blocks by slot, headers, tip and ranges from the node's own files", async () => {
        const store = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true });
        expect(store.chunks().length).toBeGreaterThan(28000);
        const b = await store.blockAt(120960006);
        expect(b).not.toBeNull();
        expect(b!.chunkNo).toBe(28000);
        expect(b!.bytes[0]).toBe(0x82);
        expect(b!.bytes[1]).toBe(7);
        expect(Buffer.from(b!.hash).toString("hex").startsWith("847009f15ca9b9b2")).toBe(true);
        expect(await store.blockAt(120960007)).toBeNull();
        const h = await store.headerAt(120960006);
        expect(h!.header.length).toBe(857);
        expect(Buffer.from(h!.header).equals(Buffer.from(b!.bytes.subarray(3, 860)))).toBe(true);
        const range: number[] = [];
        for await (const x of store.iterate(120960000, 120964293)) range.push(x.slot);
        expect(range.length).toBe(153);
        expect(range[0]).toBe(120960006);
        expect(range[range.length - 1]).toBe(120964293);
        const tip = await store.tip();
        expect(tip!.slot).toBeGreaterThan(122_700_000);
    });

    test("appends re-create a chunk byte for byte, survive reopen, and cross a chunk boundary", async () => {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true });
        const dir = await scratch();
        const dst = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(dir, "gerolamo", "hash-index.bin") });
        const blocks: Awaited<ReturnType<typeof src.blockAt>>[] = [];
        for await (const b of src.iterate(1000 * CHUNK_SLOTS, 1002 * CHUNK_SLOTS - 1)) blocks.push(b);
        expect(blocks.length).toBeGreaterThan(300);
        for (const b of blocks) await dst.append({ slot: b!.slot, hash: b!.hash, bytes: b!.bytes });
        // chunk 1000 is complete in dst (finalised when 1001 started): identical files
        for (const ext of ["chunk", "secondary", "primary"] as const) {
            const a = await Bun.file(`${SRC}/01000.${ext}`).bytes(), z = await Bun.file(`${dir}/01000.${ext}`).bytes();
            expect(Buffer.from(z).equals(Buffer.from(a))).toBe(true);
        }
        expect((await stat(`${dir}/01000.primary`)).size).toBe(primaryFileSize(CHUNK_SLOTS));
        // chunk 1001 is still open: chunk + secondary identical, primary a prefix of the node's
        const a = await Bun.file(`${SRC}/01001.primary`).bytes(), z = await Bun.file(`${dir}/01001.primary`).bytes();
        expect(z.length).toBeLessThan(a.length);
        expect(Buffer.from(a.subarray(0, z.length)).equals(Buffer.from(z))).toBe(true);
        expect(Buffer.from(await Bun.file(`${dir}/01001.chunk`).bytes()).equals(Buffer.from(await Bun.file(`${SRC}/01001.chunk`).bytes()))).toBe(true);
        // reopen: verify and tip
        const again = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(dir, "gerolamo", "hash-index.bin") });
        expect((await again.verifyChunk(1000)).errors).toEqual([]);
        expect((await again.verifyChunk(1001)).errors).toEqual([]);
        expect((await again.tip())!.slot).toBe(blocks[blocks.length - 1]!.slot);
        expect((await again.blockAt(blocks[5]!.slot))!.hash).toEqual(blocks[5]!.hash);
        // hash index: built on open from the secondary indices, extended by append, reloaded
        expect((await again.blockByHash(blocks[7]!.hash))!.slot).toBe(blocks[7]!.slot);
        expect(await again.blockByHash(new Uint8Array(32))).toBeNull();
        expect(existsSync(join(dir, "gerolamo", "hash-index.bin"))).toBe(true);
    });

    test("recovers from a torn write: trailing block bytes without index, half a secondary entry", async () => {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true });
        const dir = await scratch();
        const dst = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(dir, "gerolamo", "hash-index.bin") });
        const blocks: Awaited<ReturnType<typeof src.blockAt>>[] = [];
        for await (const b of src.iterate(28000 * CHUNK_SLOTS, 28000 * CHUNK_SLOTS + 2000)) blocks.push(b);
        const keep = blocks.slice(0, 10), extra = blocks[10]!;
        for (const b of keep) await dst.append({ slot: b!.slot, hash: b!.hash, bytes: b!.bytes });
        // crash after writing block bytes and half an entry, before the primary
        await appendFile(`${dir}/28000.chunk`, extra.bytes);
        await appendFile(`${dir}/28000.secondary`, new Uint8Array(20));
        const rec = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: false });
        expect((await rec.verifyChunk(28000)).errors).toEqual([]);
        expect((await rec.tip())!.slot).toBe(keep[9]!.slot);
        // and appending continues cleanly
        await rec.append({ slot: extra.slot, hash: extra.hash, bytes: extra.bytes });
        expect((await rec.verifyChunk(28000)).errors).toEqual([]);
        expect((await rec.blockAt(extra.slot))!.bytes.length).toBe(extra.bytes.length);
    });

    test("rejects out-of-order appends", async () => {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true });
        const dir = await scratch();
        const dst = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(dir, "gerolamo", "hash-index.bin") });
        const b1 = (await src.blockAt(120960006))!, b2 = (await src.blockAt(120960059))!;
        await dst.append({ slot: b2.slot, hash: b2.hash, bytes: b2.bytes });
        await expect(dst.append({ slot: b1.slot, hash: b1.hash, bytes: b1.bytes })).rejects.toThrow(/not after/);
        await expect(dst.append({ slot: 1000, hash: b1.hash, bytes: b1.bytes })).rejects.toThrow(/chunk/);
    });
});

describe.skipIf(!existsSync(`${SRC}/28001.primary`))("truncateAfter", () => {
    test("drops later chunks and rewrites the kept chunk to the state's slot; appends continue", async () => {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true });
        const dir = await scratch();
        const dst = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: false });
        const blocks: Awaited<ReturnType<typeof src.blockAt>>[] = [];
        for await (const b of src.iterate(1000 * CHUNK_SLOTS, 1002 * CHUNK_SLOTS - 1)) blocks.push(b);
        for (const b of blocks) await dst.append({ slot: b!.slot, hash: b!.hash, bytes: b!.bytes });
        const inFirst = blocks.filter((b) => b!.slot < 1001 * CHUNK_SLOTS);
        const cut = inFirst[inFirst.length - 10]!;
        const removed = await dst.truncateAfter(cut.slot);
        expect(removed).toBe(blocks.length - (inFirst.length - 9));
        expect(dst.chunks()).toEqual([1000]);
        expect((await dst.tip())!.slot).toBe(cut.slot);
        expect((await dst.verifyChunk(1000)).errors).toEqual([]);
        expect(await dst.blockAt(inFirst[inFirst.length - 1]!.slot)).toBeNull();
        // appending the dropped blocks again re-creates the node's files exactly
        for (const b of blocks.slice(inFirst.length - 9)) await dst.append({ slot: b!.slot, hash: b!.hash, bytes: b!.bytes });
        for (const ext of ["chunk", "secondary", "primary"] as const) {
            expect(Buffer.from(await Bun.file(`${dir}/01000.${ext}`).bytes()).equals(Buffer.from(await Bun.file(`${SRC}/01000.${ext}`).bytes()))).toBe(true);
        }
        const again = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: false });
        expect((await again.tip())!.slot).toBe(blocks[blocks.length - 1]!.slot);
    });
});
