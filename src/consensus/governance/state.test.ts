import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { ratifyAndEnact, recordDRepRegistration, recordProposals, recordVoteDelegation, recordVotes, seedGovernance } from "./state";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-gov-"));
const DREP = "aa".repeat(28), STAKE = "bb".repeat(28), POOL = "cc".repeat(28), CC_COLD = "dd".repeat(28), CC_HOT = "ee".repeat(28), RET = "ff".repeat(28);
const TX = "12".repeat(32);
const cred = (h: string, type = 0) => ({ type, hash: { toString: () => h } });
const params = { protocol_major_ver: 10, committee_min_size: 1, drep_activity: 20, dvt_p_p_economic_group: 0.67, pvt_p_p_security_group: 0.51, dvt_hard_fork_initiation: 0.6, pvt_hard_fork_initiation: 0.51 };

beforeAll(async () => {
    initSql(join(dir, "t.db"));
    await ensureInitialized();
    await seedGovernance(sql, { committee: { members: { [`keyHash-${CC_COLD}`]: 999 }, threshold: { numerator: 1, denominator: 2 } }, constitution: { anchor: { dataHash: "00".repeat(32) } } }, 100);
    await sql`UPDATE gov_committee SET hot_credential = ${CC_HOT} WHERE cold_credential = ${CC_COLD}`;
    await recordDRepRegistration(sql, cred(DREP), 500_000_000n, 1, 100);
    await recordVoteDelegation(sql, cred(STAKE), { drepType: 0, hash: { toString: () => DREP } });
    // stake snapshot at the start of epoch 100: STAKE has 1 ADA delegated to POOL
    await sql`INSERT INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (100, ${STAKE}, ${POOL}, 1000000)`;
    await sql`INSERT INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (100, ${POOL}, 1000000)`;
    await sql`INSERT INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (100, 1000000, 1)`;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Conway ratification", () => {
    test("a parameter change ratified by CC, DReps and SPOs is enacted; its deposit is refunded", async () => {
        const proposal = { deposit: 100_000_000_000n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: undefined, protocolParamsUpdate: { txFeePerByte: 45n } } };
        await recordProposals(sql, TX, [proposal], 100, 6);
        const votes = [
            { voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 1 } }] },
        ];
        await recordVotes(sql, votes, 5, 100);
        const r = await ratifyAndEnact(sql, 101, params);
        expect(r.enacted.length).toBe(1);
        expect(r.paramChanges.min_fee_a).toBe("45");
        expect(r.refunds.get(RET)).toBe(100_000_000_000n);
        const st = (await sql`SELECT prev_pparams FROM gov_state`.values()) as unknown[][];
        expect(String(st[0]![0])).toBe(`${TX}:0`);
    });
    test("a follow-up proposal must chain on the enacted one; an unchained one waits and a DRep No blocks it", async () => {
        const TX2 = "34".repeat(32);
        await recordProposals(sql, TX2, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: undefined, protocolParamsUpdate: { txFeePerByte: 46n } } }], 101, 6);
        await recordVotes(sql, [{ voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX2, index: 0 }, votingProcedure: { vote: 1 } }] }], 6, 101);
        const r = await ratifyAndEnact(sql, 102, params);
        expect(r.enacted).toEqual([]); // prev id does not match the enacted action
        const TX3 = "56".repeat(32);
        await recordProposals(sql, TX3, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: { id: TX, index: 0 }, protocolParamsUpdate: { txFeePerByte: 47n } } }], 102, 6);
        await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (102, ${STAKE}, ${POOL}, 1000000)`;
        await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (102, ${POOL}, 1000000)`;
        await recordVotes(sql, [
            { voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 0 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 7, 102);
        const r2 = await ratifyAndEnact(sql, 103, params);
        expect(r2.enacted).toEqual([]);
    });
});
