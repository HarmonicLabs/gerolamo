import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { ChunkStore } from "../../../src/storage/chunkStore";
import { bodyHashOf, summarizeHeader } from "./browserNode";

const PREVIEW = "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";

describe.skipIf(!existsSync(`${PREVIEW}/28000.primary`))("browser node verification against real blocks", () => {
    test("header summary and hashTxSeq agree with the stored blocks (Conway and Babbage)", async () => {
        const src = await ChunkStore.open(PREVIEW, { chunkSlots: 4320, readOnly: true, hashIndexPath: false });
        let prev: string | null = null, n = 0;
        for (const range of [[28000 * 4320, 28000 * 4320 + 600], [1000 * 4320, 1000 * 4320 + 600]] as const) {
            prev = null;
            for await (const b of src.iterate(range[0], range[1])) {
                const eraTag = b.bytes[1]!;
                const header = b.bytes.slice(b.headerOffset, b.headerOffset + b.headerSize);
                const data = new CborArray([new CborUInt(eraTag - 1), new CborTag(24n, new CborBytes(header))]);
                const h = summarizeHeader(data);
                expect(h.slot).toBe(b.slot);
                expect(h.hash).toBe(Buffer.from(b.hash).toString("hex"));
                if (prev) expect(h.prevHash).toBe(prev);
                prev = h.hash;
                const body = bodyHashOf(b.bytes);
                expect(body.hash).toBe(h.bodyHash);
                expect(body.eraTag).toBe(eraTag);
                n++;
            }
        }
        expect(n).toBeGreaterThan(30);
    });
});
