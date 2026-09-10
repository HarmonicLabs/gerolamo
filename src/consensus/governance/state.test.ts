import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { storeEpochParams } from "../epochParams";
import { addDonationToPot, creditRegisteredAccounts, initRewardPots, readRewardPots, settleDonations } from "../../db/leaderState";
import { ratifyAndEnact, recordCommitteeHot, activeDRepCredentials, recordDRepActivity, recordDRepRegistration, recordDRepUnregistration, recordProposals, recordStakeDeregistration, recordVoteDelegation, recordVotes, seedGovernance, takeDRepStakeSnapshot, tallyProposal } from "./state";

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
    await sql`INSERT INTO stake_balance (stake_key, lovelace) VALUES (${STAKE}, 1000000)`; // the DRep stake snapshot reads balances (bug 90)
    // stake snapshot at the start of epoch 100: STAKE has 1 ADA delegated to POOL
    for (let e = 100; e <= 112; e++) {
        await sql`INSERT INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${STAKE}, ${POOL}, 1000000)`;
        await sql`INSERT INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${POOL}, 1000000)`;
        await sql`INSERT INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${e}, 1000000, 1)`;
    }
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
        // ratified at the boundary into 101 (the pulser set up there), enacted at the boundary into 102
        const r0 = await ratifyAndEnact(sql, 101, params);
        expect(r0.enacted).toEqual([]);
        expect(r0.paramChanges).toEqual({});
        const status = (await sql`SELECT status, decided_epoch FROM gov_proposals WHERE action_id = ${`${TX}:0`}`.values()) as unknown[][];
        expect(String(status[0]![0])).toBe("ratified");
        expect(Number(status[0]![1])).toBe(101);
        const r = await ratifyAndEnact(sql, 102, params);
        expect(r.enacted.length).toBe(1);
        expect(r.paramChanges.min_fee_a).toBe("45");
        expect(r.refunds.get(RET)).toBe(100_000_000_000n);
        const st = (await sql`SELECT prev_pparams FROM gov_state`.values()) as unknown[][];
        expect(String(st[0]![0])).toBe(`${TX}:0`);
        const enacted = (await sql`SELECT epoch FROM gov_enacted WHERE action_id = ${`${TX}:0`}`.values()) as unknown[][];
        expect(Number(enacted[0]![0])).toBe(102);
    });
    test("a follow-up proposal must chain on the enacted one; an unchained one waits and a DRep No blocks it", async () => {
        const TX2 = "34".repeat(32);
        await recordProposals(sql, TX2, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: undefined, protocolParamsUpdate: { txFeePerByte: 46n } } }], 101, 6);
        await recordVotes(sql, [{ voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX2, index: 0 }, votingProcedure: { vote: 1 } }] }], 6, 101);
        const r = await ratifyAndEnact(sql, 103, params);
        expect(r.enacted).toEqual([]); // prev id does not match the enacted action
        const pend = (await sql`SELECT pending FROM gov_state`.values()) as unknown[][];
        expect(JSON.parse(String(pend[0]![0])).ratified).toEqual([]);
        const TX3 = "56".repeat(32);
        await recordProposals(sql, TX3, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: { id: TX, index: 0 }, protocolParamsUpdate: { txFeePerByte: 47n } } }], 102, 6);
        await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (102, ${STAKE}, ${POOL}, 1000000)`;
        await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (102, ${POOL}, 1000000)`;
        await recordVotes(sql, [
            { voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 0 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX3, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 7, 102);
        const r2 = await ratifyAndEnact(sql, 104, params);
        expect(r2.enacted).toEqual([]);
        const pend2 = (await sql`SELECT pending FROM gov_state`.values()) as unknown[][];
        expect(JSON.parse(String(pend2[0]![0])).ratified).toEqual([]);
    });
});

