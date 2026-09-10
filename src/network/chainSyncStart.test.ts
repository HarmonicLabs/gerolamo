import { describe, expect, test } from "bun:test";
import { intersectOffsets, pickChainSyncStart } from "./chainSyncStart";

describe("pickChainSyncStart", () => {
    test("empty DB + genesis stays at origin (no peer-tip jump)", () => {
        expect(
            pickChainSyncStart({
                hasDbTip: false,
                syncFromTip: false,
                syncFromGenesis: true,
                syncFromPoint: false,
            }),
        ).toBe("genesis");
    });

    test("empty DB + tip is the explicit jump-to-head shortcut", () => {
        expect(
            pickChainSyncStart({
                hasDbTip: false,
                syncFromTip: true,
                syncFromGenesis: false,
                syncFromPoint: false,
            }),
        ).toBe("tip");
    });

    test("DB tip always resumes, even if genesis is set", () => {
        expect(
            pickChainSyncStart({
                hasDbTip: true,
                syncFromTip: false,
                syncFromGenesis: true,
                syncFromPoint: false,
            }),
        ).toBe("resume");
    });

    test("point wins over genesis on empty DB", () => {
        expect(
            pickChainSyncStart({
                hasDbTip: false,
                syncFromTip: false,
                syncFromGenesis: true,
                syncFromPoint: true,
            }),
        ).toBe("point");
    });

    test("no flags throws", () => {
        expect(() =>
            pickChainSyncStart({
                hasDbTip: false,
                syncFromTip: false,
                syncFromGenesis: false,
                syncFromPoint: false,
            }),
        ).toThrow(/Invalid sync configuration/);
    });
});

describe("intersectOffsets", () => {
    test("offers every one of the last blocks, then Fibonacci-spaced points back to k, newest first", () => {
        const offs = intersectOffsets(2160, 8);
        expect(offs.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        expect(offs.slice(9, 14)).toEqual([13, 21, 34, 55, 89]);
        expect(offs[offs.length - 1]).toBe(2160);
        for (let i = 1; i < offs.length; i++) expect(offs[i]!).toBeGreaterThan(offs[i - 1]!);
        expect(offs.length).toBeLessThan(30);
    });
    test("a one-block fork at the tip intersects at offset 1; preview's k = 432 ends the list", () => {
        const offs = intersectOffsets(432);
        expect(offs).toContain(1);
        expect(offs[offs.length - 1]).toBe(432);
    });
    test("k smaller than the dense window still ends at k", () => {
        expect(intersectOffsets(3, 8)).toEqual([0, 1, 2, 3]);
    });
});
