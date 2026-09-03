import { describe, expect, test } from "bun:test";
import { Address, Script } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { txOutToDbRow } from "./streamTablesToUtxo";
import type { TxOutDecoded } from "./utxohdMemCodec";

const ADDRESS = "addr_test1xzcpgglwzxu6yurx8jpfer3k99pf63kdcjkw6kszpef0k0tsg224ylygtstgjxzf33crd7ey9zhsxtg2yj7altgapmfqzd50v5";

describe("Mithril UTxO reference-script projection", () => {
    test("stores a directly indexable reference-script hash and CBOR", () => {
        const scriptBytes = Uint8Array.from([1, 2, 3, 4]);
        const script = Script.plutusV3(scriptBytes);
        const output: TxOutDecoded = {
            tag: 5,
            variant: "TxOutCompactRefScript",
            addrRaw: Uint8Array.from(Address.fromString(ADDRESS).toBytes()),
            addr: null,
            value: { kind: "ada", lovelace: 3_000_000n },
            datum: { kind: "noDatum" },
            script: { kind: "plutus", language: 2, bytes: scriptBytes },
            fullyConsumed: true,
        };

        const row = txOutToDbRow("ab".repeat(32), 0, output);
        expect(row).not.toBeNull();
        const stored = JSON.parse(row!.txOutJson);
        expect(stored.reference_script_hash).toBe(script.hash.toString());
        expect(stored.reference_script_cbor).toBe(toHex(script.cbor));
    });
});