describe("UpdateCommittee ratification", () => {
    test("the committee does not vote on its own replacement: DRep + SPO approval enacts it without any CC vote", async () => {
        const TX4 = "78".repeat(32), NEW_COLD = "99".repeat(28);
        for (const e of [103, 104]) {
            await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${STAKE}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${e}, 1000000, 1)`;
        }
        const proposal = { deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 4, govActionId: undefined, toRemove: [], toAdd: [{ coldCredential: { hash: { toString: () => NEW_COLD } }, expiration: 300 }], threshold: { num: 2n, den: 3n } } };
        await recordProposals(sql, TX4, [proposal], 103, 6);
        await recordVotes(sql, [
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX4, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX4, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 8, 103);
        expect((await ratifyAndEnact(sql, 105, params)).enacted).toEqual([]); // ratified, pending
        const r = await ratifyAndEnact(sql, 106, params);
        expect(r.enacted.length).toBe(1);
        const members = (await sql`SELECT cold_credential, expires_epoch FROM gov_committee ORDER BY cold_credential`.values()) as unknown[][];
        expect(members.map((m) => `${m[0]}@${m[1]}`)).toContain(`${NEW_COLD}@300`);
        const st = (await sql`SELECT prev_committee, committee_threshold_num, committee_threshold_den FROM gov_state`.values()) as unknown[][];
        expect(String(st[0]![0])).toBe(`${TX4}:0`);
        expect(Number(st[0]![1]) / Number(st[0]![2])).toBeCloseTo(2 / 3);
    });
});

describe("committee hot keys", () => {
    test("a hot key authorised before the cold key joins the committee counts once it is a member (bug 83)", async () => {
        const EARLY_COLD = "a1".repeat(28), EARLY_HOT = "a2".repeat(28);
        await recordCommitteeHot(sql, cred(EARLY_COLD), cred(EARLY_HOT)); // not a member yet: must be remembered
        const auth = (await sql`SELECT hot_credential FROM gov_committee_auth WHERE cold_credential = ${EARLY_COLD}`.values()) as unknown[][];
        expect(String(auth[0]![0])).toBe(EARLY_HOT);
        const TX6 = "bc".repeat(32);
        await recordProposals(sql, TX6, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 4, govActionId: { id: "78".repeat(32), index: 0 }, toRemove: [], toAdd: [{ coldCredential: { hash: { toString: () => EARLY_COLD } }, expiration: 400 }], threshold: { num: 2n, den: 3n } } }], 109, 6);
        await recordVotes(sql, [
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX6, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX6, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 10, 109);
        expect((await ratifyAndEnact(sql, 110, params)).enacted).toEqual([]);
        expect((await ratifyAndEnact(sql, 111, params)).enacted.length).toBe(1);
        const m = (await sql`SELECT hot_credential FROM gov_committee WHERE cold_credential = ${EARLY_COLD}`.values()) as unknown[][];
        expect(String(m[0]![0])).toBe(EARLY_HOT); // the earlier authorisation applies
    });
});

describe("script return accounts", () => {
    test("a proposal's script return account is stored typed and refunded to the script credential (bug 85)", async () => {
        const TX7 = "de".repeat(32), SCRIPT_RET = "e1".repeat(28);
        await recordProposals(sql, TX7, [{ deposit: 7n, rewardAccount: { type: "script", credentials: { toString: () => SCRIPT_RET } }, govAction: { govActionType: 6 } }], 112, 1);
        const row = (await sql`SELECT return_account FROM gov_proposals WHERE action_id = ${`${TX7}:0`}`.values()) as unknown[][];
        expect(String(row[0]![0])).toBe(`01${SCRIPT_RET}`);
        await ratifyAndEnact(sql, 114, params); // expires (lifetime 1): refund pending
        const r = await ratifyAndEnact(sql, 115, params);
        expect(r.refunds.get(`01${SCRIPT_RET}`)).toBe(7n);
    });
});

describe("DRep activity", () => {
    test("an expired DRep's stake is not in the denominator and its vote carries no power (bug 71)", async () => {
        const TX5 = "9a".repeat(32), OLD_DREP = "ab".repeat(28), OLD_STAKE = "ac".repeat(28);
        // a DRep last active at epoch 50 holding ten times the stake of the live one
        await recordDRepRegistration(sql, cred(OLD_DREP), 500_000_000n, 1, 50);
        await recordVoteDelegation(sql, cred(OLD_STAKE), { drepType: 0, hash: { toString: () => OLD_DREP } });
        await sql`INSERT INTO stake_balance (stake_key, lovelace) VALUES (${OLD_STAKE}, 10000000)`;
        for (const e of [107, 108]) {
            await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${OLD_STAKE}, ${POOL}, 10000000)`;
            await sql`UPDATE epoch_pool_stake SET stake = 11000000 WHERE taken_at = ${e} AND pool_id = ${POOL}`;
            await sql`UPDATE epoch_stake_totals SET total_active = 11000000 WHERE taken_at = ${e}`;
        }
        const prev = (await sql`SELECT prev_pparams FROM gov_state`.values()) as unknown[][];
        const [prevId, prevIdx] = String(prev[0]![0]).split(":");
        const proposal = { deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: { id: prevId, index: Number(prevIdx) }, protocolParamsUpdate: { txFeePerByte: 48n } } };
        await recordProposals(sql, TX5, [proposal], 107, 6);
        await recordVotes(sql, [
            { voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: TX5, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX5, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX5, index: 0 }, votingProcedure: { vote: 1 } }] }, // min_fee_a is a security-group parameter
        ], 9, 107);
        // (a vote would revive the expired DRep, as in the ledger: activity is any vote or certificate)
        expect((await ratifyAndEnact(sql, 108, params)).enacted).toEqual([]); // ratified, pending
        const r = await ratifyAndEnact(sql, 109, params);
        expect(r.enacted.length).toBe(1); // 1 ADA yes of 1 ADA active; the expired DRep's 10 ADA is not in the total
        expect(r.paramChanges.min_fee_a).toBe("48");
    });
});


