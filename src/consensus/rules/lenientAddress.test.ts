import { describe, expect, test } from "bun:test";
import { Address, CredentialType } from "@harmoniclabs/cardano-ledger-ts";
import { lenientShelleyAddress, parseStoredAddress } from "./requiredSigners";

const KEY = "aa".repeat(28), STAKE = "bb".repeat(28);
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp: string, data: Uint8Array): string {
    const polymod = (v: number[]) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]!; } return c; };
    const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const d: number[] = []; let acc = 0, bits = 0;
    for (const v of data) { acc = (acc << 8) | v; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
    if (bits) d.push((acc << (5 - bits)) & 31);
    const pm = polymod(exp.concat(d, [0, 0, 0, 0, 0, 0])) ^ 1;
    return hrp + "1" + d.map((x) => CH[x]).join("") + [0, 1, 2, 3, 4, 5].map((i) => CH[(pm >> (5 * (5 - i))) & 31]).join("");
}

describe("lenient Shelley address parsing", () => {
    test("an address with an out-of-range network nibble still yields its credentials", () => {
        const bytes = new Uint8Array(57);
        bytes[0] = 0x08; // base key/key with network id 8: ledger-ts refuses it
        bytes.set(Buffer.from(KEY, "hex"), 1);
        bytes.set(Buffer.from(STAKE, "hex"), 29);
        const weird = bech32("addr_test", bytes);
        expect(weird.startsWith("addr_test1p")).toBe(true);
        const a: any = parseStoredAddress(weird);
        expect(a).not.toBeNull();
        expect(String(a.paymentCreds.hash)).toBe(KEY);
        expect(String(a.stakeCreds.hash)).toBe(STAKE);
        expect(a.paymentCreds.type === CredentialType.KeyHash || a.paymentCreds.type === 0).toBe(true);
    });
    test("script payment credential and enterprise form", () => {
        const b = new Uint8Array(29); b[0] = 0x70; b.set(Buffer.from(KEY, "hex"), 1); // type 7: enterprise, script
        const a: any = lenientShelleyAddress(bech32("addr_test", b));
        expect(String(a.paymentCreds.hash)).toBe(KEY);
        expect(a.paymentCreds.type === CredentialType.Script || a.paymentCreds.type === 1).toBe(true);
        expect(a.stakeCreds == null).toBe(true);
    });
});
