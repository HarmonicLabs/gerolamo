import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChunkStore } from "./chunkStore";
import { VolatileStore, prevHashOf, slotOf } from "./volatileStore";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";
const PREPROD = "/media/bakon/data/cardano/cardano-node/db/immutable";
const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });

describe.skipIf(!existsSync(`${PREVIEW}/28000.primary`))("VolatileStore", () => {
    test("hash and slot recovered from block bytes match the node's index entries (Conway)", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        let n = 0;
        let prev: Uint8Array | null = null;
        for await (const b of src.iterate(28000 * 4320, 28000 * 4320 + 4319)) {
            expect(Buffer.from(VolatileStore.hashOf(b.bytes)).equals(Buffer.from(b.hash))).toBe(true);
            expect(slotOf(b.bytes)).toBe(b.slot);
            const ph = prevHashOf(b.bytes);
            if (prev) expect(Buffer.from(ph!).equals(Buffer.from(prev))).toBe(true);
            prev = b.hash;
            n++;
        }
        expect(n).toBe(153);
    });

    test.skipIf(!existsSync(`${PREPROD}/00000.primary`))("Byron EBB and regular blocks: hash rule and slot", async () => {
        const src = await ChunkStore.open(PREPROD, { chunkSlots: 21600, readOnly: true, hashIndexPath: false });
        let ebb = 0, regular = 0;
        for await (const b of src.iterate(0, 21600 * 2 - 1, { includeEbb: true })) {
            expect(Buffer.from(VolatileStore.hashOf(b.bytes)).equals(Buffer.from(b.hash))).toBe(true);
            if (b.isEbb) { ebb++; expect(slotOf(b.bytes)).toBe(b.slot * 21600); } else { regular++; expect(slotOf(b.bytes)).toBe(b.slot); }
            expect(prevHashOf(b.bytes)?.length ?? 32).toBe(32);
        }
        expect(ebb).toBeGreaterThan(0);
        expect(regular).toBeGreaterThan(0);
    });

    test("put, file rollover, replay, torn tail, gc", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const blocks: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28000 * 4320 + 4319)) blocks.push(b);
        const dir = await mkdtemp(join(tmpdir(), "volatile-")); tmp.push(dir);
        const vs = await VolatileStore.open(dir, { blocksPerFile: 50 });
        for (const b of blocks) await vs.put(b.bytes, b.hash);
        await vs.put(blocks[3]!.bytes); // idempotent
        expect(vs.size).toBe(153);
        expect((await readdir(dir)).filter((n) => n.endsWith(".dat")).sort()).toEqual(["blocks-0.dat", "blocks-1.dat", "blocks-2.dat", "blocks-3.dat"]);
        expect(vs.get(blocks[77]!.hash)!.slot).toBe(blocks[77]!.slot);
        expect(vs.atSlot(blocks[77]!.slot).length).toBe(1);
        // node-compatible: the file is the plain concatenation of the block bytes
        const f0 = await Bun.file(join(dir, "blocks-0.dat")).bytes();
        expect(Buffer.from(f0).equals(Buffer.concat(blocks.slice(0, 50).map((b) => Buffer.from(b.bytes))))).toBe(true);
        // torn tail on the last file, then replay
        await appendFile(join(dir, "blocks-3.dat"), blocks[0]!.bytes.subarray(0, 100));
        const again = await VolatileStore.open(dir, { blocksPerFile: 50 });
        expect(again.size).toBe(153);
        expect(again.all()[0]!.slot).toBe(blocks[0]!.slot);
        expect((await Bun.file(join(dir, "blocks-3.dat")).bytes()).length).toBe(blocks.slice(150).reduce((a, b) => a + b.bytes.length, 0));
        // gc: files 0 and 1 (blocks 0..99) fully below the 100th block's slot
        const removed = await again.gc(blocks[99]!.slot);
        expect(removed).toBe(100);
        expect(again.size).toBe(53);
        expect(existsSync(join(dir, "blocks-0.dat"))).toBe(false);
        expect(existsSync(join(dir, "blocks-2.dat"))).toBe(true);
        // appending after gc continues in a new or the current file and is replayable
        const extra = (await src.blockAt(28001 * 4320 + 23)) ?? blocks[0]!;
        await again.put(extra.bytes, extra.hash);
        const third = await VolatileStore.open(dir, { blocksPerFile: 50 });
        expect(third.size).toBe(again.size);
    });
});
