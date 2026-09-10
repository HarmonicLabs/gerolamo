import { rewardAccountTypedHex } from "../db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../sql";
import { ensureInitialized } from "../db";
import { applyPendingMir, initRewardPots, promotePendingPoolParams, queueMir, readRewardPots, recordPoolRegistration, recordPoolRetirement, refundPoolDeposits, registeredPoolParams, retirePoolsAtEpochDetailed } from "./leaderState";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-pool-"));
const POOL = "ab".repeat(28), VRF1 = "01".repeat(32), VRF2 = "02".repeat(32);
const params = (cost: string) => ({ pledge: "0", cost, marginNum: "1", marginDen: "100", rewardAccount: "cd".repeat(28), owners: [] });

beforeAll(async () => { initSql(join(dir, "t.db")); await ensureInitialized(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pool re-registration takes effect at the next boundary", () => {
    test("first registration is immediate; the update waits for promotePendingPoolParams", async () => {
        await recordPoolRegistration(sql, POOL, VRF1, 100, params("340000000"));
        expect(registeredPoolParams().then((m) => m.get(POOL)?.params?.cost)).resolves.toBe("340000000");
        await recordPoolRegistration(sql, POOL, VRF2, 200, params("500000000"));
        const before = (await registeredPoolParams()).get(POOL)!;
        expect(before.params?.cost).toBe("340000000");
        expect(before.vrf).toBe(VRF1);
        expect(await promotePendingPoolParams(sql)).toBe(1);
        const after = (await registeredPoolParams()).get(POOL)!;
        expect(after.params?.cost).toBe("500000000");
        expect(after.vrf).toBe(VRF2);
        expect(await promotePendingPoolParams(sql)).toBe(0);
    });
    test("retirement removes the pool's delegations and refunds the deposit to a registered reward account, else to the treasury", async () => {
        const P2 = "ee".repeat(28), RA = "cd".repeat(28), CRED = "77".repeat(28);
        await recordPoolRegistration(sql, P2, VRF1, 300, params("340000000"));
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.from(RA, "hex")}, 0, 0)`;
        await sql`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${Buffer.from(CRED, "hex")}, 0, ${Buffer.from(P2, "hex")})`;
        await recordPoolRetirement(sql, P2, 5);
        const retired = await retirePoolsAtEpochDetailed(sql, 5);
        expect(retired.map((r) => r.poolId)).toEqual([P2]);
        expect(retired[0]!.delegationsRemoved).toBe(1);
        expect(((await sql`SELECT COUNT(*) FROM delegations WHERE pool_key_hash = ${Buffer.from(P2, "hex")}`.values()) as any)[0][0]).toBe(0);
        const r = await refundPoolDeposits(sql, retired, 500_000_000n);
        expect(r.refunded).toBe(500_000_000n);
        expect(r.toTreasury).toBe(0n);
        const bal = (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(RA, "hex")}`.values()) as any;
        expect(BigInt(bal[0][0])).toBe(500_000_000n);
        // unregistered reward account: the deposit goes to the treasury
        const P3 = "dd".repeat(28);
        await recordPoolRegistration(sql, P3, VRF1, 400, { ...params("1"), rewardAccount: "ab".repeat(28) });
        await recordPoolRetirement(sql, P3, 6);
        const r3 = await refundPoolDeposits(sql, await retirePoolsAtEpochDetailed(sql, 6), 500_000_000n);
        expect(r3.refunded).toBe(0n);
        expect(r3.toTreasury).toBe(500_000_000n);
    });
    test("MIR: registered accounts are credited from the pot at the next boundary; an over-budget pot pays nothing; transfers move between pots", async () => {
        await initRewardPots(sql, 10, 45_000_000_000_000_000n);
        const before = (await readRewardPots())!;
        const A = "a1".repeat(28), B = "b2".repeat(28);
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.from(A, "hex")}, 0, 0)`;
        await queueMir(sql, 10, 0, [{ stakeKey: A, amount: 1_000_000n }, { stakeKey: B, amount: 5_000_000n }]); // B is not registered
        await queueMir(sql, 10, 0, [{ stakeKey: null, amount: 7_000_000n }]); // reserves → treasury
        await queueMir(sql, 10, 1, [{ stakeKey: A, amount: before.treasury + 1n }]); // treasury cannot pay
        expect(await applyPendingMir(sql, 10)).toEqual({ credited: 0n, transferred: 0n, dropped: 0 }); // same epoch: not yet
        const r = await applyPendingMir(sql, 11);
        expect(r.credited).toBe(1_000_000n);
        expect(r.transferred).toBe(7_000_000n);
        expect(r.dropped).toBe(1);
        const after = (await readRewardPots())!;
        expect(before.reserves - after.reserves).toBe(8_000_000n);
        expect(after.treasury - before.treasury).toBe(7_000_000n);
        const bal = (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(A, "hex")}`.values()) as any;
        expect(BigInt(bal[0][0])).toBe(1_000_000n);
        expect(((await sql`SELECT COUNT(*) FROM mir_pending`.values()) as any)[0][0]).toBe(0);
    });
});

describe("reward account typing", () => {
    test("a script stake address as reward account is stored typed (bug 84)", () => {
        const h = "fda02f913f54589fcebe2afed33a6f62600ed649fd04f8f692108efe";
        expect(rewardAccountTypedHex({ type: "script", credentials: { toString: () => h } })).toBe(`01${h}`);
        expect(rewardAccountTypedHex({ type: "key", credentials: { toString: () => h } })).toBe(h);
        expect(rewardAccountTypedHex({ credentials: { toString: () => h } })).toBe(h);
    });
});
