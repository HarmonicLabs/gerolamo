import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { extractLedgerTxOutMetadata, scriptHashOfWrapped, txOutMetadataFromCbor } from "./txOutMetadata";

describe("tx output metadata from CBOR", () => {
    test("inline datums of a real Babbage block are kept (preprod slot 10930253)", async () => {
        const hex = (await Bun.file(new URL("../../consensus/__fixtures__/preprod-block-10930253.hex", import.meta.url)).text()).trim();
        const b: any = (MultiEraBlock.fromCbor(new Uint8Array(Buffer.from(hex, "hex"))) as any).block;
        const outs = b.transactionBodies[0].outputs;
        expect(extractLedgerTxOutMetadata(outs[0]).inlineDatumCbor).toBeNull();
        const m2 = extractLedgerTxOutMetadata(outs[2]);
        expect(m2.inlineDatumCbor).toMatch(/^d8799f|^d87[9a-f]/);
        expect(m2.datumHash).toBeNull();
        expect(extractLedgerTxOutMetadata(outs[3]).inlineDatumCbor).not.toBeNull();
    });
    test("datum hash forms: map [0, hash] and legacy array", () => {
        const hash = "ab".repeat(32);
        // {0: bytes(addr), 1: 5, 2: [0, hash]}
        const map = Buffer.from("a3" + "00" + "41aa" + "01" + "05" + "02" + "82" + "00" + "5820" + hash, "hex");
        expect(txOutMetadataFromCbor(map)!.datumHash).toBe(hash);
        const arr = Buffer.from("83" + "41aa" + "05" + "5820" + hash, "hex");
        expect(txOutMetadataFromCbor(arr)!.datumHash).toBe(hash);
    });
    test("reference script: hash prefixes the language tag", () => {
        // [2, bytes(0x4d01000033)] → blake2b_224(0x02 ‖ 4d01000033)
        const wrapped = Buffer.from("8202454d01000033", "hex");
        const h = scriptHashOfWrapped(wrapped);
        expect(h).toMatch(/^[0-9a-f]{56}$/);
        const map = Buffer.from("a3" + "00" + "41aa" + "01" + "05" + "03" + "d818" + "48" + "8202454d01000033", "hex");
        const m = txOutMetadataFromCbor(map)!;
        expect(m.scriptRefHash).toBe(h);
        expect(m.scriptRefCbor).toBe("8202454d01000033");
    });
});
