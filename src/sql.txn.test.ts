import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "./sql";

/**
 * The applier wraps each range in `sql.begin` while apply* keep writing through the
 * shared `sql` handle. These tests pin the Bun SQLite behaviour that makes that
 * correct: statements on the outer handle run inside the open transaction (and roll
 * back with it), and a second `begin` on the same connection is an error rather
 * than a silent nested transaction (hence the orchestrator's dbMutations queue).
 */
const dir = mkdtempSync(join(tmpdir(), "gerolamo-sql-txn-"));

beforeAll(async () => {
    initSql(join(dir, "txn.db"));
    await sql`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const count = async () => Number(((await sql`SELECT count(*) AS c FROM t`.values()) as any[])[0][0]);

describe("shared sql handle inside sql.begin", () => {
    test("outer-handle writes join the transaction and roll back with it", async () => {
        await expect(sql.begin(async (tx) => {
            await tx`INSERT INTO t (v) VALUES ('tx')`;
            await sql`INSERT INTO t (v) VALUES ('outer')`;
            expect(await count()).toBe(2); // visible inside
            throw new Error("abort range");
        })).rejects.toThrow("abort range");
        expect(await count()).toBe(0);
    });

    test("outer-handle writes commit with the transaction", async () => {
        await sql.begin(async (tx) => {
            await tx`INSERT INTO t (v) VALUES ('tx')`;
            await sql`INSERT INTO t (v) VALUES ('outer')`;
        });
        expect(await count()).toBe(2);
    });

    test("a concurrent second begin on the same connection throws (needs serialising)", async () => {
        const a = sql.begin(async (tx) => {
            await tx`INSERT INTO t (v) VALUES ('a')`;
            await new Promise((r) => setTimeout(r, 50));
        });
        const b = sql.begin(async (tx) => {
            await tx`INSERT INTO t (v) VALUES ('b')`;
        });
        await expect(b).rejects.toThrow(/within a transaction/);
        await a;
    });
});
