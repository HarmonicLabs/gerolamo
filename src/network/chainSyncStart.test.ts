import { describe, expect, test } from "bun:test";
import { pickChainSyncStart } from "./chainSyncStart";

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
