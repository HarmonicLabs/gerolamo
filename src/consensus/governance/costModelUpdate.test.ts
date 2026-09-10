import { describe, expect, test } from "bun:test";
import { costModelsOfProposal, mergeCostModels } from "./costModelUpdate";
import koios736 from "../__fixtures__/preview-costmodels-736.json";

// Preview block at slot 63146776 (epoch 730), tx 0: the ParameterChange action enacted at
// epoch 736 that grew PlutusV3 to 297 entries (four of them negative). Compared with the
// Koios record of the epoch 736 parameters.
describe("cost models of a ParameterChange action", () => {
    test("the raw body bytes yield the V3 list Koios reports for epoch 736", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-63146776.hex", import.meta.url)).text()).trim(), "hex");
        const { Cbor, CborUInt } = await import("@harmoniclabs/cbor");
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const body = root.array[1].array[0];
        const ref: any = body.subCborRef ?? body.cborRef;
        const bodyBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(body).toBuffer();
        const cm = costModelsOfProposal(bodyBytes, 0);
        expect(cm).not.toBeNull();
        expect(Object.keys(cm!)).toEqual(["PlutusV3"]);
        expect(cm!.PlutusV3!.length).toBe(297);
        expect(cm!.PlutusV3!.filter((x) => x < 0).length).toBe(4);
        expect(cm!.PlutusV3).toEqual((koios736 as any).PlutusV3);
        expect(costModelsOfProposal(bodyBytes, 1)).toBeNull();
    });

    test("merge replaces only the named languages", () => {
        const prev = { PlutusV1: [1, 2], PlutusV2: [3], PlutusV3: [4] };
        const merged = mergeCostModels(prev, { PlutusV3: [9, 9] });
        expect(merged).toEqual({ PlutusV1: [1, 2], PlutusV2: [3], PlutusV3: [9, 9] });
        expect(mergeCostModels(undefined, { PlutusV2: [1] })).toEqual({ PlutusV2: [1] });
        expect(mergeCostModels(prev, null)).toEqual(prev);
    });
});

import { Cbor, CborArray } from "@harmoniclabs/cbor";
import { readFileSync } from "node:fs";
import { paramChangesOfProposal } from "./costModelUpdate";

const bodyBytesOfTx = (name: string) => {
    const tx = Cbor.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8").trim()) as CborArray;
    return Cbor.encode(tx.array[0]!).toBuffer();
};

describe("paramChangesOfProposal (bug 66: every Conway parameter change is read from the bytes)", () => {
    test("execution-unit limits (preview action 69c948cd…:0, enacted at epoch 1096)", () => {
        expect(paramChangesOfProposal(bodyBytesOfTx("preview-proposal-69c948cd.tx.hex"), 0)).toEqual({
            max_tx_ex_mem: "16500000", max_tx_ex_steps: "10000000000", max_block_ex_mem: "72000000", max_block_ex_steps: "20000000000",
        });
    });
    test("committee_min_size (preview action 602d8572…:0, enacted at epoch 999)", () => {
        expect(paramChangesOfProposal(bodyBytesOfTx("preview-proposal-602d8572.tx.hex"), 0)).toEqual({ committee_min_size: 3 });
    });
    test("drep_activity (preview action 35b81b42…:0, enacted at epoch 964)", () => {
        expect(paramChangesOfProposal(bodyBytesOfTx("preview-proposal-35b81b42.tx.hex"), 0)).toEqual({ drep_activity: 31 });
    });
});
