import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

// Preview block at slot 64848165 (epoch 750): an UpdateCommittee action whose threshold is the
// unit interval 6/19 (tag 30). ledger-ts required a CborPositiveRational instance and rejected
// the whole block as undecodable (bug 60).
describe("Conway governance actions decode", () => {
    test("update_committee with a tag-30 threshold", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-64848165.hex", import.meta.url)).text()).trim(), "hex");
        const m: any = MultiEraBlock.fromCbor(blk);
        const pps: any[] = m.block.transactionBodies[0].proposalProcedures ?? [];
        expect(pps.length).toBe(5);
        const a = pps[0].govAction;
        expect(Number(a.govActionType)).toBe(4);
        expect(a.threshold?.constructor?.name).toBe("CborPositiveRational");
        expect(Number(a.threshold.num)).toBe(6);
        expect(Number(a.threshold.den)).toBe(19);
        expect(a.toAdd.length).toBe(3);
        expect(a.toRemove.length).toBe(0);
    });
});
