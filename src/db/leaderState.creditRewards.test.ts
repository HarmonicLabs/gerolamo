import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { creditRewards, recordRewardPayouts } from "./leaderState";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-rewards-"));
beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("creditRewards (batched upsert)", () => {
    test("new and existing accounts, key and typed script credentials, amounts add up", async () => {
        const A = "aa".repeat(28), B = "bb".repeat(28), S = "01" + "cc".repeat(28); // S: typed script account (29 bytes)
        expect(await creditRewards(sql, new Map([[A, 5n], [B, 7n], [S, 11n]]))).toBe(23n);
        expect(await creditRewards(sql, new Map([[A, 100n], [S, 1n], ["dd".repeat(28), 0n]]))).toBe(101n);
        const rows = (await sql`SELECT hex(stake_credentials), amount FROM rewards ORDER BY 1`.values()) as unknown[][];
        expect(rows.map((r) => [String(r[0]).toLowerCase(), Number(r[1])]).sort()).toEqual([[A, 105], [B, 7], [S, 12]].sort());
        const idx = (await sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rewards' AND sql LIKE '%UNIQUE%'`.values()) as unknown[][];
        expect(idx.length).toBe(1);
    });
    test("payout records are written in one statement per batch", async () => {
        const paid = new Map<string, bigint>();
        for (let i = 0; i < 10_000; i++) paid.set(i.toString(16).padStart(56, "0"), BigInt(i + 1));
        await recordRewardPayouts(sql, 42, paid);
        const n = (await sql`SELECT COUNT(*), SUM(CAST(amount AS INTEGER)) FROM reward_payouts WHERE performance_epoch = 42`.values()) as unknown[][];
        expect(Number(n[0]![0])).toBe(10_000);
        expect(Number(n[0]![1])).toBe((10_000 * 10_001) / 2);
    });
});
