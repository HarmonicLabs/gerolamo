// Bug 384: batched block-store fsyncs. appendMany must write exactly the files per-block appends write,
// refuse a bad batch before writing, and the volatile store must replay past a zero-filled tail.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChunkStore } from "./chunkStore";
import { VolatileStore } from "./volatileStore";
import { BlockStore } from "./blockStore";

const SRC = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const CHUNK_SLOTS = 4320;
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
async function scratch(): Promise<string> { const d = await mkdtemp(join(tmpdir(), "batched-sync-")); tmp.push(d); return d; }

describe.skipIf(!existsSync(`${SRC}/01000.primary`))("batched block-store syncs (bug 384)", () => {
    async function sample(from: number, to: number) {
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true, hashIndexPath: false });
        const out: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(from, to)) out.push({ slot: b.slot, hash: b.hash, bytes: b.bytes });
        return out;
    }

    test("appendMany writes the same files as per-block append, across a chunk boundary", async () => {
        const blocks = await sample(1000 * CHUNK_SLOTS, 1002 * CHUNK_SLOTS - 1);
        expect(blocks.length).toBeGreaterThan(300);
        const one = await scratch(), many = await scratch();
        const a = await ChunkStore.open(one, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(one, "gerolamo", "hash-index.bin"), syncPolicy: "none" });
        const b = await ChunkStore.open(many, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(many, "gerolamo", "hash-index.bin"), syncPolicy: "none" });
        for (const x of blocks) await a.append(x);
        // uneven batches, one straddling the chunk boundary
        for (let i = 0; i < blocks.length; i += 97) await b.appendMany(blocks.slice(i, i + 97));
        for (const n of ["01000", "01001"]) for (const ext of ["chunk", "secondary", "primary"]) {
            const x = await Bun.file(`${one}/${n}.${ext}`).bytes(), y = await Bun.file(`${many}/${n}.${ext}`).bytes();
            expect(Buffer.from(y).equals(Buffer.from(x))).toBe(true);
        }
        expect(Buffer.from(await Bun.file(`${many}/gerolamo/hash-index.bin`).bytes()).equals(Buffer.from(await Bun.file(`${one}/gerolamo/hash-index.bin`).bytes()))).toBe(true);
        const again = await ChunkStore.open(many, { chunkSlots: CHUNK_SLOTS, hashIndexPath: join(many, "gerolamo", "hash-index.bin") });
        expect((await again.verifyChunk(1000)).errors).toEqual([]);
        expect((await again.verifyChunk(1001)).errors).toEqual([]);
        expect((await again.tip())!.slot).toBe(blocks[blocks.length - 1]!.slot);
        expect((await again.blockByHash(blocks[150]!.hash))!.slot).toBe(blocks[150]!.slot);
    });

    test("a batch with a block out of order writes nothing of its chunk", async () => {
        const blocks = await sample(1000 * CHUNK_SLOTS, 1000 * CHUNK_SLOTS + 2000);
        const dir = await scratch();
        const s = await ChunkStore.open(dir, { chunkSlots: CHUNK_SLOTS, hashIndexPath: false, syncPolicy: "none" });
        await s.appendMany(blocks.slice(0, 10));
        const before = await Bun.file(`${dir}/01000.chunk`).bytes();
        await expect(s.appendMany([blocks[12]!, blocks[11]!])).rejects.toThrow(/not after/);
        expect((await Bun.file(`${dir}/01000.chunk`).bytes()).length).toBe(before.length);
        await s.appendMany(blocks.slice(10, 20)); // the store is still usable
        expect((await s.tip())!.slot).toBe(blocks[19]!.slot);
    });

    test("volatile store: batched puts are durable after flush, replay stops at a zero-filled tail", async () => {
        const blocks = await sample(1000 * CHUNK_SLOTS, 1000 * CHUNK_SLOTS + 2000);
        const dir = await scratch();
        const v = await VolatileStore.open(dir, { syncPolicy: "batch" });
        for (const b of blocks.slice(0, 20)) await v.put(b.bytes, b.hash);
        expect(v.pendingFiles()).toBe(1);
        expect(await v.flush()).toBe(1);
        expect(v.pendingFiles()).toBe(0);
        await appendFile(join(dir, "blocks-0.dat"), new Uint8Array(4096)); // what a power loss can leave behind
        const r = await VolatileStore.open(dir);
        expect(r.size).toBe(20);
        expect(Bun.file(join(dir, "blocks-0.dat")).size).toBe(blocks.slice(0, 20).reduce((n, b) => n + b.bytes.length, 0));
    });

    test("BlockStore.promote moves blocks with batched writes and keeps reads intact", async () => {
        const blocks = await sample(1000 * CHUNK_SLOTS, 1001 * CHUNK_SLOTS + 1500);
        const dir = await scratch();
        const bs = await BlockStore.open(dir, { k: 50 });
        // the chunk store must start at the first block's chunk: seed it with the first block
        await bs.chunks.appendMany([blocks[0]!]);
        for (const b of blocks.slice(1)) await bs.put(b.bytes, b.hash);
        const r = await bs.promote(blocks[blocks.length - 1]!.hash, 50);
        expect(r.promoted).toBe(blocks.length - 1 - 50);
        expect(r.immutableSlot).toBe(blocks[blocks.length - 51]!.slot);
        expect(bs.volatile.pendingFiles()).toBe(0);
        for (const i of [1, 100, blocks.length - 51, blocks.length - 1]) {
            const got = await bs.byHash(blocks[i]!.hash);
            expect(got!.slot).toBe(blocks[i]!.slot);
            expect(Buffer.from(got!.bytes).equals(Buffer.from(blocks[i]!.bytes))).toBe(true);
        }
    });
});

describe.skipIf(!existsSync(`${SRC}/01000.primary`))("selected-chain membership cache (bug 386)", () => {
    test("follows the tip forward, a rollback and a re-extension", async () => {
        const { hasOnSelectedChain, setSelectedTipHash } = await import("./blockReads");
        const src = await ChunkStore.open(SRC, { chunkSlots: CHUNK_SLOTS, readOnly: true, hashIndexPath: false });
        const blocks: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(1000 * CHUNK_SLOTS, 1000 * CHUNK_SLOTS + 2000)) blocks.push(b);
        const dir = await scratch();
        const bs = await BlockStore.open(dir, { k: 50 });
        await bs.chunks.appendMany([blocks[0]!]);
        const hx = (i: number) => Buffer.from(blocks[i]!.hash).toString("hex");
        try {
            for (let i = 1; i < 30; i++) await bs.put(blocks[i]!.bytes, blocks[i]!.hash);
            setSelectedTipHash(blocks[20]!.hash);
            expect(await hasOnSelectedChain(bs, hx(10))).toBe(true);
            expect(await hasOnSelectedChain(bs, hx(25))).toBe(false); // stored, but above the tip
            for (let i = 21; i < 30; i++) { setSelectedTipHash(blocks[i]!.hash); expect(await hasOnSelectedChain(bs, hx(i - 1))).toBe(true); }
            expect(await hasOnSelectedChain(bs, hx(25))).toBe(true);
            setSelectedTipHash(blocks[15]!.hash); // rollback
            expect(await hasOnSelectedChain(bs, hx(25))).toBe(false);
            expect(await hasOnSelectedChain(bs, hx(14))).toBe(true);
            setSelectedTipHash(blocks[16]!.hash); // extend again from the rolled-back tip
            expect(await hasOnSelectedChain(bs, hx(16))).toBe(true);
            expect(await hasOnSelectedChain(bs, hx(17))).toBe(false);
        } finally {
            setSelectedTipHash(null);
        }
    });
});
