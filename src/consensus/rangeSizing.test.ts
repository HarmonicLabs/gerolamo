import { describe, expect, test } from "bun:test";
import { clampMaxRangeBlocks, rangeSizeFor } from "./rangeSizing";

describe("rangeSizeFor", () => {
    test("far behind the tip uses the configured maximum", () => {
        expect(rangeSizeFor(10_000_000n, 0n, false, 128)).toBe(128);
        expect(rangeSizeFor(100_000n, 0n, true, 128)).toBe(128); // Byron: 1 block per slot
    });
    test("shrinks as the applier approaches the tip", () => {
        // Shelley: ~20 slots per block
        expect(rangeSizeFor(20n * 1000n, 0n, false, 128)).toBe(64);
        expect(rangeSizeFor(20n * 100n, 0n, false, 128)).toBe(16);
        expect(rangeSizeFor(20n * 10n, 0n, false, 128)).toBe(4);
        expect(rangeSizeFor(20n * 3n, 0n, false, 128)).toBe(1);
        expect(rangeSizeFor(5n, 5n, false, 128)).toBe(1);
        expect(rangeSizeFor(0n, 5n, false, 128)).toBe(1); // header beyond the reported tip
    });
    test("Byron distance counts slots as blocks", () => {
        expect(rangeSizeFor(1000n, 0n, true, 128)).toBe(64);
        expect(rangeSizeFor(1000n, 0n, false, 128)).toBe(4);
    });
    test("never exceeds the maximum", () => {
        expect(rangeSizeFor(10_000_000n, 0n, false, 16)).toBe(16);
        expect(rangeSizeFor(20n * 1000n, 0n, false, 8)).toBe(8);
    });
});

describe("clampMaxRangeBlocks", () => {
    test("defaults to 128 and clamps to 1..256", () => {
        expect(clampMaxRangeBlocks(undefined)).toBe(128);
        expect(clampMaxRangeBlocks("nope")).toBe(128);
        expect(clampMaxRangeBlocks(0)).toBe(128);
        expect(clampMaxRangeBlocks(1000)).toBe(256);
        expect(clampMaxRangeBlocks(64.7)).toBe(64);
    });
});