describe("stake deregistration", () => {
    test("deregistering a stake credential drops its DRep delegation, key and script credentials alike (bug 89)", async () => {
        const K = "b1".repeat(28), S = "b2".repeat(28);
        await recordVoteDelegation(sql, cred(K), { drepType: 0, hash: { toString: () => DREP } });
        await recordVoteDelegation(sql, cred(S, 1), { drepType: 0, hash: { toString: () => DREP } });
        const rows = async () => (await sql`SELECT stake_key FROM gov_drep_delegations WHERE stake_key IN (${K}, ${"01" + S}) ORDER BY stake_key`.values()).map((r: unknown[]) => String(r[0]));
        expect(await rows()).toEqual(["01" + S, K]);
        await recordStakeDeregistration(sql, cred(K));
        expect(await rows()).toEqual(["01" + S]);
        await recordStakeDeregistration(sql, cred(S, 1));
        expect(await rows()).toEqual([]);
        // the live delegation from the fixture is untouched
        expect((await sql`SELECT COUNT(*) FROM gov_drep_delegations WHERE stake_key = ${STAKE}`.values())[0]![0]).toBe(1);
    });
});

describe("DRep expiry", () => {
    test("a DRep's expiry is fixed by the drep_activity in force when it was last active (bug 102)", async () => {
        const D = "e1".repeat(28), F = "e2".repeat(28);
        await sql`UPDATE gov_state SET dormant_epochs = 0 WHERE id = 1`;
        await storeEpochParams(300, { drep_activity: 20, protocol_major_ver: 10 }, "local");
        await storeEpochParams(310, { drep_activity: 31, protocol_major_ver: 10 }, "local");
        await recordDRepRegistration(sql, cred(D), 500_000_000n, 1, 300); // expires after 320
        await recordDRepRegistration(sql, cred(F), 500_000_000n, 1, 300);
        await recordDRepActivity(sql, F, 310); // refreshed once the activity is 31: expires after 341
        const rows = (await sql`SELECT credential, expiry_epoch FROM gov_dreps WHERE credential IN (${D}, ${F}) ORDER BY credential`.values()) as unknown[][];
        expect(rows.map((r) => [String(r[0]), Number(r[1])])).toEqual([[D, 320], [F, 341]]);
        const at321 = await activeDRepCredentials(321, 31);
        expect(at321.has(D)).toBe(false); // last_active 300 + 31 would still say active
        expect(at321.has(F)).toBe(true);
    });
});

