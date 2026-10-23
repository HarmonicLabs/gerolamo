import { describe, expect, test } from "bun:test";
import { ByronAddress } from "@harmoniclabs/cardano-ledger-ts";
import { byronAddressBytes, byronAddressType } from "./byronAddressCompat";

// A mainnet redeem (type 2) address, rebuilt from its 32-byte redeem key so the test needs no fixture.
const REDEEM_PK = new Uint8Array(32).fill(7);

describe("ByronAddress across cardano-ledger-ts versions", () => {
    test("the installed library: wire type and raw bytes", () => {
        const a = ByronAddress.fromRedeemPublicKey(REDEEM_PK);
        expect(byronAddressType(a)).toBe(2);
        const bytes = byronAddressBytes(a);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(ByronAddress.fromBytes(bytes).toBase58()).toBe(a.toBase58());
    });

    test("0.5.6 / merged 0.6.0 shape: type is \"byron\", wire type in byronType, raw bytes from toBuffer", () => {
        const raw = new Uint8Array([0x82, 0xd8, 0x18]);
        const v056 = { type: "byron", byronType: 0, toBuffer: () => raw, toBytes: () => Array.from(raw) };
        expect(byronAddressType(v056)).toBe(0);
        expect(byronAddressBytes(v056)).toBe(raw);
    });

    test("older shape: numeric type, raw bytes from toBytes", () => {
        const raw = new Uint8Array([1, 2, 3]);
        const old = { type: 2, toBytes: () => raw };
        expect(byronAddressType(old)).toBe(2);
        expect(byronAddressBytes(old)).toEqual(raw);
        expect(byronAddressType(null)).toBeNaN();
    });
});
