import { describe, expect, test } from "bun:test";
import { Cbor, CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";
import { rawScriptBytes } from "./assets";

describe("Blockfrost script CBOR", () => {
    test("unwraps the Script [language, bytes] wrapper", () => {
        const script = new Uint8Array([0x01, 0x01, 0x00, 0x33, 0x33]);
        const wrapped = Cbor.encode(new CborArray([new CborUInt(3n), new CborBytes(script)]));
        expect([...rawScriptBytes("plutusV3", wrapped)]).toEqual([...script]);
    });

    test("leaves raw script bytes untouched", () => {
        const script = new Uint8Array([0x01, 0x01, 0x00, 0x33]);
        expect([...rawScriptBytes("plutusV2", script)]).toEqual([...script]);
    });

    test("leaves timelock scripts untouched", () => {
        const native = new Uint8Array([0x82, 0x00, 0x01]);
        expect([...rawScriptBytes("timelock", native)]).toEqual([...native]);
    });
});
