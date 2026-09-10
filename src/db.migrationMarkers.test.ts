import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";
import { ensureInitialized } from "./db";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-mig-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("one-off migrations on a fresh database", () => {
    test("are recorded as done at creation, so a restart never replays them over the chain (bug 100)", async () => {
        const names = ((await sql`SELECT name FROM schema_migrations`.values()) as unknown[][]).map((r) => String(r[0]));
        for (const m of ["stake_cred_types_rebuilt", "delegations_rebuilt_poolreap", "utxo_byron_addresses_rebuilt", "orphaned_utxo_deltas_reverted", "stake_pointers_built"]) {
            expect(names).toContain(m);
        }
    });
});
