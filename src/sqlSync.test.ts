import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncSqlClient, type SyncSqlClient } from "./sqlSync";

const dir = mkdtempSync(join(tmpdir(), "sqlsync-"));
let sql: SyncSqlClient;

beforeAll(async () => {
    sql = createSyncSqlClient(join(dir, "t.db"));
    await sql`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER, blob BLOB)`;
});
afterAll(async () => { await sql.close(); rmSync(dir, { recursive: true, force: true }); });

describe("sync SQL client", () => {
    test("template params, object rows and positional rows", async () => {
        await sql`INSERT INTO t (id, name, amount, blob) VALUES (${1}, ${"a"}, ${10n}, ${new Uint8Array([1, 2])})`;
        const rows = await sql`SELECT id, name, amount, blob FROM t WHERE id = ${1}`;
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe("a");
        expect(Number(rows[0].amount)).toBe(10);
        expect(new Uint8Array(rows[0].blob)).toEqual(new Uint8Array([1, 2]));
        const vals = await sql`SELECT id, name FROM t WHERE id = ${1}`.values();
        expect(vals).toEqual([[1, "a"]]);
    });
    test("IN-list and multi-row expansion", async () => {
        await sql`INSERT INTO t (id, name, amount) VALUES ${sql([[2, "b", 20], [3, "c", 30]])}`;
        const vals = await sql`SELECT id FROM t WHERE id IN ${sql([2, 3, 99])} ORDER BY id`.values();
        expect(vals).toEqual([[2], [3]]);
        expect(await sql`SELECT id FROM t WHERE id IN ${sql([])}`.values()).toEqual([]);
        // long lists bind as one JSON parameter (single statement text for every length)
        const long = Array.from({ length: 300 }, (_, i) => i + 1000);
        await sql`INSERT INTO t (id, name) VALUES ${sql(long.slice(0, 3).map((i) => [i, "x"]))}`;
        expect(await sql`SELECT id FROM t WHERE id IN ${sql(long)} ORDER BY id`.values()).toEqual([[1000], [1001], [1002]]);
        expect(await sql`DELETE FROM t WHERE id IN ${sql(long)} RETURNING id`.values()).toHaveLength(3);
    });
    test("RETURNING rows, unsafe with params and multi-statement unsafe", async () => {
        const del = await sql`DELETE FROM t WHERE id IN ${sql([3])} RETURNING id`.values();
        expect(del).toEqual([[3]]);
        const r = await sql.unsafe("SELECT name FROM t WHERE id = ?", [2]);
        expect(r[0].name).toBe("b");
        await sql.unsafe("CREATE TABLE u (x); INSERT INTO u VALUES (7);");
        expect(await sql`SELECT x FROM u`.values()).toEqual([[7]]);
    });
    test("begin commits, rolls back on throw and rejects nesting", async () => {
        await sql.begin(async (tx) => { await tx`INSERT INTO t (id, name) VALUES (${4}, ${"d"})`; expect(sql.inTransaction).toBe(true); });
        expect(await sql`SELECT COUNT(*) AS c FROM t WHERE id = 4`.values()).toEqual([[1]]);
        await expect(sql.begin(async () => { await sql`INSERT INTO t (id, name) VALUES (${5}, ${"e"})`; throw new Error("boom"); })).rejects.toThrow("boom");
        expect(await sql`SELECT COUNT(*) AS c FROM t WHERE id = 5`.values()).toEqual([[0]]);
        await expect(sql.begin(async () => sql.begin(async () => 1))).rejects.toThrow(/within a transaction/);
        expect(sql.inTransaction).toBe(false);
    });
    test("a statement nobody awaits still runs (fire-and-forget)", async () => {
        void sql`INSERT INTO t (id, name) VALUES (${6}, ${"f"})`;
        await new Promise((r) => setTimeout(r, 0));
        expect(await sql`SELECT name FROM t WHERE id = 6`.values()).toEqual([["f"]]);
    });
    test("bigints beyond 64 bits become text, booleans become 0/1", async () => {
        // beyond 64 bits the value is bound as text — into a TEXT column it stays exact (INTEGER affinity would make it a REAL)
        await sql`INSERT INTO t (id, name, amount) VALUES (${7}, ${(1n << 70n)}, ${true})`;
        const [[name, amount]] = await sql`SELECT name, amount FROM t WHERE id = 7`.values();
        expect(String(name)).toBe((1n << 70n).toString());
        expect(Number(amount)).toBe(1);
    });
});
