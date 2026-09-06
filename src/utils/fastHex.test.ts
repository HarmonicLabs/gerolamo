import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

// Reference implementations (the library's originals before the Gerolamo patch).
function refToHex(b: Uint8Array): string { const a = new Array(b.length); b.forEach((x, i) => (a[i] = x.toString(16).padStart(2, "0"))); return a.join(""); }
function refFromHex(s: string): Uint8Array { s = s.toLowerCase(); s = s.length % 2 === 0 ? s : "0" + s; const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) { const p = s.substring(2 * i, 2 * i + 2); if (!/^[0-9a-f]{2}$/.test(p)) throw new TypeError("bad"); out[i] = parseInt(p, 16); } return out; }

describe("patched @harmoniclabs/uint8array-utils hex", () => {
    test("toHex equals the reference for random buffers of every size class", () => {
        for (const n of [0, 1, 2, 31, 32, 63, 64, 65, 100, 1000, 70_000]) {
            const b = crypto.getRandomValues(new Uint8Array(n));
            expect(toHex(b)).toBe(refToHex(b));
            // views into a larger buffer must honour byteOffset
            const big = new Uint8Array(n + 7); big.set(b, 3);
            expect(toHex(big.subarray(3, 3 + n))).toBe(refToHex(b));
        }
        expect(() => toHex("ab" as any)).toThrow(TypeError);
    });
    test("fromHex equals the reference, accepts upper case and odd length, rejects non-hex", () => {
        for (const n of [0, 1, 2, 33, 64, 4097]) {
            const b = crypto.getRandomValues(new Uint8Array(n));
            const h = refToHex(b);
            expect(Buffer.from(fromHex(h)).toString("hex")).toBe(h);
            expect(Buffer.from(fromHex(h.toUpperCase())).toString("hex")).toBe(h);
        }
        expect(Buffer.from(fromHex("abc")).toString("hex")).toBe(Buffer.from(refFromHex("abc")).toString("hex"));
        expect(Buffer.from(fromHex("F")).toString("hex")).toBe("0f");
        for (const bad of ["zz", "0g", "ab cd", "é1", "0x12"]) { expect(() => fromHex(bad)).toThrow(TypeError); expect(() => refFromHex(bad)).toThrow(); }
        expect(() => fromHex(12 as any)).toThrow(TypeError);
    });
    test("round trip", () => {
        const b = crypto.getRandomValues(new Uint8Array(5000));
        expect(Buffer.from(fromHex(toHex(b))).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    });
});
