import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { ChainPoint, ChainSyncRollForward, ChainTip } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { headerParser } from "./blockHeaderParser";
import { splitEraBlock } from "./bodyHash";
import shelleyConway from "./__fixtures__/shelley-conway-preprod.json";

const blocks = shelleyConway.blocks as Record<string, string>;

/**
 * Wrap a block's header the way ChainSync RollForward carries it: [era, #6.24(header bytes)].
 * ChainSync numbers Shelley as era 1 (Byron is 0 with its own sub-tag); the block wrapper
 * numbers it 2 (0 = EBB, 1 = Byron main), so the header era is the block era minus one.
 */
function rollForwardOf(blockHex: string): { bytes: Uint8Array; rawHeader: Uint8Array; era: number } {
    const { era, rawBlock } = splitEraBlock(fromHex(blockHex));
    const arr = Cbor.parseLazy(rawBlock);
    if (!(arr instanceof LazyCborArray)) throw new Error("not an array");
    const rawHeader = arr.array[0]!;
    const rf = new ChainSyncRollForward({
        data: new CborArray([new CborUInt(era - 1), new CborTag(24, new CborBytes(rawHeader))]),
        tip: new ChainTip({
            point: new ChainPoint({ blockHeader: { slotNumber: 0n, hash: new Uint8Array(32) } }),
            blockNo: 0n,
        }),
    });
    return { bytes: rf.toCborBytes(), rawHeader, era };
}

describe("headerParser (Shelley+)", () => {
    test("first preprod Shelley block: hash, slot and prevHashHex are populated", async () => {
        const { bytes, rawHeader, era } = rollForwardOf(blocks.shelley_86400!);
        const parsed = await headerParser(bytes);
        expect(parsed).not.toBeNull();
        expect(parsed!.isByron).toBe(false);
        expect(parsed!.era).toBe(era);
        expect(parsed!.slot).toBe(86400n);
        expect(toHex(parsed!.blockHeaderHash)).toBe(toHex(blake2b_256(rawHeader)));
        // Was hardcoded null, which left the Shelley+ contiguity check dead.
        expect(parsed!.prevHashHex).toMatch(/^[0-9a-f]{64}$/);
        expect(parsed!.prevHashHex).not.toBe(toHex(parsed!.blockHeaderHash));
    });

    test("Conway tip block also carries its prev hash", async () => {
        const { bytes } = rollForwardOf(blocks.tip!);
        const parsed = await headerParser(bytes);
        expect(parsed!.era).toBe(7);
        expect(parsed!.prevHashHex).toMatch(/^[0-9a-f]{64}$/);
    });
});
