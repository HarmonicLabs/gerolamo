import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
    SECONDARY_ENTRY_SIZE,
    cborItemLength,
    chunkNoOf,
    crc32,
    decodePrimary,
    decodeSecondaryEntry,
    encodePrimary,
    encodeSecondaryEntry,
    filledRelativeSlots,
    locateHeader,
    primaryFileSize,
    relativeSlot,
} from "./chunkFormat";

describe("chunkFormat", () => {
    test("secondary entry round-trips", () => {
        const e = { blockOffset: 4187, headerOffset: 3, headerSize: 857, crc: 0x8d543b57, headerHash: new Uint8Array(32).fill(7), slotOrEbb: 4320042 };
        const bytes = encodeSecondaryEntry(e);
        expect(bytes.length).toBe(SECONDARY_ENTRY_SIZE);
        const back = decodeSecondaryEntry(bytes, 0);
        expect(back).toEqual({ ...e, isEbb: false });
    });

    test("primary offsets round-trip; preview and mainnet sizes", () => {
        const offs = [0, 0, 0, 56, 56, 112];
        const back = decodePrimary(encodePrimary(offs));
        expect(back).toEqual(offs);
        expect(filledRelativeSlots(offs)).toEqual([2, 4]);
        expect(primaryFileSize(4320)).toBe(17289);
        expect(primaryFileSize(21600)).toBe(86409);
        expect(relativeSlot(4320023, 1000, 4320)).toBe(24);
        expect(chunkNoOf(122746195, 4320)).toBe(28413);
        expect(() => decodePrimary(new Uint8Array([2, 0, 0, 0, 0]))).toThrow(/version/);
    });

    test("cborItemLength skips nested definite and indefinite items", () => {
        // [1, "ab", [2, 3], {4: 5}, 6.24(bytes)] then trailing byte
        const item = Uint8Array.from([0x85, 0x01, 0x62, 0x61, 0x62, 0x82, 0x02, 0x03, 0xa1, 0x04, 0x05, 0xd8, 0x18, 0x42, 0x00, 0x00, 0xff]);
        expect(cborItemLength(item, 0)).toBe(item.length - 1);
        const indef = Uint8Array.from([0x9f, 0x01, 0x5f, 0x41, 0x00, 0xff, 0xff, 0x07]);
        expect(cborItemLength(indef, 0)).toBe(7);
    });

    test("locateHeader on a Shelley-era disk block", () => {
        // [7, [[hdr], body, wits, aux, invalid]]  with header = 2-element array
        const block = Uint8Array.from([0x82, 0x07, 0x85, 0x82, 0x01, 0x02, 0x80, 0x80, 0xa0, 0x80]);
        expect(locateHeader(block)).toEqual({ headerOffset: 3, headerSize: 3, eraTag: 7 });
    });

    const dirs = [
        { dir: "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable", chunks: [0, 1000, 28000], k: 432 },
        { dir: "/media/bakon/data/cardano/cardano-node/db/immutable", chunks: [0, 1, 100], k: 2160 },
    ].filter((d) => existsSync(`${d.dir}/00000.primary`));

    test.skipIf(dirs.length === 0)("real chunks: CRC, header location and primary mapping agree with the node's indices", async () => {
        for (const { dir, chunks, k } of dirs) {
            for (const n of chunks) {
                const name = n.toString().padStart(5, "0");
                const [pri, sec, chunk] = await Promise.all(["primary", "secondary", "chunk"].map((e) => Bun.file(`${dir}/${name}.${e}`).bytes()));
                const offs = decodePrimary(pri);
                expect(pri.length).toBe(primaryFileSize(10 * k));
                const filled = filledRelativeSlots(offs);
                const entries = sec.length / SECONDARY_ENTRY_SIZE;
                expect(filled.length).toBe(entries);
                expect(offs[offs.length - 1]).toBe(sec.length);
                for (let i = 0; i < entries; i++) {
                    const e = decodeSecondaryEntry(sec, i, filled[i] === 0);
                    const end = i + 1 < entries ? decodeSecondaryEntry(sec, i + 1).blockOffset : chunk.length;
                    const bytes = chunk.subarray(e.blockOffset, end);
                    expect(crc32(bytes)).toBe(e.crc);
                    const h = locateHeader(bytes);
                    expect(h.headerOffset).toBe(e.headerOffset);
                    expect(h.headerSize).toBe(e.headerSize);
                    if (e.isEbb) expect(h.eraTag).toBe(0);
                    else expect(filled[i]).toBe(relativeSlot(e.slotOrEbb, n, 10 * k));
                }
            }
        }
    });
});