describe("DRep unregistration", () => {
    test("unregistering a DRep clears every delegation to it; a re-registration starts with none (bug 101)", async () => {
        const DREP = "d1".repeat(28), OTHER = "d2".repeat(28), A = "a1".repeat(28), B = "b1".repeat(28), C = "c1".repeat(28);
        await recordDRepRegistration(sql, cred(DREP), 500_000_000n, 1, 100);
        await recordDRepRegistration(sql, cred(OTHER), 500_000_000n, 1, 100);
        await recordVoteDelegation(sql, cred(A), { drepType: 0, hash: { toString: () => DREP } });
        await recordVoteDelegation(sql, cred(B, 1), { drepType: 0, hash: { toString: () => DREP } });
        await recordVoteDelegation(sql, cred(C), { drepType: 0, hash: { toString: () => OTHER } });
        await recordDRepUnregistration(sql, cred(DREP));
        const left = (await sql`SELECT stake_key FROM gov_drep_delegations WHERE drep_hash IN (${DREP}, ${OTHER}) ORDER BY stake_key`.values()) as unknown[][];
        expect(left.map((r) => String(r[0]))).toEqual([C]);
        await recordDRepRegistration(sql, cred(DREP), 500_000_000n, 2, 101);
        const again = (await sql`SELECT COUNT(*) FROM gov_drep_delegations WHERE drep_hash = ${DREP}`.values()) as unknown[][];
        expect(Number(again[0]![0])).toBe(0);
    });
});

describe("DRep stake distribution", () => {
    test("a vote delegation without a pool delegation and a live proposal's deposit count for the DRep (bug 90)", async () => {
        const DREP2 = "c1".repeat(28), NP = "c2".repeat(28), TX9 = "c3".repeat(32);
        await recordDRepRegistration(sql, cred(DREP2), 500_000_000n, 1, 120);
        await recordVoteDelegation(sql, cred(NP), { drepType: 0, hash: { toString: () => DREP2 } });
        await sql`INSERT INTO stake_balance (stake_key, lovelace) VALUES (${NP}, 3000000)`; // 3 ADA, delegated to no pool
        // a 2 ADA proposal returning to NP, voted yes by DREP only
        const proposal = { deposit: 2_000_000n, rewardAccount: { credentials: { hash: { toString: () => NP } } }, govAction: { govActionType: 0, govActionId: undefined, protocolParamsUpdate: { txFeePerByte: 50n } } };
        await recordProposals(sql, TX9, [proposal], 120, 6);
        await recordVotes(sql, [{ voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX9, index: 0 }, votingProcedure: { vote: 1 } }] }], 11, 120);
        expect(await takeDRepStakeSnapshot(sql, 121)).toBeGreaterThan(0);
        const r = await tallyProposal(sql, 121, `${TX9}:0`, params, 121);
        expect(r.dt.yes).toBe(1000000n); // STAKE through DREP
        expect(r.dt.unvoted).toBe(5000000n); // NP's 3 ADA + the proposal's own 2 ADA deposit, through DREP2 (no pool, no epoch_stake_cred row)
        expect((await sql`SELECT COUNT(*) FROM epoch_stake_cred WHERE stake_key = ${NP}`.values())[0]![0]).toBe(0);
    });
});

