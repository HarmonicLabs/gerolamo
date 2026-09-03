import { describe, expect, test } from "bun:test";
import { Hash32, Script } from "@harmoniclabs/cardano-ledger-ts";
import { DataConstr, dataToCbor } from "@harmoniclabs/plutus-data";
import { toHex } from "@harmoniclabs/uint8array-utils";
import {
    extractLedgerTxOutMetadata,
    parseStoredTxOut,
    storedTxOutContainsAsset,
} from "./txOutMetadata";

describe("MiniBF transaction-output metadata", () => {
    test("preserves inline datum and reference script from live ledger outputs", () => {
        const datum = new DataConstr(0, []);
        const refScript = Script.plutusV2(Uint8Array.from([1, 2, 3, 4]));

        const metadata = extractLedgerTxOutMetadata({ datum, refScript });

        expect(metadata.datumHash).toBeNull();
        expect(metadata.inlineDatumCbor).toBe(toHex(dataToCbor(datum).toBuffer()));
        expect(metadata.scriptRefHash).toBe(refScript.hash.toString());
        expect(metadata.scriptRefCbor).toBe(toHex(refScript.cbor));
        expect(metadata.scriptRefCbor).toMatch(/^[0-9a-f]+$/);
    });

    test("preserves datum hashes without treating them as inline data", () => {
        const datum = new Hash32(new Uint8Array(32).fill(7));

        const metadata = extractLedgerTxOutMetadata({ datum });

        expect(metadata.datumHash).toBe(datum.toString());
        expect(metadata.inlineDatumCbor).toBeNull();
    });

    test("derives Blockfrost reference-script fields from Mithril UTxO metadata", () => {
        const refScript = Script.plutusV2(Uint8Array.from([9, 8, 7, 6]));
        const policy = "ab".repeat(28);
        const stored = parseStoredTxOut(JSON.stringify({
            address: "addr_test1qpzexample",
            amount: "5000000",
            assets: { [policy]: { "746f6b656e": "2" } },
            inline_datum: "d87980",
            script_kind: "plutus",
            script_language: 1,
            script_bytes_hex: "09080706",
        }));

        expect(stored.inlineDatumCbor).toBe("d87980");
        expect(stored.scriptRefHash).toBe(refScript.hash.toString());
        expect(stored.scriptRefCbor).toBe(toHex(refScript.cbor));
        expect(stored.scriptRefCbor).toMatch(/^[0-9a-f]+$/);
        expect(storedTxOutContainsAsset(stored, `${policy}746f6b656e`)).toBe(true);
        expect(storedTxOutContainsAsset(stored, `${policy}6d697373696e67`)).toBe(false);
    });
});
