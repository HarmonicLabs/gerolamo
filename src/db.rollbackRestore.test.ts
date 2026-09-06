import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import { ensureInitialized, insertBlockVolatile, pendingUtxoWriteCount, rollbackChainTo } from "./db";

// Regression for 2026-09-05: rollbackChainTo restored spent outputs through the
// (now queued) upsertUtxoRow and never flushed, so restored UTxOs never reached
// the table and the re-applied block halted on missing inputs.
const dir = mkdtempSync(join(tmpdir(), "gerolamo-rb-"));
const h = (i: number) => i.toString(16).padStart(64, "0");
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rollbackChainTo restores spent outputs to the utxo table", () => {
    test("a spend delta of a rolled-back block puts the output back, written immediately", async () => {
        for (const [i, slot] of [[1, 100], [2, 200], [3, 300]] as const) {
            await insertBlockVolatile({ slot: BigInt(slot), blockHash: h(i), prevHash: i > 1 ? h(i - 1) : null, blockNo: i, headerData: new Uint8Array([1]), blockData: new Uint8Array([2]) } as any);
        }
        // output created in block 1 (kept) … spent in block 3 (rolled back)
        const ref = `${"ab".repeat(32)}:0`;
        const txOut = JSON.stringify({ address: "addr_test1vqtest", amount: "5000000", assets: {} });
        await sql`INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace) VALUES (${ref}, ${txOut}, ${"ab".repeat(32)}, ${"addr_test1vqtest"}, ${"5000000"})`;
        await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (${Buffer.from(h(3), "hex")}, ${"spend"}, ${JSON.stringify({ utxo_ref: ref, tx_out: txOut, tx_hash: "ab".repeat(32) })})`;
        await sql`DELETE FROM utxo WHERE utxo_ref = ${ref}`;
        // block 3 also created an output that must disappear
        const created = `${"cd".repeat(32)}:0`;
        await sql`INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace) VALUES (${created}, ${txOut}, ${"cd".repeat(32)}, ${"addr_test1vqtest"}, ${"1"})`;
        await sql`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (${Buffer.from(h(3), "hex")}, ${"create"}, ${JSON.stringify({ utxo_ref: created, tx_out: txOut, tx_hash: "cd".repeat(32) })})`;

        const r = await rollbackChainTo(200n);
        expect(r.utxoRestored).toBe(1);
        expect(r.utxoRemoved).toBe(1);
        expect(pendingUtxoWriteCount()).toBe(0); // nothing left queued
        const back = (await sql`SELECT utxo_ref, lovelace FROM utxo WHERE utxo_ref = ${ref}`.values()) as unknown[][];
        expect(back.length).toBe(1);
        expect(String(back[0]![1])).toBe("5000000");
        expect(((await sql`SELECT 1 FROM utxo WHERE utxo_ref = ${created}`.values()) as unknown[][]).length).toBe(0);
        expect(Number(((await sql`SELECT MAX(slot) FROM blocks`.values()) as unknown[][])[0]![0])).toBe(200);
    });
});
