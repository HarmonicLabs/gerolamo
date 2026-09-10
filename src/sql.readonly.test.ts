/**
 * HTTP GET handlers run on a read-only connection (`withReadOnlyConnection`)
 * so they answer while the applier holds a write transaction on the writer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, isReadOnlyContext, sql, withReadOnlyConnection } from "./sql";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-rosql-"));
beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await sql`PRAGMA journal_mode = WAL`;
    await sql`CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)`;
    await sql`INSERT INTO t VALUES ('a', 1)`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("withReadOnlyConnection", () => {
    test("reads the committed snapshot without waiting for an open write transaction", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        // writer: open transaction with an uncommitted update
        const txn = sql.begin(async (tx) => {
            await tx`UPDATE t SET v = 2 WHERE k = 'a'`;
            await gate;
        });
        await Bun.sleep(20);
        const t0 = performance.now();
        const seen = await withReadOnlyConnection(async () => {
            expect(isReadOnlyContext()).toBe(true);
            const rows = (await sql`SELECT v FROM t WHERE k = 'a'`.values()) as unknown[][];
            return Number(rows[0]![0]);
        });
        const ms = performance.now() - t0;
        release();
        await txn;
        expect(seen).toBe(1); // the reader never sees the uncommitted write
        expect(ms).toBeLessThan(2000);
        expect(isReadOnlyContext()).toBe(false);
        const after = (await sql`SELECT v FROM t WHERE k = 'a'`.values()) as unknown[][];
        expect(Number(after[0]![0])).toBe(2);
    });

    test("writes inside the read-only context are refused; CREATE IF NOT EXISTS of an existing table is not", async () => {
        await expect(withReadOnlyConnection(() => sql`INSERT INTO t VALUES ('b', 1)`)).rejects.toThrow(/readonly/i);
        await withReadOnlyConnection(() => sql`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v INTEGER)`);
        const n = (await sql`SELECT COUNT(*) AS c FROM t`.values()) as unknown[][];
        expect(Number(n[0]![0])).toBe(1);
    });

    test("sql helpers (IN lists, unsafe) work through the proxy on both connections", async () => {
        const w = (await sql`SELECT k FROM t WHERE k IN ${sql(["a", "zz"])}`.values()) as unknown[][];
        expect(w.map((r) => r[0])).toEqual(["a"]);
        const r = await withReadOnlyConnection(async () => (await sql.unsafe("SELECT k FROM t").values()) as unknown[][]);
        expect(r.map((x) => x[0])).toEqual(["a"]);
    });
});