describe("boundary payouts and donations", () => {
    test("deposit refunds and withdrawals reach registered accounts only; the rest is unclaimed (bug 91)", async () => {
        const REG = "d1".repeat(28), UNREG = "d2".repeat(28), SREG = "d3".repeat(28);
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.from(REG, "hex")}, 0, 0)`;
        await sql`INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (${Buffer.from(SREG, "hex")}, 1, 0)`;
        const r = await creditRegisteredAccounts(sql, new Map([[REG, 100n], [UNREG, 200n], ["01" + SREG, 300n]]));
        expect(r.credited).toBe(400n);
        expect(r.unclaimed).toBe(200n);
        expect(r.unregistered).toEqual([UNREG]);
        const bal = async (hex: string) => (await sql`SELECT amount FROM rewards WHERE stake_credentials = ${Buffer.from(hex, "hex")}`.values())[0]?.[0] ?? null;
        expect(await bal(REG)).toBe(100);
        expect(await bal("01" + SREG)).toBe(300); // script credentials are keyed by their typed bytes
        expect(await bal(UNREG)).toBeNull();
    });
    test("treasury donations accumulate during the epoch and join the treasury at the boundary (bug 92)", async () => {
        await initRewardPots(sql, 100, 45_000_000_000_000_000n);
        const before = (await readRewardPots())!.treasury;
        await addDonationToPot(sql, 5_000_000n);
        await addDonationToPot(sql, 7n);
        expect((await readRewardPots())!.treasury).toBe(before); // not yet
        expect(await settleDonations(sql)).toBe(5_000_007n);
        expect((await readRewardPots())!.treasury).toBe(before + 5_000_007n);
        expect(await settleDonations(sql)).toBe(0n); // idempotent
    });
});

describe("orphaned proposals", () => {
    test("enacting a committee action drops its siblings and refunds their deposits (bug 94)", async () => {
        const TX_A = "e1".repeat(32), TX_B = "e2".repeat(32), COLD_A = "e3".repeat(28), COLD_B = "e4".repeat(28), DREP2 = "c1".repeat(28);
        const p2 = { ...params, dvt_committee_normal: 0.5, pvt_committee_normal: 0.51 };
        for (const e of [122, 123, 124]) {
            await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${STAKE}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${e}, 1000000, 1)`;
        }
        const head = String(((await sql`SELECT prev_committee FROM gov_state`.values()) as unknown[][])[0]![0]);
        const [hid, hix] = head.split(":");
        const mk = (cold: string) => ({ deposit: 5n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 4, govActionId: { id: hid, index: Number(hix) }, toRemove: [], toAdd: [{ coldCredential: { hash: { toString: () => cold } }, expiration: 400 }], threshold: { numerator: 2, denominator: 3 } } });
        await recordProposals(sql, TX_A, [mk(COLD_A)], 122, 6);
        await recordProposals(sql, TX_B, [mk(COLD_B)], 122, 6); // a sibling: same purpose, same parent
        await recordVotes(sql, [
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX_A, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP2 } }, votes: [{ govActionId: { id: TX_A, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX_A, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 13, 122);
        expect((await ratifyAndEnact(sql, 123, p2)).enacted).toEqual([]);
        const r = await ratifyAndEnact(sql, 124, p2);
        expect(r.enacted.length).toBe(1); // labelled "UpdateCommittee e1e1…"
        expect(r.dropped).toEqual([`${TX_B}:0`]);
        expect(r.refunds.get(RET)).toBe(10n); // both deposits go back
        const st = (await sql`SELECT status, decided_epoch FROM gov_proposals WHERE action_id = ${`${TX_B}:0`}`.values()) as unknown[][];
        expect(st[0]).toEqual(["dropped", 124]);
    });
});

