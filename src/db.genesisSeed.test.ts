import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import { ensureInitialized, SNAPSHOT_UTXO_MARKER, seedGenesisUtxosIfMissing } from "./db";

// Bug 350: the Byron genesis output was re-seeded into a snapshot-imported ledger.
const dir = mkdtempSync(join(tmpdir(), "gerolamo-genesis-seed-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const genesis = [{ utxoRef: "4843cf2e582b2f9ce37600e5ab4cc678991f988f8780fed05407f9537f7712bd:0", txId: "4843cf2e582b2f9ce37600e5ab4cc678991f988f8780fed05407f9537f7712bd", address: "FHnt4NL7yPXvDWHa8bVs73UEUdJd64VxWXSFNqetECtYfTd9TtJguJ14Lu3feth", lovelace: 30_000_000_000_000_000n }];
const count = async () => Number((((await sql`SELECT COUNT(*) FROM utxo`.values()) as unknown[][])[0]![0]));

describe("seedGenesisUtxosIfMissing", () => {
    test("seeds nothing on a ledger whose UTxO set was imported from a snapshot", async () => {
        await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${SNAPSHOT_UTXO_MARKER})`;
        const r = await seedGenesisUtxosIfMissing(genesis);
        expect(r.inserted).toBe(0);
        expect(r.skipped).toContain("snapshot");
        expect(await count()).toBe(0);
    });
    test("seeds the genesis outputs of a from-genesis ledger", async () => {
        await sql`DELETE FROM schema_migrations WHERE name = ${SNAPSHOT_UTXO_MARKER}`;
        const r = await seedGenesisUtxosIfMissing(genesis);
        expect([r.inserted, r.skipped]).toEqual([1, undefined]);
        expect(await count()).toBe(1);
    });
});
