import { describe, expect, test } from "bun:test";
import { Cbor, CborUInt } from "@harmoniclabs/cbor";
import { expectedScriptDataHash, witnessSlices } from "./scriptDataHash";

// Preview block at slot 31023089 (epoch 359): the only transaction carries a witness-set
// datum entry encoded as an indefinite-length empty array (`04 9F FF`), no redeemers and no
// script_data_hash. The ledger's nullDats is true for it, so no hash is required (bug 50).
describe("script data hash with an indefinite-length empty datum list", () => {
    test("no script_data_hash is expected", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-31023089.hex", import.meta.url)).text()).trim(), "hex");
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[0];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        const { redeemers, datums } = witnessSlices(wsBytes);
        expect(redeemers).toBeNull();
        expect(Buffer.from(datums!).toString("hex")).toBe("9fff");
        const r = expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: new Set(), models: {}, alonzoForm: true });
        expect(r.hash).toBeNull();
    });

    test("definite and indefinite empty forms both mean no hash; a real datum still needs one", () => {
        const ws = (datumsHex: string) => Uint8Array.from(Buffer.from(`a1 04 ${datumsHex}`.replace(/ /g, ""), "hex"));
        for (const h of ["80", "9fff"]) {
            expect(expectedScriptDataHash({ witnessSetBytes: ws(h), languages: new Set(), models: {}, alonzoForm: true }).hash).toBeNull();
        }
        // one datum (integer 1) → hash required even without redeemers
        expect(expectedScriptDataHash({ witnessSetBytes: ws("8101"), languages: new Set(), models: {}, alonzoForm: true }).hash).not.toBeNull();
        expect(expectedScriptDataHash({ witnessSetBytes: ws("9f01ff"), languages: new Set(), models: {}, alonzoForm: true }).hash).not.toBeNull();
    });
});
