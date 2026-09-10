import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborUInt } from "@harmoniclabs/cbor";
import { costModelArrays, expectedScriptDataHash, languageViews } from "./scriptDataHash";

// Preview block at slot 55870734 (Conway, epoch 646): the first PlutusV3 transaction. The
// language view must carry the V3 cost model exactly as the protocol parameters do (251
// entries at protocol 9); the cost-models library padded it to 350 and the hash differed (bug 54).
describe("script data hash with a PlutusV3 script", () => {
    test("V3 language view uses the 251-entry list and the hash matches the body", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-55870734.hex", import.meta.url)).text()).trim(), "hex");
        const raw = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-params-646.json", import.meta.url)).text());
        const m: any = MultiEraBlock.fromCbor(blk);
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[0];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        const models = costModelArrays(raw);
        expect(models[3]!.length).toBe(251);
        const lv = languageViews(models, new Set([3] as any))!;
        expect(Buffer.from(lv).toString("hex").startsWith("a10298fb")).toBe(true); // {2: array(251)}
        const expected = String(m.block.transactionBodies[0].scriptDataHash.toString());
        expect(expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: new Set([3] as any), models, alonzoForm: false }).hash).toBe(expected);
        // V2 still encodes its 175 entries; V1 keeps the legacy bytes-key form
        expect(Buffer.from(languageViews(models, new Set([2] as any))!).toString("hex").startsWith("a10198af")).toBe(true);
        expect(Buffer.from(languageViews(models, new Set([1] as any))!).toString("hex").startsWith("a14100")).toBe(true);
    });
});
