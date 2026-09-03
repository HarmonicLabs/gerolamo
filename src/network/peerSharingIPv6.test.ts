import { describe, expect, test } from "bun:test";
import { CborArray, CborUInt } from "@harmoniclabs/cbor";
import { PeerAddressIPv6 } from "@harmoniclabs/ouroboros-miniprotocols-ts";

describe("PeerSharing IPv6 address decode (patched ouroboros-miniprotocols-ts)", () => {
    test("N2N v13+ shape [1, w32×4, port] decodes instead of throwing", () => {
        const cbor = new CborArray([
            new CborUInt(1),
            new CborUInt(0x2a05d014), new CborUInt(0x1cfabc01), new CborUInt(0xe47e2366), new CborUInt(0x1208625a),
            new CborUInt(3001),
        ]);
        const a = PeerAddressIPv6.fromCborObj(cbor);
        expect(a.portNumber).toBe(3001);
        expect(a.address).toEqual([0x2a05d014, 0x1cfabc01, 0xe47e2366, 0x1208625a]);
        expect(a.flowInfo).toBeUndefined();
    });

    test("legacy shape with flowInfo/scopeId still decodes", () => {
        const cbor = new CborArray([
            new CborUInt(1), new CborUInt(1), new CborUInt(2), new CborUInt(3), new CborUInt(4),
            new CborUInt(0), new CborUInt(0), new CborUInt(30000),
        ]);
        expect(PeerAddressIPv6.fromCborObj(cbor).portNumber).toBe(30000);
    });
});
