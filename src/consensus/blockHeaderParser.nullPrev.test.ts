import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { headerParser, nullPrevHashOffset } from "./blockHeaderParser";
import vector from "../conformance/__vectors__/consensus/intersect_origin_one_rollforward.json";

/** The ChainSync MsgRollForward carrying `header` (Conway: header era index 6). */
const rollForward = (header: Uint8Array) => Cbor.encode(new CborArray([
    new CborUInt(2), new CborArray([new CborUInt(6), new CborTag(24, new CborBytes(header))]),
    new CborArray([new CborArray([new CborUInt(3), new CborBytes(new Uint8Array(32))]), new CborUInt(1)]),
])).toBuffer();

describe("headerParser: Conway header with a null prev_hash (bug 402)", () => {
    // block 0 of the captured devnet (ouroboros-mock intersect_origin_one_rollforward): the first
    // block of a chain that starts in Conway has `prev_hash = null`, which ledger-ts 0.5.13's
    // Babbage/Conway header decoders rejected ("invalid cbor for ConwayHeaderBody")
    const raw = Uint8Array.from(Buffer.from(vector.capture.peers[0]!.served[1]!.header_cbor!, "hex"));

    test("finds the null and parses the header with the original hash, slot and no parent", async () => {
        expect(nullPrevHashOffset(raw)).toBe(4); // 82 8a 00 02 | f6
        const p = (await headerParser(rollForward(raw)))!;
        expect(p.slot).toBe(2n);
        expect(p.prevHashHex).toBeNull();
        expect(toHex(p.blockHeaderHash)).toBe(toHex(blake2b_256(raw)));
        expect(p.rawHeaderBytes).toEqual(raw);
    });

    test("the KES-signed body bytes re-encode to the original (the null comes back as f6)", async () => {
        const p = (await headerParser(rollForward(raw)))!;
        const body = (p.multiEraHeader.header as any).body.toCborBytes() as Uint8Array;
        const original = Cbor.parseLazy(raw) as any;
        expect(toHex(body)).toBe(toHex(original.array[0]));
    });

    test("headers with a parent are untouched", () => {
        const withParent = Uint8Array.from(Buffer.from(vector.capture.peers[0]!.served[1]!.header_cbor!, "hex"));
        withParent[4] = 0x40; // prev_hash = h'' instead of null: not the null case
        expect(nullPrevHashOffset(withParent)).toBe(-1);
    });
});
