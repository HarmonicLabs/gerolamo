import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { applyMbTx, type MbTxDelta } from "./writer";
import { explorerDbPathFor, explorerIndexer, mbSql } from "./explorerIndexer";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-explorer-"));
const mainDb = join(dir, "ledger.db");
const H = (n: number) => n.toString(16).padStart(64, "0");
const delta = (n: number, slot: number, prev?: number): MbTxDelta => ({
    txHash: H(n), blockHash: new Uint8Array(32).fill(n), slot, txIndex: 0, blockHeight: slot, fee: "1", size: 100,
    addresses: new Map([[`addr_test1_${n}`, "out"]]),
    inputs: prev == null ? [] : [{ inputIndex: 0, prevTxHash: H(prev), prevOutputIndex: 0 }],
    outputs: [{ outputIndex: 0, address: `addr_test1_${n}`, lovelace: "5000000" }],
});

beforeAll(async () => {
    initSql(mainDb);
    await ensureInitialized();
    // history written inline into the ledger DB before the worker existed
    await applyMbTx(sql as any, delta(1, 10));
    await applyMbTx(sql as any, delta(2, 20, 1));
});
afterAll(async () => { await explorerIndexer.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("explorer indexer worker", () => {
    test("migrates history, applies new deltas in order, marks spends across the switch, rolls back", async () => {
        const path = explorerDbPathFor(mainDb);
        expect(path).toBe(join(dir, "ledger.explorer.db"));
        await explorerIndexer.start(path, mainDb);
        expect(existsSync(path)).toBe(true);
        // new transactions after the switch: tx 3 spends tx 2's output (a migrated row)
        await explorerIndexer.enqueue(delta(3, 30, 2));
        await explorerIndexer.enqueue(delta(4, 40, 3));
        await explorerIndexer.flush();
        // wait for the background migration to finish (it repairs spent marks at the end)
        for (let i = 0; i < 200 && explorerIndexer.migrating; i++) await new Promise((r) => setTimeout(r, 50));
        expect(explorerIndexer.migrating).toBe(false);
        const mb = mbSql();
        const txs = (await mb`SELECT tx_hash, slot FROM mb_tx ORDER BY slot`.values()) as unknown[][];
        expect(txs.map((r) => Number(r[1]))).toEqual([10, 20, 30, 40]);
        const spent = (await mb`SELECT tx_hash, spent_by_tx FROM mb_tx_out ORDER BY tx_hash`.values()) as unknown[][];
        expect(spent.map((r) => [String(r[0]).slice(-1), r[1] == null ? null : String(r[1]).slice(-1)])).toEqual([["1", "2"], ["2", "3"], ["3", "4"], ["4", null]]);
        // rollback to slot 25: txs 3 and 4 vanish, tx 2's output is unspent again
        explorerIndexer.rollback(25);
        await explorerIndexer.flush();
        const after = (await mb`SELECT COUNT(*) FROM mb_tx`.values()) as unknown[][];
        expect(Number(after[0]![0])).toBe(2);
        const o2 = (await mb`SELECT spent_by_tx FROM mb_tx_out WHERE tx_hash = ${H(2)}`.values()) as unknown[][];
        expect(o2[0]![0]).toBeNull();
        expect(explorerIndexer.tipSlot).toBe(25);
    });
});
