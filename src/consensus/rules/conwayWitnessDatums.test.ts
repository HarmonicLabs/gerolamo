import { describe, expect, test } from "bun:test";
import { Cbor, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { witnessDatumBytes, witnessScriptHashes } from "./scriptDataHash";
import { effectiveRedeemers } from "./alonzoRules";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";

// Preview block at slot 57454191 (Conway, epoch 664), tx 1 spends a PlutusV2 output whose
// datum hash is d9c38f56…; the witness set carries the datum inside a tag-258 set, which
// the datum slicer read as an empty list, so the block was rejected (bug 56).
describe("witness datums wrapped in the Conway set tag", () => {
    test("witnessDatumBytes unwraps tag 258 and the datum hashes to the spent output's datum hash", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-57454191.hex", import.meta.url)).text()).trim(), "hex");
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[1];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        expect(wsBytes.length).toBeGreaterThan(0);
        const datums = witnessDatumBytes(wsBytes);
        expect(datums).not.toBeNull();
        expect(datums!.length).toBe(1);
        expect(Buffer.from(blake2b_256(datums![0]!)).toString("hex")).toBe("d9c38f56d9147ba5ce4a0b52456ef4594c46992b74051e462ab8275845345e98");
    });

    // Preview block at slot 58809651 (epoch 680), tx 1: a PlutusV3 script (witness key 7) spends an
    // output that carries no datum, which Conway allows (CIP-69); the rule rejected it (bug 57).
    test("a PlutusV3 witness script is reported with language 3", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-58809651.hex", import.meta.url)).text()).trim(), "hex");
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[1];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        const scripts = witnessScriptHashes(wsBytes);
        const v3 = scripts.get("fbf4d12e6d5a0c1382276b6fe3be09217c5652e9cec2d28be51ff2ef");
        expect(v3?.kind).toBe("plutus");
        expect(v3?.language).toBe(3);
    });

    // Preview block at slot 61206431 (epoch 708), tx 1: the legacy list form carries the reward
    // redeemer 3:0 twice; the ledger decodes the list with Map.fromList and the chain accepted it (bug 58).
    test("a duplicated list-form redeemer collapses to one under Conway", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-61206431.hex", import.meta.url)).text()).trim(), "hex");
        const m: any = MultiEraBlock.fromCbor(blk);
        const rs: any[] = m.block.transactionWitnessSets[1].redeemers ?? [];
        expect(rs.length).toBe(2);
        expect(rs.map((r) => `${Number(r.tag)}:${Number(r.index)}`)).toEqual(["3:0", "3:0"]);
        expect(effectiveRedeemers(rs, 7).length).toBe(1);
    });
});
