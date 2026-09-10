import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

// Preview block at slot 55835715 (Conway, epoch 646, the first Conway epoch): one transaction
// submits a governance action (body key 20, a tag-258 set of proposal procedures) with the
// 100 000 ADA deposit. ledger-ts left keys 19–22 undecoded, so the deposit never reached the
// value-conservation rule and the block failed with "consumed ≠ produced" by exactly the
// deposit (bug 53).
describe("Conway proposal procedures decode with their deposit", () => {
    test("the body carries the proposal and the deposit", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/preview-block-55835715.hex", import.meta.url)).text()).trim();
        const m: any = MultiEraBlock.fromCbor(Uint8Array.from(Buffer.from(hex, "hex")));
        expect(Number(m.era)).toBe(7);
        const body = m.block.transactionBodies[0];
        expect(Array.isArray(body.proposalProcedures)).toBe(true);
        expect(body.proposalProcedures.length).toBe(1);
        expect(String(body.proposalProcedures[0].deposit)).toBe("100000000000");
        expect(body.proposalProcedures[0].rewardAccount).toBeDefined();
        expect(body.proposalProcedures[0].govAction).toBeDefined();
    });
});
