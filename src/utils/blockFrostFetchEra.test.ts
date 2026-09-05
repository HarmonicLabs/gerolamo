import { describe, expect, test } from "bun:test";
import { blockFrostFetchEpochParams, defaultOnchainappsBase } from "./blockFrostFetchEra";

describe("external epoch source per network", () => {
    test("preview has no fallback mirror; preprod's must not stand in", async () => {
        expect(defaultOnchainappsBase("preview")).toBe("");
        expect(defaultOnchainappsBase("testnet", 2)).toBe("");
        expect(defaultOnchainappsBase("testnet", 1)).toContain("preprod");
        expect(defaultOnchainappsBase("mainnet")).toContain("mainnet");
        await expect(blockFrostFetchEpochParams({ network: "testnet", networkMagic: 2 } as any, 9)).rejects.toThrow(/No external epoch source/);
    });
});
