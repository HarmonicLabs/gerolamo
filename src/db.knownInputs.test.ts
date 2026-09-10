/**
 * The applier spends from the UTxO rows the rules stage already read (`knownInputs`)
 * and reads only the refs it lacks from the database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import { ensureInitialized, loadSpentRows, spentInputRefs } from "./db";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-known-"));
const H = "ab".repeat(32);
beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    // stake keys set: the stake_balance triggers fire on these rows, which must not disturb the strict delete check
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, stake_key) VALUES (${`${H}:0`}, ${'{"address":"addr_test1a","amount":"5"}'}, ${H}, ${"addr_test1a"}, ${5}, ${"aa".repeat(28)})`;
    await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, stake_key) VALUES (${`${H}:1`}, ${'{"address":"addr_test1b","amount":"7"}'}, ${H}, ${"addr_test1b"}, ${7}, ${"bb".repeat(28)})`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadSpentRows", () => {
    test("known rows are used as given and only the missing refs hit the database", async () => {
        const known = new Map([[`${H}:0`, { utxo_ref: `${H}:0`, tx_out: '{"address":"addr_test1a","amount":"5"}', tx_hash: H, address: "addr_test1a" }]]);
        const rows = await loadSpentRows(sql, [`${H}:0`, `${H}:1`, `${H}:9`], known);
        expect(rows.map((r) => r.utxo_ref).sort()).toEqual([`${H}:0`, `${H}:1`]);
        expect(rows.find((r) => r.utxo_ref === `${H}:1`)?.address).toBe("addr_test1b");
    });
    test("without known rows every ref comes from the database", async () => {
        const rows = await loadSpentRows(sql, [`${H}:1`]);
        expect(rows).toEqual([{ utxo_ref: `${H}:1`, tx_out: '{"address":"addr_test1b","amount":"7"}', tx_hash: H, address: "addr_test1b" }]);
    });
    test("a known row for a ref the database no longer holds is still returned (the delete count catches it)", async () => {
        const known = new Map([[`${H}:9`, { utxo_ref: `${H}:9`, tx_out: null, tx_hash: null, address: null }]]);
        const rows = await loadSpentRows(sql, [`${H}:9`], known);
        expect(rows.length).toBe(1);
    });
});

describe("spentInputRefs", () => {
    test("a repeated input (pre-Conway list encoding) is spent once", () => {
        const inp = (i: number) => ({ utxoRef: { id: { toString: () => H }, index: i } });
        expect(spentInputRefs({ inputs: [inp(0), inp(1), inp(0)] })).toEqual([`${H}:0`, `${H}:1`]);
    });
});
