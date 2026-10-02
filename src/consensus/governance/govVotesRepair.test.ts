import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSql, sql } from "../../sql";
import { ensureInitialized } from "../../db";
import { planVoteRepair, repairLiveProposalVotes, survivingVotes, voteKeyOf, type VoteMap } from "./govVotesRepair";
import type { GovTxModel } from "./govTxDecode";
import { recordDRepRegistration, recordProposals, recordVotes, seedGovernance } from "./state";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";

const A = "11".repeat(32) + ":0", B = "22".repeat(32) + ":0", GONE = "33".repeat(32) + ":0";
const D1 = "d1".repeat(28), D2 = "d2".repeat(28), SD = "01" + "d3".repeat(28), HOT = "e1".repeat(28), POOL = "f1".repeat(28);
const tx = (m: Partial<GovTxModel>): GovTxModel => ({ txId: "ab".repeat(32), certs: [], proposals: [], votes: [], withdrawals: [], treasuryValue: null, ...m });
const vote = (kind: number, hash: string, actionId: string, v = 1) => ({ voterKind: kind, voterHash: hash, actionId, vote: v });
const unreg = (cred: string) => ({ index: 0, type: 17, cred, coin: 500n });
const live = new Set([A, B]);

describe("surviving votes (cardano-ledger-conway 1.22.1 Rules/Gov.hs, bug 166)", () => {
    test("a DRep's unregistration removes its votes from every live action; a later vote after re-registration survives", () => {
        const r = survivingVotes([
            { slot: 10, model: tx({ votes: [vote(2, D1, A), vote(2, D1, B, 0), vote(2, D2, A)] }) },
            { slot: 20, model: tx({ certs: [unreg(D1)] }) },
            { slot: 30, model: tx({ certs: [{ index: 0, type: 16, cred: D1, coin: 500n }] }) },
            { slot: 40, model: tx({ votes: [vote(2, D1, B, 2)] }) },
        ], live);
        expect([...r.get(A)!.keys()]).toEqual([voteKeyOf(2, D2)]);
        expect(r.get(B)!.get(voteKeyOf(2, D1))).toEqual({ voterKind: 2, voterHash: D1, vote: 2, slot: 40 });
    });
    test("an unregistration in the voting transaction itself removes the vote (cleanup runs after the votes); script DReps by type", () => {
        const r = survivingVotes([
            { slot: 10, model: tx({ certs: [unreg(D1), unreg(SD)], votes: [vote(2, D1, A), vote(3, SD.slice(2), A), vote(2, SD.slice(2), B)] }) },
        ], live);
        expect(r.get(A)!.size).toBe(0);
        expect(r.get(B)!.size).toBe(1); // the key DRep with the script DRep's hash is another DRep
    });
    test("committee resignation, pool retirement and votes on actions that are not live change nothing; the last vote wins", () => {
        const r = survivingVotes([
            { slot: 10, model: tx({ votes: [vote(1, HOT, A), vote(4, POOL, A, 0), vote(2, D1, GONE)] }) },
            { slot: 20, model: tx({ certs: [{ index: 0, type: 15, cold: "01" + "c1".repeat(28) }, { index: 1, type: 4, pool: POOL, epoch: 5 }] }) },
            { slot: 30, model: tx({ votes: [vote(4, POOL, A, 2)] }) },
        ], live);
        expect([...r.get(A)!.values()].map((v) => `${v.voterKind}:${v.vote}@${v.slot}`).sort()).toEqual(["1:1@10", "4:2@30"]);
        expect(r.has(GONE)).toBe(false);
    });
    test("the plan: removals, additions and changes against the store; a matching vote keeps its stored slot", () => {
        const stored = new Map<string, VoteMap>([[A, new Map([[voteKeyOf(2, D1), { voterKind: 2, voterHash: D1, vote: 1, slot: 5 }], [voteKeyOf(2, D2), { voterKind: 2, voterHash: D2, vote: 1, slot: 5 }], [voteKeyOf(4, POOL), { voterKind: 4, voterHash: POOL, vote: 0, slot: 5 }]])]]);
        const expected = new Map<string, VoteMap>([[A, new Map([[voteKeyOf(2, D2), { voterKind: 2, voterHash: D2, vote: 1, slot: 99 }], [voteKeyOf(4, POOL), { voterKind: 4, voterHash: POOL, vote: 1, slot: 99 }], [voteKeyOf(1, HOT), { voterKind: 1, voterHash: HOT, vote: 1, slot: 99 }]])]]);
        const plan = planVoteRepair(stored, expected);
        expect(plan.remove.map((v) => v.voterHash)).toEqual([D1]);
        expect(plan.add.map((v) => v.voterHash)).toEqual([HOT]);
        expect(plan.change.map((c) => `${c.stored.vote}→${c.expected.vote}`)).toEqual(["0→1"]);
    });
});

