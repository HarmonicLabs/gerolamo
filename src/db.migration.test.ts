import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import { applyCertificates, ensureInitialized, getDelegationsByCredentials, getStakeByCredentials, getUtxosByAddress } from "./db";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-migration-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("utxo schema migration", () => {
    beforeAll(async () => {
        initSql(join(dir, "old.db"));
        // The pre-side-column shape, with one row written the old way.
        await sql`CREATE TABLE utxo (utxo_ref BLOB, tx_out JSONB, tx_hash TEXT, PRIMARY KEY (utxo_ref))`;
        const txOut = JSON.stringify({ address: "addr_test1old", amount: "42", assets: {}, reference_script_hash: "AB".repeat(28) });
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash) VALUES (${"aa".repeat(32) + ":0"}, ${txOut}, ${"aa".repeat(32)})`;
        await ensureInitialized();
    });

    test("adds the indexed side columns and backfills them from the JSON", async () => {
        const cols = ((await sql`PRAGMA table_info(utxo)`.values()) as unknown[][]).map((r) => String(r[1]));
        expect(cols).toEqual(expect.arrayContaining(["address", "lovelace", "reference_script_hash"]));
        const rows = await getUtxosByAddress("addr_test1old");
        expect(rows).toHaveLength(1);
        const [[lovelace, ref]] = (await sql`SELECT lovelace, reference_script_hash FROM utxo`.values()) as unknown[][];
        expect(Number(lovelace)).toBe(42);
        expect(String(ref)).toBe("ab".repeat(28));
    });
});

describe("applyCertificates follows the validator's certificate table", () => {
    const cred = (b: number) => new Uint8Array(28).fill(b);
    const pool = (b: number) => new Uint8Array(28).fill(b);
    const cert = (certType: number, c: number, p?: number) => ({
        certType,
        stakeCredential: { hash: { toBuffer: () => cred(c) } },
        ...(p != null ? { poolKeyHash: { toBuffer: () => pool(p) } } : {}),
    });
    const blockHash = new Uint8Array(32).fill(7);

    test("Conway registration/delegation forms write stake and delegations like the Shelley ones", async () => {
        await applyCertificates([cert(7, 1), cert(11, 2, 9), cert(13, 3, 9), cert(12, 4)], blockHash);
        expect((await getStakeByCredentials([cred(1), cred(2), cred(3), cred(4)])).length).toBe(4);
        const del = await getDelegationsByCredentials([cred(2), cred(3), cred(1)]);
        expect(del.length).toBe(2);
        await applyCertificates([cert(10, 1, 5)], blockHash); // stake+vote delegation of a registered key
        expect((await getDelegationsByCredentials([cred(1)])).length).toBe(1);
        await applyCertificates([cert(8, 2)], blockHash); // Conway unreg clears both tables
        expect((await getStakeByCredentials([cred(2)])).length).toBe(0);
        expect((await getDelegationsByCredentials([cred(2)])).length).toBe(0);
        await applyCertificates([cert(9, 3)], blockHash); // vote delegation only: no stake-table effect
        expect((await getStakeByCredentials([cred(3)])).length).toBe(1);
    });
});
