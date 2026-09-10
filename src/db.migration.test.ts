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

describe("certificate order within one transaction", () => {
    const hex28 = (b: number) => b.toString(16).padStart(2, "0").repeat(28);
    const credObj = (b: number) => ({ type: 0, hash: { toBuffer: () => new Uint8Array(28).fill(b), toString: () => hex28(b) } });
    const blockHash = new Uint8Array(32).fill(9);
    const ctx = { slot: 60215405, epoch: 696, txIndex: 0 };

    test("deregister, register, vote-delegate in one tx keeps the new DRep delegation (bug 103: preview tx 190fdc6e…)", async () => {
        const DREP = "3d".repeat(28);
        await applyCertificates([{ certType: 0, stakeCredential: credObj(0x2a) }], blockHash, undefined, ctx);
        await applyCertificates([
            { certType: 1, stakeCredential: credObj(0x2a) },
            { certType: 0, stakeCredential: credObj(0x2a) },
            { certType: 9, stakeCredential: credObj(0x2a), drep: { drepType: 0, hash: { toString: () => DREP } } },
        ], blockHash, undefined, ctx);
        expect((await getStakeByCredentials([new Uint8Array(28).fill(0x2a)])).length).toBe(1);
        const rows = (await sql`SELECT drep_hash FROM gov_drep_delegations WHERE stake_key = ${hex28(0x2a)}`.values()) as unknown[][];
        expect(rows.map((r) => String(r[0]))).toEqual([DREP]);
    });
});
