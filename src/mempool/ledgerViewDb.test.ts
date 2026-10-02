import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { resetRecentOutputs } from "../db/recentOutputs";
import { dbLedgerView } from "./ledgerViewDb";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-mempool-view-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the node-database ledger view", () => {
    test("UTxO lookups go through the read-only connection and see committed rows only", async () => {
        resetRecentOutputs();
        const ref = "ab".repeat(32) + ":1";
        const txOut = { address: "addr_test1qqview", amount: "7000000", assets: { ["cd".repeat(28)]: { "": "3" } }, inline_datum: "d87980" };
        await sql`INSERT INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace) VALUES (${ref}, ${JSON.stringify(txOut)}, ${"ab".repeat(32)}, ${txOut.address}, 7000000)`;
        const view = dbLedgerView({ network: "preview" });
        const m = await view.resolve([ref, "ee".repeat(32) + ":0"]);
        expect([...m.keys()]).toEqual([ref]);
        const u = m.get(ref)!;
        expect(u.address).toBe("addr_test1qqview");
        expect(u.value.get("lovelace")).toBe(7_000_000n);
        expect(u.value.get("cd".repeat(28))).toBe(3n);
        expect(u.inlineDatumCbor).toBe("d87980");
        expect(await view.stake([{ hex: "11".repeat(28), type: 0 }])).toEqual({ registered: new Set(), delegated: new Map() });
    });
});
