import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../../ledger/LedgerStore";
import { GovReads, GovWrites, type PulserSnapshot } from "../../ledger/govStore";
import { SDB, StakeReads, StakeWrites, cat, hexKey, u32 } from "../../ledger/stakeStore";
import { backfillPulserSnapshot, completePulserPoolDistr, drepDistrOf, drepStatesOf, PULSER_VERSION, snapshotAtBoundary } from "./govPulser";
import type { GovTxModel } from "./govTxDecode";
import type { RatifyInput } from "./ratify";

const tmp: string[] = [];
afterAll(async () => { for (const d of tmp) await rm(d, { recursive: true, force: true }); });
const h = (n: number) => { const x = new Uint8Array(32); x[0] = n; return x; };
const D1 = "d1".repeat(28), SD = "01" + "d2".repeat(28), A1 = "a1".repeat(28), A2 = "01" + "a2".repeat(28), POOL = "f1".repeat(28), ZP = "e9".repeat(28), HOT = "01" + "e1".repeat(28);
const TX = "44".repeat(32), ID = `${TX}:0`;
const tx = (m: Partial<GovTxModel>): GovTxModel => ({ txId: TX, certs: [], proposals: [], votes: [], withdrawals: [], treasuryValue: null, ...m });

describe("the frozen DRep pulser snapshot (bug 167)", () => {
    test("round-trips through the store, binary DRep states included", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pulser-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        st.beginBlock(h(1), h(0), 10);
        const gw = new GovWrites(st);
        const snap: PulserSnapshot = { epoch: 7, boundary: { slot: 9, hash: "ab".repeat(32) }, source: "boundary", proposals: [{ actionId: ID, cc: [[HOT, 1]], drep: [[D1, 0], [SD, 2]], spo: [[POOL, 1]] }], drepDistr: [{ type: 0, hash: D1, stake: "5" }, { type: 2, hash: "", stake: "0" }], drepStates: [{ cred: D1, expiry: 30, deposit: "500000000", delegators: [A1, A2] }, { cred: SD, expiry: 31, deposit: "500000000", delegators: [] }], poolDistr: [[POOL, "12"]] };
        gw.putPulserSnapshot(snap);
        st.commitBlock(false);
        expect(gw.reads.pulserSnapshot(7)).toEqual(snap);
        expect(gw.reads.pulserSnapshot(8)).toBeNull();
        expect(gw.reads.pulserEpochs()).toEqual([7]);
        st.beginBlock(h(2), h(1), 20); gw.delPulserSnapshot(7); st.commitBlock(false);
        expect(gw.reads.pulserSnapshot(7)).toBeNull();
        st.close();
    });

    test("the boundary snapshot carries the round's proposals and votes, zero-stake DReps and every DRep's delegators", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pulser-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        st.beginBlock(h(1), h(0), 10);
        const gw = new GovWrites(st), sw = new StakeWrites(st);
        gw.putDRep(D1, { isScript: 0, deposit: "500000000", registeredSlot: 1, lastActiveEpoch: 5, expiryEpoch: 36 });
        gw.putDRep(SD, { isScript: 1, deposit: "500000000", registeredSlot: 1, lastActiveEpoch: 5, expiryEpoch: 36 });
        gw.putDRepDelegation(A1, { type: 0, hash: D1 }); gw.putDRepDelegation(A2, { type: 1, hash: SD.slice(2) }); gw.putDRepDelegation("b1".repeat(28), { type: 2, hash: null });
        gw.putDRepStake(7, 0, D1, 5n); // SD's delegator holds nothing: no stored row, a zero entry in the ledger's distribution
        sw.putSnapshotPool(7, POOL, 12n);
        st.put(SDB.snapPoolZero, cat(u32(7), hexKey(ZP)), Uint8Array.of(1)); // a pool whose delegators hold nothing (bug 247; the snapshot writer's key form)
        sw.delegate(A1, ZP);
        st.commitBlock(false);
        const src = { gov: gw.reads, stake: new StakeReads(st), now: { gov: gw.reads, stake: new StakeReads(st) } };
        const input: RatifyInput = { epoch: 7, params: {} as any, committee: null, committeeCreds: new Map(), proposals: [{ id: ID, kind: "Info", prev: null, expiresAfter: 12, ccVotes: new Map([[HOT, 1]]), drepVotes: new Map([[SD, 2], [D1, 0]]), spoVotes: new Map([[POOL, 1]]) }], drepDistr: new Map([[D1, 5n]]), drepExpiry: new Map(), poolDistr: new Map([[POOL, 12n]]), poolDefault: new Map(), roots: { pparams: null, hardfork: null, committee: null, constitution: null }, treasury: 0n };
        const snap = snapshotAtBoundary(input, src, { slot: 9, hash: "ab".repeat(32) }, new Map());
        expect(snap.proposals).toEqual([{ actionId: ID, cc: [[HOT, 1]], drep: [[SD, 2], [D1, 0]], spo: [[POOL, 1]] }]);
        expect(snap.drepDistr).toEqual([{ type: 0, hash: D1, stake: "5" }, { type: 1, hash: SD.slice(2), stake: "0" }, { type: 2, hash: "", stake: "0" }]);
        expect(drepStatesOf(gw.reads)).toEqual([{ cred: SD, expiry: 36, deposit: "500000000", delegators: [A2] }, { cred: D1, expiry: 36, deposit: "500000000", delegators: [A1] }]);
        expect(snap.poolDistr).toEqual([[ZP, "0"], [POOL, "12"]]); // the zero-stake pool is listed (bug 247)
        expect(snap.version).toBe(PULSER_VERSION);
        expect(drepDistrOf(7, src).length).toBe(3);
        // a snapshot a boundary wrote before bug 247: completed on read / at restart, a deposit landing on the zero-stake pool included
        const legacy = { ...snap, version: undefined, poolDistr: [[POOL, "12"]] as Array<[string, string]> };
        const done = completePulserPoolDistr(legacy, new StakeReads(st), [{ returnAccount: A1, deposit: 3n }]);
        expect(done.poolDistr).toEqual([[ZP, "3"], [POOL, "12"]]);
        expect(done.version).toBe(PULSER_VERSION);
        expect(completePulserPoolDistr(done, new StakeReads(st), [])).toBe(done); // idempotent
        st.close();
    });

    test("the backfill takes the votes from the chain up to the epoch's first slot and the DRep states from the boundary block's view", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pulser-")); tmp.push(dir);
        const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024 });
        await st.setAnchor({ slot: 0, hash: h(0) });
        const gw = new GovWrites(st), sw = new StakeWrites(st);
        const E = 7, start = E * 86400; // preview geometry (setEpochNetwork below)
        const { setEpochNetwork } = await import("../../utils/epochFromSlotCalculations");
        setEpochNetwork("preview");
        // block 1 (epoch 6): the proposal, D1's vote, D1 registered, A1 delegated to D1
        st.beginBlock(h(1), h(0), start - 100);
        gw.putProposal({ actionId: ID, seq: 1, kind: "Info", prevActionId: null, deposit: "1", returnAccount: A1, payload: "{}", proposedEpoch: 6, expiresEpoch: 12, status: "active", decidedEpoch: null });
        gw.putDRep(D1, { isScript: 0, deposit: "500000000", registeredSlot: 1, lastActiveEpoch: 6, expiryEpoch: 37 });
        gw.putDRepDelegation(A1, { type: 0, hash: D1 });
        gw.putVote({ actionId: ID, voterKind: 2, voterHash: D1, vote: 1, slot: start - 100 });
        st.commitBlock(false);
        // block 2 (the boundary block, last of epoch 6): nothing governance-related
        st.beginBlock(h(2), h(1), start - 10); st.commitBlock(false);
        // block 3 (first of epoch 7): the boundary's stake snapshot, then D1 unregisters (its vote leaves the live proposal) and A1 re-delegates
        st.beginBlock(h(3), h(2), start + 5);
        gw.putDRepStake(E, 0, D1, 9n); sw.putSnapshotPool(E, POOL, 12n);
        gw.delDRep(D1); gw.delDRepDelegation(A1); gw.putDRepDelegation(A1, { type: 2, hash: null }); gw.delVote(ID, 2, D1);
        st.commitBlock(false);
        const blocks = [
            { slot: start - 100, hash: h(1), txs: [tx({ votes: [{ voterKind: 2, voterHash: D1, actionId: ID, vote: 1 }] })] },
            { slot: start - 10, hash: h(2), txs: [] },
            { slot: start + 5, hash: h(3), txs: [tx({ certs: [{ index: 0, type: 17, cred: D1, coin: 500n }] })] },
        ];
        // the test blocks carry decoded transactions (the block walker decodes bytes; scripts/gov-pulser-backfill.ts exercises it on real chunks)
        type Blk = { slot: number; hash: Uint8Array; bytes: Uint8Array; txs: GovTxModel[] };
        const chain = async function* (from: number, to: number): AsyncGenerator<Blk> { for (const b of blocks) if (b.slot >= from && b.slot <= to) yield { slot: b.slot, hash: b.hash, bytes: new Uint8Array(0), txs: b.txs }; };
        const { PointView, resolveAcquireTarget } = await import("../../network/n2c/lsq/view");
        const viewAt = (slot: number, hash: Uint8Array) => { const r = resolveAcquireTarget(st, { kind: "point", slot: BigInt(slot), hash: Buffer.from(hash).toString("hex") }); if ("failure" in r) return null; const pv = new PointView(st, r.chain) as unknown as ConstructorParameters<typeof GovReads>[0]; return { gov: new GovReads(pv), stake: new StakeReads(pv) }; };
        const r = await backfillPulserSnapshot({ epoch: E, ledger: st, chain, now: { gov: gw.reads, stake: new StakeReads(st) }, viewAt, txsOfBlock: (b) => (b as Blk).txs.map((m) => ({ slot: b.slot, model: m })) });
        expect(r.snap.source).toBe("backfill-exact");
        expect(r.snap.boundary?.slot).toBe(start - 10);
        expect(r.snap.proposals).toEqual([{ actionId: ID, cc: [], drep: [[D1, 1]], spo: [] }]); // the vote as of the boundary, although D1 unregistered since
        expect(r.snap.drepStates).toEqual([{ cred: D1, expiry: 37, deposit: "500000000", delegators: [A1] }]); // D1 as of the boundary block
        expect(r.snap.drepDistr).toEqual([{ type: 0, hash: D1, stake: "9" }]);
        expect(gw.reads.votes(ID)).toEqual([]); // the live store no longer holds the vote
        st.close();
    });
});
