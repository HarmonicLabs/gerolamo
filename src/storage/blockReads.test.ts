import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "./blockStore";
import * as reads from "./blockReads";
import { ChunkStore } from "./chunkStore";
import { blockNoOf } from "./volatileStore";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); reads.setSelectedTipHash(null); });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("blockReads (primary-mode db helpers over the BlockStore)", () => {
    test("rows, tips, recent points, last-before, rollback of the selected tip", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const dir = await mkdtemp(join(tmpdir(), "blockreads-")); tmp.push(dir);
        const store = await BlockStore.open(dir, { k: 432 });
        const imm: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28001 * 4320 - 1)) imm.push(b);
        for (const b of imm) await store.chunks.append({ slot: b.slot, hash: b.hash, bytes: b.bytes });
        const vol: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28001 * 4320, 28001 * 4320 + 800)) vol.push(b);
        for (const b of vol) await store.put(b.bytes, b.hash);
        const tip = vol[vol.length - 1]!;
        reads.setSelectedTipHash(tip.hash);

        // positional row shape: [id, chunk_id, slot, block_hash(hex), prev_hash(hex), header_data, block_data, rfh, is_valid, inserted_at, block_no]
        const row = (await reads.getBlockBySlot(store, imm[5]!.slot))!;
        expect(row[2]).toBe(imm[5]!.slot);
        expect(row[3]).toBe(hex(imm[5]!.hash));
        expect(row[4]).toBe(hex(imm[4]!.hash));
        expect(row[6]).toEqual(imm[5]!.bytes);
        expect(row[5]!.length).toBe(857);
        expect(row[8]).toBe(true);
        expect(row[10]).toBe(blockNoOf(imm[5]!.bytes));
        expect((await reads.getBlockByHash(store, hex(vol[2]!.hash)))![2]).toBe(vol[2]!.slot);
        expect(await reads.getBlockByHash(store, "zz")).toBeNull();

        // tips
        expect(await reads.getMaxSlot(store)).toBe(BigInt(tip.slot));
        const t = (await reads.getChainTipFromHeader(store))!;
        expect(t.hashHex).toBe(hex(tip.hash));
        expect(Number(t.blockNumber)).toBe(blockNoOf(tip.bytes)!);
        expect(t.era).toBe(7);
        expect(await reads.getMaxBlockNo(store)).toBe(blockNoOf(tip.bytes)!);

        // recent points: newest first, across the volatile/immutable boundary
        const recent = await reads.getRecentBlockPoints(store, vol.length + 3);
        expect(recent.length).toBe(vol.length + 3);
        expect(recent[0]!.slot).toBe(BigInt(tip.slot));
        expect(recent[vol.length]!.hash).toBe(hex(imm[imm.length - 1]!.hash));
        expect(recent[vol.length + 2]!.hash).toBe(hex(imm[imm.length - 3]!.hash));
        const hdrs = await reads.getRecentBlockHeaders(store, 2);
        expect(hdrs[0]!.header_data).toEqual(tip.bytes.slice(3, 860));

        // last-before: inside volatile, at the boundary, inside immutable
        expect((await reads.getLastBlockBefore(store, vol[3]!.slot))!.hash).toBe(hex(vol[2]!.hash));
        expect((await reads.getLastBlockBefore(store, vol[0]!.slot))!.hash).toBe(hex(imm[imm.length - 1]!.hash));
        expect((await reads.getLastBlockBefore(store, imm[7]!.slot))!.hash).toBe(hex(imm[6]!.hash));
        expect((await reads.getLastBlockBefore(store, Number.MAX_SAFE_INTEGER))!.hash).toBe(hex(tip.hash));

        // by height within the volatile window
        const byH = await reads.getBlockListRowByHeight(store, blockNoOf(vol[4]!.bytes)!);
        expect(byH!.hash).toBe(hex(vol[4]!.hash));

        // rollback of the selected tip: hashes above, then the tip moves; a re-put block on the dead branch is not on the chain
        const above = await reads.blockHashesAbove(store, vol[5]!.slot);
        expect(above.length).toBe(vol.length - 6);
        const removed = await reads.rollbackSelectedTip(store, vol[5]!.slot);
        expect(removed!.length).toBe(vol.length - 6);
        expect(await reads.getMaxSlot(store)).toBe(BigInt(vol[5]!.slot));
        expect(await reads.onSelectedChain(store, (await store.byHash(vol[9]!.hash))!)).toBe(false);
        expect(await reads.onSelectedChain(store, (await store.byHash(vol[4]!.hash))!)).toBe(true);
        // rollback to a slot without a block lands on the last block before it
        await reads.rollbackSelectedTip(store, vol[2]!.slot + 1);
        expect(await reads.getMaxSlot(store)).toBe(BigInt(vol[2]!.slot));
    });
});

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("selected tip fallback", () => {
    test("a volatile set that still holds blocks at and below the immutable tip still resolves the chain's top", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const dir = await mkdtemp(join(tmpdir(), "blockreads2-")); tmp.push(dir);
        const store = await BlockStore.open(dir, { k: 432, volatileBlocksPerFile: 1000 });
        const all: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28000 * 4320 + 3000)) all.push(b);
        // everything goes into the volatile set first (as after a catch-up), then the first 60 are promoted
        for (const b of all) await store.put(b.bytes, b.hash);
        reads.setSelectedTipHash(all[all.length - 1]!.hash);
        await store.promote(all[all.length - 1]!.hash, all.length - 60);
        expect((await store.immutableTip())!.slot).toBe(all[59]!.slot);
        expect(store.volatile.size).toBe(all.length); // one file, nothing garbage-collected yet
        reads.setSelectedTipHash(null); // as after a restart without a persisted tip
        const tip = await reads.selectedTip(store);
        expect(tip!.slot).toBe(all[all.length - 1]!.slot);
        expect(reads.chainConnects(store, all[all.length - 1]!.hash, await store.immutableTip())).toBe(true);
        expect(reads.chainConnects(store, (await src.iterate(28003 * 4320).next()).value!.hash, await store.immutableTip())).toBe(false);
    });
});

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("API block lists", () => {
    test("newest-first with cursor, slot-range pages, counts", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const dir = await mkdtemp(join(tmpdir(), "blockreads3-")); tmp.push(dir);
        const store = await BlockStore.open(dir, { k: 432 });
        const imm: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28001 * 4320 - 1)) imm.push(b);
        for (const b of imm) await store.chunks.append({ slot: b.slot, hash: b.hash, bytes: b.bytes });
        const vol: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28001 * 4320, 28001 * 4320 + 600)) vol.push(b);
        for (const b of vol) await store.put(b.bytes, b.hash);
        reads.setSelectedTipHash(vol[vol.length - 1]!.hash);
        const top = await reads.listBlocksDesc(store, 5);
        expect(top.map((r) => r.slot)).toEqual(vol.slice(-5).reverse().map((b) => b.slot));
        expect(top[0]!.blockNo).toBe(blockNoOf(vol[vol.length - 1]!.bytes));
        const page2 = await reads.listBlocksDesc(store, 5, top[top.length - 1]!.slot);
        expect(page2.map((r) => r.slot)).toEqual(vol.slice(-10, -5).reverse().map((b) => b.slot));
        // across the boundary into the immutable part
        const cross = await reads.listBlocksDesc(store, vol.length + 2, vol[vol.length - 1]!.slot + 1);
        expect(cross.length).toBe(vol.length + 2);
        expect(cross[cross.length - 1]!.hash).toBe(hex(imm[imm.length - 2]!.hash));
        // epoch-page style range
        const range = await reads.listBlocksInSlotRange(store, imm[3]!.slot, imm[8]!.slot, 100);
        expect(range.map((r) => r.slot)).toEqual(imm.slice(3, 8).map((b) => b.slot));
        expect((await reads.listBlocksInSlotRange(store, imm[3]!.slot, imm[8]!.slot, 2, 2)).map((r) => r.slot)).toEqual([imm[5]!.slot, imm[6]!.slot]);
        expect(await reads.countBlocksInSlotRange(store, imm[0]!.slot, vol[vol.length - 1]!.slot + 1)).toBe(imm.length + vol.length);
    });
});