describe("delaying actions", () => {
    test("a proposal behind an accepted committee update in the same round waits for the next boundary (bug 96)", async () => {
        const TX_C = "f1".repeat(32), TX_P = "f2".repeat(32), COLD_C = "f3".repeat(28), DREP2 = "c1".repeat(28);
        const p2 = { ...params, dvt_committee_normal: 0.5, pvt_committee_normal: 0.51, dvt_p_p_economic_group: 0.5 };
        for (const e of [125, 126, 127]) {
            await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${STAKE}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${e}, 1000000, 1)`;
        }
        const st = (await sql`SELECT prev_committee, prev_pparams FROM gov_state`.values()) as unknown[][];
        const [cid, cix] = String(st[0]![0]).split(":"), [pid, pix] = String(st[0]![1]).split(":");
        const committee = { deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 4, govActionId: { id: cid, index: Number(cix) }, toRemove: [], toAdd: [{ coldCredential: { hash: { toString: () => COLD_C } }, expiration: 500 }], threshold: { numerator: 2, denominator: 3 } } };
        const pparams = { deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 0, govActionId: { id: pid, index: Number(pix) }, protocolParamsUpdate: { txFeePerByte: 51n } } };
        await recordProposals(sql, TX_C, [committee], 125, 6); // submitted first: tallied first
        await recordProposals(sql, TX_P, [pparams], 125, 6);
        const yes = (tx: string) => [
            { voter: { kind: 0, hash: { toString: () => CC_HOT } }, votes: [{ govActionId: { id: tx, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: tx, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP2 } }, votes: [{ govActionId: { id: tx, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: tx, index: 0 }, votingProcedure: { vote: 1 } }] },
        ];
        await recordVotes(sql, [...yes(TX_C), ...yes(TX_P)], 14, 125);
        await ratifyAndEnact(sql, 126, p2); // committee update ratified, the parameter change delayed
        const status = async (tx: string) => String(((await sql`SELECT status FROM gov_proposals WHERE action_id = ${`${tx}:0`}`.values()) as unknown[][])[0]![0]);
        expect(await status(TX_C)).toBe("ratified");
        expect(await status(TX_P)).toBe("active");
        const r = await ratifyAndEnact(sql, 127, p2); // committee enacted; the parameter change ratified this round
        expect(r.enacted.length).toBe(1);
        expect(await status(TX_P)).toBe("ratified");
    });
});

describe("expiring orphans", () => {
    test("a proposal that expires in the boundary where its sibling is enacted is refunded once (bug 98)", async () => {
        const TX_OLD = "f4".repeat(32), TX_NEW = "f5".repeat(32), COLD_OLD = "f6".repeat(28), COLD_NEW = "f7".repeat(28), DREP2 = "c1".repeat(28);
        const p2 = { ...params, dvt_committee_normal: 0.5, pvt_committee_normal: 0.51 };
        for (const e of [128, 129, 130, 131, 132]) {
            await sql`INSERT OR IGNORE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (${e}, ${STAKE}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (${e}, ${POOL}, 1000000)`;
            await sql`INSERT OR IGNORE INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${e}, 1000000, 1)`;
        }
        // settle the previous tests' pending state
        await ratifyAndEnact(sql, 128, p2);
        await ratifyAndEnact(sql, 129, p2);
        const head = String(((await sql`SELECT prev_committee FROM gov_state`.values()) as unknown[][])[0]![0]);
        const [hid, hix] = head.split(":");
        const mk = (cold: string) => ({ deposit: 5n, rewardAccount: { credentials: { hash: { toString: () => RET } } }, govAction: { govActionType: 4, govActionId: { id: hid, index: Number(hix) }, toRemove: [], toAdd: [{ coldCredential: { hash: { toString: () => cold } }, expiration: 600 }], threshold: { numerator: 2, denominator: 3 } } });
        await recordProposals(sql, TX_OLD, [mk(COLD_OLD)], 124, 6); // expires 130: flagged expired at the 131 ratification
        await recordProposals(sql, TX_NEW, [mk(COLD_NEW)], 130, 6);
        await recordVotes(sql, [
            { voter: { kind: 2, hash: { toString: () => DREP } }, votes: [{ govActionId: { id: TX_NEW, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 2, hash: { toString: () => DREP2 } }, votes: [{ govActionId: { id: TX_NEW, index: 0 }, votingProcedure: { vote: 1 } }] },
            { voter: { kind: 4, hash: { toString: () => POOL } }, votes: [{ govActionId: { id: TX_NEW, index: 0 }, votingProcedure: { vote: 1 } }] },
        ], 15, 130);
        const before = (await ratifyAndEnact(sql, 131, p2)).refunds.get(RET) ?? 0n;
        const r = await ratifyAndEnact(sql, 132, p2); // TX_NEW enacted; TX_OLD expired — and an orphan of TX_NEW
        expect(r.enacted.length).toBe(1);
        expect(r.expired).toEqual([`${TX_OLD}:0`]);
        expect(r.dropped).toEqual([]);
        expect(r.refunds.get(RET)).toBe(10n); // one deposit each, not 15
        const st = (await sql`SELECT status FROM gov_proposals WHERE action_id = ${`${TX_OLD}:0`}`.values()) as unknown[][];
        expect(String(st[0]![0])).toBe("expired");
        void before;
    });
});
