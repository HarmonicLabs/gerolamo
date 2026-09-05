import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { effectiveRedeemers } from "./alonzoRules";

// Preview block at slot 12925989, tx 0: the same mint redeemer listed six times
// (3 322 788 memory units each). Pre-Conway the last one wins; summing all six
// (19 936 728) breached the 14 000 000 limit and halted the sync.
describe("effective redeemers before Conway", () => {
    test("duplicates collapse to one per purpose; totals use the effective set", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/preview-block-12925989.hex", import.meta.url)).text()).trim();
        const m: any = MultiEraBlock.fromCbor(Buffer.from(hex, "hex"));
        const raw: any[] = m.block.transactionWitnessSets[0].redeemers ?? [];
        expect(raw.length).toBe(6);
        const eff = effectiveRedeemers(raw, 6);
        expect(eff.length).toBe(1);
        expect(BigInt(eff[0].execUnits.mem)).toBe(3_322_788n);
        expect(effectiveRedeemers(raw, 7).length).toBe(6);
    });
});
