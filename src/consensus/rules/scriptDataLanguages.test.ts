import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborUInt } from "@harmoniclabs/cbor";
import { scriptDataLanguages } from "./alonzoRules";
import { costModelArrays, expectedScriptDataHash } from "./scriptDataHash";

// Preview block at slot 68390403 (epoch 791, protocol 10): a PlutusV3 spend whose reference
// inputs also carry an unrelated PlutusV2 reference script. The language view covers only
// the needed script (V3); adding V2 changed the hash and halted the node (bug 61).
describe("script data hash languages", () => {
    test("only needed scripts contribute a language", () => {
        const langs = new Map<string, 1 | 2 | 3>([["aa", 3], ["bb", 2]]);
        expect([...scriptDataLanguages(new Set(["aa"]), langs, {}, {}, new Map())]).toEqual([3]);
        expect([...scriptDataLanguages(new Set(["aa", "bb"]), langs, {}, {}, new Map())].sort()).toEqual([2, 3]);
        expect([...scriptDataLanguages(new Set(), langs, {}, {}, new Map())]).toEqual([]);
        // legacy fallback without a language map: witness-set scripts
        expect([...scriptDataLanguages(new Set(), undefined, { plutusV2Scripts: [{}] }, {}, new Map())]).toEqual([2]);
    });

    test("the V3-only view reproduces the block's script_data_hash; V2+V3 does not", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-68390403.hex", import.meta.url)).text()).trim(), "hex");
        const raw = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-params-791.json", import.meta.url)).text());
        const m: any = MultiEraBlock.fromCbor(blk);
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[0];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        const models = costModelArrays(raw);
        const actual = String(m.block.transactionBodies[0].scriptDataHash.toString());
        expect(expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: new Set([3] as any), models, alonzoForm: false }).hash).toBe(actual);
        expect(expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: new Set([2, 3] as any), models, alonzoForm: false }).hash).not.toBe(actual);
        expect((m.block.transactionBodies[0].refInputs ?? []).length).toBe(11);
    });

    // Preview block at slot 68911489 (epoch 797): tx 1 submits a governance proposal; the only
    // script it runs is the PlutusV3 guardrail policy script (redeemer purpose 5, proposing),
    // which the first version of the needed-script set did not model ("languages none").
    test("a proposing redeemer needs the proposal's policy script", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-68911489.hex", import.meta.url)).text()).trim(), "hex");
        const raw = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-params-797.json", import.meta.url)).text());
        const m: any = MultiEraBlock.fromCbor(blk);
        const body = m.block.transactionBodies[1];
        const policy = String(body.proposalProcedures[0].govAction.policyHash?.toString?.() ?? "").toLowerCase();
        expect(policy.length).toBe(56);
        const langs = new Map<string, 1 | 2 | 3>([[policy, 3]]);
        const ws = m.block.transactionWitnessSets[1];
        const needed = new Set<string>([policy]);
        expect([...scriptDataLanguages(needed, langs, ws, body, new Map())]).toEqual([3]);
        // unknown purpose fallback: no needed hash recognised but redeemers present → witness-set languages
        expect([...scriptDataLanguages(new Set(), langs, ws, body, new Map())]).toEqual([3]);
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const wsRoot = root.array[2].array[1];
        const ref: any = wsRoot.subCborRef ?? wsRoot.cborRef;
        const wsBytes: Uint8Array = ref.toBuffer();
        const actual = String(body.scriptDataHash.toString());
        expect(expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: new Set([3] as any), models: costModelArrays(raw), alonzoForm: false }).hash).toBe(actual);
    });
});
