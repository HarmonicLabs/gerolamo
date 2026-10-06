import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { initSql, sql } from "./sql";
import { applyInvalidTransaction, buildUtxoRowForOutput, ensureInitialized, flushPendingUtxoWrites } from "./db";

// Bug 353: a phase-2-invalid transaction's collateral return was written in its own form
// (no lovelace entry in `assets`, a `collateral_return` flag, datum and reference script dropped);
// a snapshot import writes the same output in the applier's ordinary form.
const dir = mkdtempSync(join(tmpdir(), "gerolamo-collret-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("applyInvalidTransaction", () => {
    test("the collateral return is stored like any output, at index |outputs|", async () => {
        // post-Alonzo output {0: enterprise testnet address, 1: [5 000 000, {policy: {"": 100}}], 2: [1, #6.24(h'd87980')]} — inline datum
        const policy = "ab".repeat(28);
        const hex = `a300581d60${"11".repeat(28)}01821a004c4b40a1581c${policy}a1401864028201d81843d87980`;
        const ret = TxOut.fromCbor(hex);
        const txId = "cd".repeat(32);
        const body: any = { hash: { toString: () => txId }, collateralInputs: [], collateralReturn: ret, outputs: [{}, {}] };
        await applyInvalidTransaction(body, new Uint8Array(32).fill(7));
        await flushPendingUtxoWrites(sql as any);
        const rows = (await sql`SELECT utxo_ref, tx_out, lovelace FROM utxo WHERE tx_hash = ${txId}`.values()) as unknown[][];
        expect(rows.length).toBe(1);
        expect(String(rows[0]![0])).toBe(`${txId}:2`);
        const expected = buildUtxoRowForOutput(txId, 2, ret);
        expect(String(rows[0]![1])).toBe(expected.txOutJson);
        const j = JSON.parse(String(rows[0]![1]));
        expect(j.collateral_return).toBeUndefined();
        expect(j.assets[""]?.[""]).toBe("5000000");
        expect(j.assets[policy]).toEqual({ "": "100" });
        expect(j.inline_datum).toBeDefined();
        expect(String(rows[0]![2])).toBe("5000000");
    });
});

describe("poolMarginOf (bug 354)", () => {
    test("a certificate's margin is kept reduced, as the ledger's Ratio", async () => {
        const { CborPositiveRational } = await import("@harmoniclabs/cbor");
        const { poolMarginOf } = await import("./db");
        expect(poolMarginOf(new CborPositiveRational(0, 1000000))).toEqual([0n, 1n]); // preview pool 6954ec11…
        expect(poolMarginOf(new CborPositiveRational(3, 40))).toEqual([3n, 40n]);
        expect(poolMarginOf(new CborPositiveRational(50, 1000))).toEqual([1n, 20n]);
        expect(poolMarginOf(undefined)).toEqual([0n, 1n]);
    });
});
