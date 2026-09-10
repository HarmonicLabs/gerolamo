import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized, loadSpentRows } from "../db";
import { getUtxoRowsByRefs } from "./rulesQueries";
import { recentOutputs, rememberRecentOutput, resetRecentOutputs, spentRowsStats } from "./recentOutputs";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-recent-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rules pre-read and the recent-outputs map", () => {
    test("rows come from the map when present, from SQLite otherwise, and a known hit at apply drops the map entry", async () => {
        resetRecentOutputs();
        const inDb = "aa".repeat(32) + ":0";
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash) VALUES (${inDb}, ${JSON.stringify({ address: "addr_test1db", amount: "5" })}, ${"aa".repeat(32)}, ${"addr_test1db"}, 5, ${"cc".repeat(28)})`;
        const cached = "bb".repeat(32) + ":1";
        rememberRecentOutput({ utxo_ref: cached, tx_out: JSON.stringify({ address: "addr_test1mem", amount: "7" }), tx_hash: "bb".repeat(32), address: "addr_test1mem", reference_script_hash: null });
        const before = spentRowsStats.preread;
        const rows = await getUtxoRowsByRefs([inDb, cached, "dd".repeat(32) + ":9"]);
        expect(rows.map((r) => r.utxo_ref).sort()).toEqual([inDb, cached].sort());
        expect(rows.find((r) => r.utxo_ref === cached)?.address).toBe("addr_test1mem");
        expect(rows.find((r) => r.utxo_ref === inDb)?.reference_script_hash).toBe("cc".repeat(28));
        expect(spentRowsStats.preread - before).toBe(1);
        // apply: the pre-read row is "known"; serving it removes the map entry so a spent output never resurfaces
        const known = new Map(rows.map((r) => [r.utxo_ref, r]));
        const served = await loadSpentRows(sql as any, [cached], known);
        expect(served.length).toBe(1);
        expect(recentOutputs.has(cached)).toBe(false);
    });
});
