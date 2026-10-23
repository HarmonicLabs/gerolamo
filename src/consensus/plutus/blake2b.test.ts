/**
 * blake2b.ts against the reference implementation (@noble/hashes) and RFC 7693: bit-identical digests on
 * every input length 0 … 4096 (deterministic pseudo-random content), on block boundaries far beyond, for
 * the digest lengths the builtins use (32, 28) and the others (1 … 64), plus the builtins' charging
 * unchanged (the cost of blake2b_256 / blake2b_224 is the cost model's, whatever computes the digest).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { blake2b as noble } from "@noble/hashes/blake2b";
import { blake2b, blake2b_224, blake2b_256 } from "./blake2b";
import { BuiltinCtx, callBuiltin } from "./builtins";
import { costTable } from "./costs";
import { T, VCon } from "./values";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** xorshift32: the same bytes every run, so a failure names a reproducible input. */
function prng(seed: number): () => number {
    let x = seed >>> 0 || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 0xff; };
}
function randomBytes(len: number, seed: number): Uint8Array {
    const next = prng(seed), out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = next();
    return out;
}

describe("blake2b", () => {
    test("RFC 7693 appendix A: BLAKE2b-512 of \"abc\"", () => {
        expect(hex(blake2b(new TextEncoder().encode("abc"), 64))).toBe(
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
        );
    });
    test("known digests of the empty string", () => {
        expect(hex(blake2b_256(new Uint8Array(0)))).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
        expect(hex(blake2b_224(new Uint8Array(0)))).toBe("836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07");
    });
    test("every length 0 … 4096 equals @noble/hashes for 256 and 224 bits", () => {
        for (let len = 0; len <= 4096; len++) {
            const m = randomBytes(len, 0x9e3779b9 + len);
            expect(hex(blake2b_256(m))).toBe(hex(noble(m, { dkLen: 32 })));
            expect(hex(blake2b_224(m))).toBe(hex(noble(m, { dkLen: 28 })));
        }
    });
    test("every digest length 1 … 64 on a few inputs", () => {
        for (const len of [0, 1, 31, 32, 63, 64, 100, 127, 128, 129, 255, 256, 257, 1000]) {
            const m = randomBytes(len, 7 * len + 1);
            for (let out = 1; out <= 64; out++) expect(hex(blake2b(m, out))).toBe(hex(noble(m, { dkLen: out })));
        }
    });
    test("block boundaries of long inputs (multiples of 128 and their neighbours, up to 64 KiB)", () => {
        for (const blocks of [2, 3, 7, 8, 64, 512]) for (const d of [-1, 0, 1]) {
            const len = blocks * 128 + d, m = randomBytes(len, len);
            expect(hex(blake2b_256(m))).toBe(hex(noble(m, { dkLen: 32 })));
        }
    });
    test("a subarray hashes as its own bytes (offset into a larger buffer)", () => {
        const all = randomBytes(1000, 42);
        for (const [off, len] of [[1, 32], [3, 64], [5, 127], [7, 128], [9, 129], [11, 500]] as const) {
            const view = all.subarray(off, off + len);
            expect(hex(blake2b_256(view))).toBe(hex(noble(Uint8Array.from(view), { dkLen: 32 })));
        }
    });
    test("digest length outside 1 … 64 is refused", () => {
        expect(() => blake2b(new Uint8Array(1), 0)).toThrow(RangeError);
        expect(() => blake2b(new Uint8Array(1), 65)).toThrow(RangeError);
    });
    test("the builtins return the same digests and charge the cost model's cost", () => {
        const fx = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(new URL("../__fixtures__/plutus-conformance-1.63.json.gz", import.meta.url))))) as { costModels: { PlutusV2: number[] } };
        const costs = costTable(2, fx.costModels.PlutusV2, 9);
        for (const len of [0, 31, 32, 63, 64, 65, 200]) {
            const m = randomBytes(len, 1000 + len);
            for (const [tag, dkLen] of [[20, 32], [72, 28]] as const) {
                const ctx = new BuiltinCtx(costs, null);
                ctx.maxCpu = 1e12; ctx.maxMem = 1e12;
                const out = callBuiltin(ctx, tag, [new VCon(T.bytes, m)]) as VCon;
                expect(hex(out.v)).toBe(hex(noble(m, { dkLen })));
                const c = costs.builtins[tag]!, words = len === 0 ? 1 : Math.floor((len - 1) / 8) + 1;
                expect(ctx.cpu).toBe(c.cc >= 0 ? c.cc : c.cpu.at(words, 0, 0));
                expect(ctx.mem).toBe(c.cm >= 0 ? c.cm : c.mem.at(words, 0, 0));
            }
        }
    });
});
