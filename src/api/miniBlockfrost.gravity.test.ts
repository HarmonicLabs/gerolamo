import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { initSql, sql } from "../sql";
import { BACKFILL_UTXO_COLUMNS_SQL, ensureInitialized } from "../db";
import { handleMiniBlockfrost } from "./miniBlockfrost";
import { bech32Encode } from "../db/stakeCred";

const tempDir = mkdtempSync(join(tmpdir(), "gerolamo-minibf-gravity-"));
// a well-formed testnet base address (payment key 0x11…, stake key 0x22…): Blockfrost validates the path
const address = bech32Encode("addr_test", Uint8Array.from([0x00, ...new Array(28).fill(0x11), ...new Array(28).fill(0x22)]));
const policy = "ab".repeat(28);
const assetName = "746f6b656e";
const assetUnit = `${policy}${assetName}`;
const script = Script.plutusV2(Uint8Array.from([9, 8, 7, 6]));

beforeAll(async () => {
    initSql(join(tempDir, "test.db"));
    await ensureInitialized();
    const withAsset = JSON.stringify({
        address,
        amount: "5000000",
        assets: { [policy]: { [assetName]: "2" } },
        inline_datum: "d87980",
        script_kind: "plutus",
        script_language: 1,
        script_bytes_hex: "09080706",
    });
    const withoutAsset = JSON.stringify({
        address,
        amount: "3000000",
        assets: {},
    });
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (${"11".repeat(32) + ":0"}, ${withAsset}, ${"11".repeat(32)})`;
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (${"22".repeat(32) + ":1"}, ${withoutAsset}, ${"22".repeat(32)})`;
    await sql.unsafe(BACKFILL_UTXO_COLUMNS_SQL);
});

afterAll(() => {
    try {
        void (sql as any).close?.();
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe("MiniBF Gravity provider routes", () => {
    test("filters address UTxOs by asset and exposes datum/reference-script metadata", async () => {
        const url = new URL(`http://localhost/api/v0/addresses/${address}/utxos/${assetUnit}?count=100&page=1`);
        const response = await handleMiniBlockfrost(new Request(url), url, { network: "preprod" });

        expect(response?.status).toBe(200);
        const body = await response!.json() as any[];
        expect(body).toHaveLength(1);
        expect(body[0].amount).toContainEqual({ unit: assetUnit, quantity: "2" });
        expect(body[0].inline_datum).toBe("d87980");
        expect(body[0].reference_script_hash).toBe(script.hash.toString());
    });

    test("returns Blockfrost script CBOR for reference scripts in the current UTxO set", async () => {
        const url = new URL(`http://localhost/api/v0/scripts/${script.hash.toString()}/cbor`);
        const response = await handleMiniBlockfrost(new Request(url), url, { network: "preprod" });

        expect(response?.status).toBe(200);
        expect(await response!.json()).toEqual({ cbor: toHex(script.cbor) });
    });
});