describe("repair against a SQLite store", () => {
    const dir = mkdtempSync(join(tmpdir(), "gerolamo-govvotes-"));
    beforeAll(async () => { setEpochNetwork("preview"); initSql(join(dir, "t.db")); await ensureInitialized(); await seedGovernance(sql, { committee: { members: {}, threshold: { numerator: 2, denominator: 3 } } }, 100); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    test("a vote a build before bug 156 kept through a DRep's re-registration is removed; nothing else changes", async () => {
        const TX = "44".repeat(32), cred = (h: string) => ({ type: 0, hash: { toString: () => h } });
        await recordDRepRegistration(sql, cred(D1), 500n, 1, 100);
        await recordDRepRegistration(sql, cred(D2), 500n, 1, 100);
        await recordProposals(sql, TX, [{ deposit: 1n, rewardAccount: { credentials: { hash: { toString: () => "aa".repeat(28) } } }, govAction: { govActionType: 6 } }], 100, 6);
        const id = `${TX}:0`;
        await recordVotes(sql, [{ voter: { kind: 2, hash: { toString: () => D1 } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 1 } }] }, { voter: { kind: 2, hash: { toString: () => D2 } }, votes: [{ govActionId: { id: TX, index: 0 }, votingProcedure: { vote: 0 } }] }], 8640010, 100);
        // the old build's residue: D1 unregistered and re-registered after voting, its vote stayed
        const blocks = [{ slot: 8640010, txs: [tx({ votes: [vote(2, D1, id), vote(2, D2, id, 0)] })] }, { slot: 8640020, txs: [tx({ certs: [unreg(D1)] })] }, { slot: 8640030, txs: [tx({ certs: [{ index: 0, type: 16, cred: D1, coin: 500n }] })] }];
        // decoded transactions fed directly; the block walker runs on real chunks in the dry-run script
        type Blk = { slot: number; bytes: Uint8Array; txs: GovTxModel[] };
        const chain = async function* (from: number): AsyncGenerator<Blk> { for (const b of blocks) if (b.slot >= from) yield { slot: b.slot, bytes: new Uint8Array(0), txs: b.txs }; };
        const txsOfBlock = (b: { slot: number; bytes: Uint8Array }) => (b as Blk).txs.map((m) => ({ slot: b.slot, model: m }));
        const r = await repairLiveProposalVotes(chain, { dryRun: true, txsOfBlock });
        expect(r.plan.remove.map((v) => `${v.actionId}:${v.voterHash}`)).toEqual([`${id}:${D1}`]);
        expect(r.plan.add).toEqual([]); expect(r.plan.change).toEqual([]);
        expect(((await sql`SELECT COUNT(*) FROM gov_votes WHERE action_id = ${id}`.values()) as unknown[][])[0]![0]).toBe(2); // dry run
        await repairLiveProposalVotes(chain, { dryRun: false, txsOfBlock });
        expect(((await sql`SELECT voter_hash FROM gov_votes WHERE action_id = ${id}`.values()) as unknown[][]).map((x) => String(x[0]))).toEqual([D2]);
    });
});
