import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

// Preview block at slot 51361220 (Babbage): tx[2]'s mint map lists each of its two
// policies twice (same asset, quantity 1). cardano-node's decoder builds a Map, so the
// later entry replaces the earlier one; ledger-ts rejected the duplicate and the block
// could not be parsed at all (bug 52).
describe("mint with duplicate policy keys decodes like the Haskell ledger", () => {
    test("the block parses and the duplicates collapse to the last entry per policy", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/preview-block-51361220.hex", import.meta.url)).text()).trim();
        const m: any = MultiEraBlock.fromCbor(Uint8Array.from(Buffer.from(hex, "hex")));
        expect(m.block.transactionBodies.length).toBe(4);
        const mint = m.block.transactionBodies[2].mint;
        expect(mint).toBeDefined();
        const policies = (mint.map as any[]).filter((e) => e.policy !== "").map((e) => e.policy.toString());
        expect(policies).toEqual(["154d847a8142a56e351988e36051324b5ee5318bd24a6dd81f8b275a", "52c6af0c9b744b4eecce838538a52ceb155038b3de68e2bb2fa8fc37"]);
        for (const e of mint.map as any[]) if (e.policy !== "") { expect(e.assets.length).toBe(1); expect(String(e.assets[0].quantity)).toBe("1"); }
        // empty mints (tx[0], tx[1]) decode too
        expect(m.block.transactionBodies[0].mint).toBeDefined();
    });
});
