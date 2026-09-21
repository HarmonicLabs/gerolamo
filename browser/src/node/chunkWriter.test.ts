import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ChunkStore } from "../../../src/storage/chunkStore";
import { ChunkWriter, MemorySink } from "./chunkWriter";
import { crc32 } from "../../../src/storage/chunkFormat";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";

describe.skipIf(!existsSync(`${PREVIEW}/28001.primary`))("browser chunk writer", () => {
    test("a full chunk fed from its first block is byte-identical to the node's files; a mid-chunk start yields a valid index; resume works", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, 4320);
        const blocks: { slot: number; hash: Uint8Array; bytes: Uint8Array }[] = [];
        for await (const b of src.iterate(28000 * 4320, 28001 * 4320 + 200)) blocks.push(b);
        for (const b of blocks) await w.append(b.slot, b.hash, b.bytes);
        for (const ext of ["chunk", "secondary", "primary"] as const) {
            expect(Buffer.from((await sink.read(`28000.${ext}`))!).equals(Buffer.from(await Bun.file(`${PREVIEW}/28000.${ext}`).bytes()))).toBe(true);
        }
        expect(w.stats.blocks).toBe(blocks.length);
        // the open chunk 28001 is a prefix of the node's
        const ours = (await sink.read("28001.chunk"))!, theirs = await Bun.file(`${PREVIEW}/28001.chunk`).bytes();
        expect(Buffer.from(theirs.subarray(0, ours.length)).equals(Buffer.from(ours))).toBe(true);
        // pure-TS crc equals Bun's
        expect(crc32(blocks[0]!.bytes)).toBe(Bun.hash.crc32(blocks[0]!.bytes) >>> 0);
        // resume from the sink: last stored slot, then appending continues
        const w2 = new ChunkWriter(sink, 4320);
        const r = await w2.resume();
        expect(r!.lastSlot).toBe(blocks[blocks.length - 1]!.slot);
        const more: typeof blocks = [];
        for await (const b of src.iterate(blocks[blocks.length - 1]!.slot + 1, 28001 * 4320 + 800)) more.push(b);
        for (const b of more) await w2.append(b.slot, b.hash, b.bytes);
        const ours2 = (await sink.read("28001.chunk"))!;
        expect(Buffer.from(theirs.subarray(0, ours2.length)).equals(Buffer.from(ours2))).toBe(true);
        // mid-chunk start (light client from the tip): index valid, readable by the node-format reader
        const sink2 = new MemorySink();
        const w3 = new ChunkWriter(sink2, 4320);
        for (const b of blocks.slice(50, 80)) await w3.append(b.slot, b.hash, b.bytes);
        const pri = (await sink2.read("28000.primary"))!;
        const { decodePrimary, filledRelativeSlots, relativeSlot } = await import("../../../src/storage/chunkFormat");
        const offs = decodePrimary(pri);
        expect(filledRelativeSlots(offs)).toEqual(blocks.slice(50, 80).map((b) => relativeSlot(b.slot, 28000, 4320)));
    }, 60_000);
});
