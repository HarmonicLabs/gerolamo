import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "./LedgerStore";
import { StakeWrites } from "./stakeStore";
import { UtxoWrites } from "./utxoStore";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
const cred = (n: number, script = false) => (script ? "01" : "") + n.toString(16).padStart(2, "0").repeat(28);
const pool = (n: number) => (0xa0 + n).toString(16).repeat(28);

describe("stakeStore", () => {
    test("registration, delegation, rewards, pools, pots, snapshot and POOLREAP through diffs", async () => {
        const dir = await mkdtemp(join(tmpdir(), "stake-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const w = new StakeWrites(st), u = new UtxoWrites(st), r = w.reads;
        const P1 = pool(1), P2 = pool(2), C1 = cred(1), C2 = cred(2, true), C3 = cred(3);

        // block 1: pools register, credentials register + delegate, some UTxO with stake keys, pots init
        st.beginBlock(h(1), h(0), 10);
        w.recordPoolRegistration(P1, "aa".repeat(32), 10, { pledge: "1", cost: "340", marginNum: "1", marginDen: "100", rewardAccount: C1, owners: [C1] });
        w.recordPoolRegistration(P2, "bb".repeat(32), 10, null);
        w.registerStake(C1); w.registerStake(C2); w.registerStake(C3);
        w.delegate(C1, P1); w.delegate(C2, P1); w.delegate(C3, P2);
        u.put({ utxo_ref: "11".repeat(32) + ":0", tx_out: "{}", tx_hash: "11".repeat(32), address: "addr1", lovelace: "1000", reference_script_hash: null, stake_key: C1 });
        u.put({ utxo_ref: "11".repeat(32) + ":1", tx_out: "{}", tx_hash: "11".repeat(32), address: "addr2", lovelace: "500", reference_script_hash: null, stake_key: C2 });
        u.put({ utxo_ref: "11".repeat(32) + ":2", tx_out: "{}", tx_hash: "11".repeat(32), address: "addr3", lovelace: "7", reference_script_hash: null, stake_key: C3 });
        expect(w.initPots(5, 1_000_000n).reserves).toBe(1_000_000n);
        w.addFee(30n); w.addDonation(4n);
        w.creditRewards(new Map([[C1, 100n], [C3, 1n]]));
        w.setOpcertCounter(P1, 3, 10); w.noteBlockMade(P1, 5); w.noteBlockMade(P1, 5);
        st.commitBlock();
        expect(r.isRegistered(C1)).toBe(true);
        expect(r.delegationOf(C2)).toBe(P1);
        expect(r.rewardBalance(C1)).toBe(100n);
        expect(r.pots()).toEqual({ reserves: 1_000_000n, treasury: 0n, feePot: 30n, donationPot: 4n, initializedEpoch: 5 });
        expect(r.opcert(P1)).toEqual({ counter: 3, slot: 10 });
        expect(r.blocksMade(5).get(P1)).toBe(2);
        expect(r.pool(P1)!.params!.cost).toBe("340");

        // block 2 (boundary into epoch 6): snapshot, re-registration pending, retirement, withdrawal
        st.beginBlock(h(2), h(1), 20);
        const snap = w.takeStakeSnapshot(6);
        expect(snap).toEqual({ pools: 2, total: 1000n + 100n + 500n + 7n + 1n });
        expect(r.snapshotPoolStake(6).get(P1)).toBe(1600n);
        expect(r.snapshotMembers(6).get(P2)).toEqual([{ credential: C3, stake: 8n }]);
        expect(w.takeStakeSnapshot(6)).toEqual(snap); // idempotent
        w.recordPoolRegistration(P1, "aa".repeat(32), 20, { pledge: "2", cost: "340", marginNum: "1", marginDen: "100", rewardAccount: C1, owners: [C1] });
        expect(r.pool(P1)!.params!.pledge).toBe("1");           // not yet
        expect(w.promotePendingPoolParams()).toBe(1);
        expect(r.pool(P1)!.params!.pledge).toBe("2");
        w.recordPoolRetirement(P2, 6);
        const retired = w.retirePoolsAtEpoch(6);
        expect(retired).toEqual([{ poolId: P2, rewardAccount: null, delegationsRemoved: 1 }]);
        expect(r.pool(P2)).toBeNull();
        expect(r.delegationOf(C3)).toBeNull();
        expect(w.debitReward(C1, 60n)).toBe(true);
        expect(w.debitReward(C2, 1n)).toBe(false); // no reward row: untouched, like the SQL UPDATE
        expect(r.rewardBalance(C1)).toBe(40n);
        expect(w.settleDonations()).toBe(4n);
        w.updatePots({ reserves: -10n, treasury: 10n, resetFees: true });
        expect(r.pots()).toEqual({ reserves: 999_990n, treasury: 14n, feePot: 0n, donationPot: 0n, initializedEpoch: 5 });
        w.queuePendingRewards(7, new Map([[C1, 5n], [C3, 6n]]));
        w.recordPotSnapshot(6, { reserves: 999_990n, treasury: 14n, feesCollected: 30n });
        w.refreshPotSnapshot(6, { reserves: 999_980n, treasury: 24n });
        expect(r.potSnapshot(6)).toEqual({ reserves: 999_980n, treasury: 24n, feesCollected: 30n });
        w.queueMir(6, 0, [{ stakeKey: C1, amount: 9n }, { stakeKey: null, amount: 2n }]);
        w.recordGenesisDelegation("cc".repeat(28), "dd".repeat(28), "ee".repeat(32), 0);
        w.recordGenesisDelegation("cc".repeat(28), "d1".repeat(28), "e1".repeat(32), 100);
        st.commitBlock();
        expect(r.pendingMir(7).map((m) => [m.stakeKey, m.amount])).toEqual([[C1, 9n], [null, 2n]]);
        expect(r.genesisDelegsAt(50).get("cc".repeat(28))!.delegate).toBe("dd".repeat(28));
        expect(r.genesisDelegsAt(100).get("cc".repeat(28))!.delegate).toBe("d1".repeat(28));

        // block 3: pay pending rewards, deregister
        st.beginBlock(h(3), h(2), 30);
        expect(w.payPendingRewards(7)).toEqual({ accounts: 2, total: 11n });
        expect(r.rewardBalance(C1)).toBe(45n);
        expect(r.pendingRewards(7).size).toBe(0);
        w.deregisterStake(C2);
        w.deletePendingMir(7);
        st.commitBlock();
        expect(r.isRegistered(C2)).toBe(false);
        expect(r.delegationOf(C2)).toBeNull();
        expect(r.pendingMir(7)).toEqual([]);
        expect([...r.registeredStakeKeys()].sort()).toEqual([C1, C3].sort());

        // rollback block 3 restores block-2 state; promote everything and read from LMDB alone
        st.rollbackTo(h(2)); st.selectTip(h(2));
        expect(r.isRegistered(C2)).toBe(true);
        expect(r.rewardBalance(C1)).toBe(40n);
        await st.promoteDeep(0);
        expect(st.volatileCount()).toBe(0);
        expect(r.pots()).toEqual({ reserves: 999_990n, treasury: 14n, feePot: 0n, donationPot: 0n, initializedEpoch: 5 });
        expect(r.snapshotTotals(6)).toEqual({ total: 1608n, pools: 2 });
        expect(r.latestSnapshotEpoch()).toBe(6);
        expect(r.rewardBalances()).toEqual(new Map([[C1, 40n], [C3, 1n]]));
        // direct apply (seeding) bypasses the diffs
        await st.applyDirect(() => { w.putBlocksMade(4, P1, 7); w.putOpcert(P2, 1, 5); });
        expect(r.blocksMade(4).get(P1)).toBe(7);
        expect(r.opcert(P2)).toEqual({ counter: 1, slot: 5 });
        st.close();
    });
});

describe("stakeStore history retention", () => {
    test("pruneEpochBelow removes one epoch slice; oldestEpoch tracks it", async () => {
        const dir = await mkdtemp(join(tmpdir(), "stake-prune-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const w = new StakeWrites(st);
        await st.applyDirect(() => { for (const e of [5, 6, 7]) { w.putBlocksMade(e, pool(1), 3); w.recordRewardPayouts(e, new Map([[cred(1), 10n]])); } });
        expect(w.oldestEpoch("blocks_made")).toBe(5);
        let n = 0;
        await st.applyDirect(() => { n = w.pruneEpochBelow("blocks_made", 5) + w.pruneEpochBelow("reward_payouts", 5); });
        expect(n).toBe(2);
        expect(w.oldestEpoch("blocks_made")).toBe(6);
        expect(w.reads.blocksMade(5).size).toBe(0);
        expect(w.reads.blocksMade(6).get(pool(1))).toBe(3);
        expect(w.reads.rewardPayouts(6).get(cred(1))).toBe(10n);
        st.close();
    });
    test("snapshot pool meta (bug 263): every delegator counted, zero-stake ones too; only owners delegating to the pool", async () => {
        const dir = await mkdtemp(join(tmpdir(), "stake-meta-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const w = new StakeWrites(st), r = w.reads;
        const P1 = pool(1), P2 = pool(2), O1 = cred(1), O2 = cred(2), M = cred(3), Z = cred(4, true);
        st.beginBlock(h(1), h(0), 10);
        w.recordPoolRegistration(P1, "aa".repeat(32), 10, { pledge: "1", cost: "340", marginNum: "1", marginDen: "100", rewardAccount: O1, owners: [O2.toUpperCase(), O1] });
        w.recordPoolRegistration(P2, "bb".repeat(32), 10, { pledge: "1", cost: "340", marginNum: "1", marginDen: "100", rewardAccount: O1, owners: [] });
        for (const c of [O1, O2, M, Z]) w.registerStake(c);
        w.delegate(O1, P1); w.delegate(Z, P1); w.delegate(M, P1); w.delegate(O2, P2); // O2 owns P1 but delegates elsewhere
        w.creditRewards(new Map([[O1, 5n], [M, 7n], [O2, 3n]]));                       // Z holds nothing
        w.takeStakeSnapshot(1);
        st.commitBlock();
        expect(r.snapshotCredentials(1).has(Z)).toBe(false);
        expect(r.snapshotPoolMeta(1).get(P1)).toEqual({ delegators: 3, owners: [O1] });
        expect(r.snapshotPoolMeta(1).get(P2)).toEqual({ delegators: 1, owners: [] });
        st.close();
    });
    test("pool-ranking state (bug 262): written in the boundary block's diff, older epochs pruned, rolled back with the block", async () => {
        const dir = await mkdtemp(join(tmpdir(), "stake-nm-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const w = new StakeWrites(st), r = w.reads;
        const l = (x: number) => Float32Array.from({ length: 100 }, (_, i) => Math.fround(x + i / 7));
        await st.applyDirect(() => { for (const e of [10, 11, 12, 13]) w.putNonMyopic(e, { rewardPot: BigInt(e), likelihoods: new Map([[pool(1), l(e)]]) }); });
        expect(r.nonMyopicEpochs()).toEqual([10, 11, 12, 13]);
        st.beginBlock(h(1), h(0), 1_209_600); // first block of epoch 14
        w.putNonMyopic(14, { rewardPot: 14n, likelihoods: new Map([[pool(1), l(14)], [pool(2), l(-1)]]) });
        st.commitBlock();
        expect(r.nonMyopicEpochs()).toEqual([11, 12, 13, 14]);
        const nm = r.nonMyopic(14)!;
        expect(nm.rewardPot).toBe(14n);
        expect([...nm.likelihoods.keys()]).toEqual([pool(1), pool(2)]);
        expect([...nm.likelihoods.get(pool(2))!]).toEqual([...l(-1)]);
        st.selectTip(st.rollbackToSlot(0).tip);
        expect(r.nonMyopicEpochs()).toEqual([10, 11, 12, 13]);
        expect(r.nonMyopic(14)).toBeNull();
        st.close();
    });
});
