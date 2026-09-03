import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { initSql, sql } from "./sql";
import { ensureInitialized, getDelegationsByCredentials, getStakeByCredentials } from "./db";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-stake-lookup-"));

const cred = (b: number) => new Uint8Array(28).fill(b);
const pool = (b: number) => new Uint8Array(28).fill(b);

beforeAll(async () => {
    initSql(join(dir, "test.db"));
    await ensureInitialized();
    await sql`INSERT INTO stake (stake_credentials, amount) VALUES (${cred(1)}, 0)`;
    await sql`INSERT INTO stake (stake_credentials, amount) VALUES (${cred(2)}, 5)`;
    await sql`INSERT INTO stake (stake_credentials, amount) VALUES (${cred(3)}, 7)`;
    await sql`INSERT INTO delegations (stake_credentials, pool_key_hash) VALUES (${cred(2)}, ${pool(9)})`;
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("keyed stake / delegation lookups", () => {
    test("returns only the requested credentials, deduplicated", async () => {
        const rows = await getStakeByCredentials([cred(1), cred(3), cred(1), cred(42)]);
        const keys = rows.map((r) => toHex(r.stake_credentials)).sort();
        expect(keys).toEqual([toHex(cred(1)), toHex(cred(3))]);
        expect(rows.find((r) => toHex(r.stake_credentials) === toHex(cred(3)))!.amount).toBe(7);
    });

    test("delegations by credential; Buffer keys match BLOB rows", async () => {
        const rows = await getDelegationsByCredentials([Buffer.from(cred(2)), cred(1)]);
        expect(rows).toHaveLength(1);
        expect(toHex(rows[0]!.stake_credentials)).toBe(toHex(cred(2)));
        expect(toHex(rows[0]!.pool_key_hash)).toBe(toHex(pool(9)));
    });

    test("empty input is a no-op", async () => {
        expect(await getStakeByCredentials([])).toEqual([]);
        expect(await getDelegationsByCredentials([])).toEqual([]);
    });

    test("credential indexes exist", async () => {
        const rows = await sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_stake_credentials', 'idx_delegations_credentials')`.values() as any[];
        expect(rows.length).toBe(2);
    });
});
