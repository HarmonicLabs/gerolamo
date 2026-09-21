import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "./blockStore";
import { ChunkStore } from "./chunkStore";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("BlockStore", () => {
    test("volatile puts, promotion into chunks, gc, reads across both layers", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const dir = await mkdtemp(join(tmpdir(), "blockstore-")); tmp.push(dir);
        const store = await BlockStore.open(dir, { k: 432, volatileBlocksPerFile: 20 });
        // chunk 28000 becomes the immutable base
        const base: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28001 * 4320 - 1)) base.push(b);
        for (const b of base) await store.chunks.append({ slot: b.slot, hash: b.hash, bytes: b.bytes });
        expect((await store.immutableTip())!.slot).toBe(base[base.length - 1]!.slot);
        // chunk 28001's blocks arrive as volatile
        const next: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28001 * 4320, 28002 * 4320 - 1)) next.push(b);
        expect(next.length).toBeGreaterThan(100);
        for (const b of next) await store.put(b.bytes, b.hash);
        expect(store.volatile.size).toBe(next.length);
        const tipHash = next[next.length - 1]!.hash;
        expect(store.volatileChain(tipHash).length).toBe(next.length); // connects all the way down
        // reads: volatile and immutable
        expect((await store.byHash(next[10]!.hash))!.immutable).toBe(false);
        expect((await store.byHash(base[10]!.hash))!.immutable).toBe(true);
        expect((await store.bySlot(next[10]!.slot))!.slot).toBe(next[10]!.slot);
        expect(await store.has(new Uint8Array(32))).toBe(false);
        // promote with k = 50: all but the newest 50 move into chunk 28001
        const r = await store.promote(tipHash, 50);
        expect(r.promoted).toBe(next.length - 50);
        expect(r.immutableSlot).toBe(next[next.length - 51]!.slot);
        expect((await store.immutableTip())!.slot).toBe(r.immutableSlot);
        expect(store.volatile.size).toBeLessThan(next.length);
        expect(store.volatile.size).toBeGreaterThanOrEqual(50);
        const files = (await readdir(join(dir, "volatile"))).filter((n) => n.endsWith(".dat"));
        expect(files.length).toBeLessThan(Math.ceil(next.length / 20));
        // the promoted part is byte-identical to the node's chunk file prefix
        const ours = await Bun.file(join(dir, "immutable", "28001.chunk")).bytes();
        const theirs = await Bun.file(`${PREVIEW}/28001.chunk`).bytes();
        expect(Buffer.from(theirs.subarray(0, ours.length)).equals(Buffer.from(ours))).toBe(true);
        // iterate across the boundary
        const slots: number[] = [];
        for await (const b of store.iterate(next[next.length - 55]!.slot, next[next.length - 1]!.slot, tipHash)) slots.push(b.slot);
        expect(slots).toEqual(next.slice(-55).map((b) => b.slot));
        // a second promote with the same tip is a no-op; a chain that does not connect is refused
        expect((await store.promote(tipHash, 50)).promoted).toBe(0);
        const stray = await src.blockAt(28005 * 4320 + 7) ?? (await src.iterate(28005 * 4320).next()).value!;
        await store.put(stray.bytes, stray.hash);
        await expect(store.promote(stray.hash, 0)).rejects.toThrow(/does not extend/);
        // reopen: everything is still there
        const again = await BlockStore.open(dir, { k: 432, volatileBlocksPerFile: 20 });
        expect((await again.immutableTip())!.slot).toBe(r.immutableSlot);
        expect((await again.byHash(tipHash))!.immutable).toBe(false);
        expect((await again.byHash(next[3]!.hash))!.immutable).toBe(true);
    });
});
