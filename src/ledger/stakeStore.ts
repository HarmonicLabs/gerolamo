/**
 * Stake, pools, rewards, pots and snapshots over the LedgerStore (docs/PLAN_LMDB_LEDGER.md phase 2).
 *
 * Databases (keys big-endian; a "typed credential" is the 28-byte key hash, or 0x01 ‖ hash for a
 * script credential — the same bytes SQLite's `rewards.stake_credentials` holds and the typed hex
 * of db/stakeCred.ts):
 *   stake         typedCred → 0x01                          registered stake credentials
 *   deleg         typedCred → poolId(28)                    current pool delegation
 *   pointer       u64 slot ‖ u32 txIx ‖ u32 certIx → typedCred
 *   reward        typedCred → u64                           reward account balance (counter; a zero balance has no key)
 *   pool          poolId → JSON PoolRecord                  registered pools
 *   pool_pending  poolId → JSON PoolPendingRecord           re-registrations waiting for the boundary
 *   pool_relays   poolId → JSON { relays, updatedSlot }
 *   opcert        poolId → u32 counter ‖ u64 slot
 *   blocks_made   u32 epoch ‖ poolId → u64                  counter
 *   gdeleg        genesisKeyHash(28) ‖ u64 effectiveSlot → JSON { delegate, vrf }
 *   mir           u32 recordedEpoch ‖ u64 seq → JSON { source, stakeKey, amount }
 *   pots          "reserves" | "treasury" | "fee_pot" | "donation_pot" → u64 counters; "init_epoch" → u32
 *   snap_cred     u32 takenAt ‖ typedCred → poolId ‖ u64 stake
 *   snap_pool     u32 takenAt ‖ poolId → u64 stake
 *   snap_pparams  u32 takenAt ‖ poolId → JSON { vrf, params }
 *   snap_totals   u32 takenAt → u64 total ‖ u32 pools
 *   pending_rew   u32 payAt ‖ typedCred → u64                counter
 *   reward_epochs u32 perfEpoch → JSON
 *   reward_payouts u32 perfEpoch ‖ typedCred → u64
 *   reward_pool_epochs u32 perfEpoch ‖ poolId → JSON
 *   pot_snap      u32 epoch → JSON { reserves, treasury, feesCollected }
 *   counters      "mir_seq" → u64
 *   snap_pool_meta u32 takenAt ‖ poolId → JSON { delegators, owners }: the snapshot's delegator count and self-delegated owners per pool
 *   nonmyopic     u32 epoch → `esNonMyopic` of the epoch (consensus/nonMyopic.ts encoding: reward pot, per-pool likelihoods)
 */
import type { PoolRewardParams } from "../db/leaderState";
import { decodeNonMyopic, encodeNonMyopic, type NonMyopicState } from "../consensus/nonMyopic";
import { readU64, u64 } from "./LedgerDiff";
import type { LedgerStore, LedgerView } from "./LedgerStore";
import { DB_STAKE_BAL } from "./utxoStore";

export const SDB = {
    stake: "stake", deleg: "deleg", pointer: "pointer", reward: "reward", pool: "pool", poolPending: "pool_pending", poolRelays: "pool_relays",
    opcert: "opcert", blocksMade: "blocks_made", gdeleg: "gdeleg", mir: "mir", pots: "pots", snapCred: "snap_cred", snapPool: "snap_pool",
    snapPParams: "snap_pparams", snapTotals: "snap_totals", pendingRew: "pending_rew", rewardEpochs: "reward_epochs", rewardPayouts: "reward_payouts",
    rewardPoolEpochs: "reward_pool_epochs", potSnap: "pot_snap", counters: "counters",
    /** Raw PoolParams CBOR (the 9-element array cardano-node's queries return) of the current and the pending registration. */
    poolCbor: "pool_cbor", poolCborPending: "pool_cbor_pend",
    /** u32 takenAt ‖ poolId → empty: pools with delegators whose stake summed to zero at the snapshot (the ledger's pool distribution lists them at 0). */
    snapPoolZero: "snap_pool_zero",
    /** u32 takenAt ‖ poolId → JSON { delegators, owners }: what the ledger's `StakePoolSnapShot` keeps beyond the stake (`spssNumDelegators`, `spssSelfDelegatedOwners`). */
    snapPoolMeta: "snap_pool_meta",
    /** u32 epoch → the ledger's pool-ranking state (`esNonMyopic`) as the reward update applied at that boundary left it. */
    nonMyopic: "nonmyopic",
} as const;

/** Raw pool parameters seen in the transaction being applied (set by the applier, consumed by the registration). */
const rawPoolParams = new Map<string, Uint8Array>();
export function noteRawPoolParams(poolId: string, paramsCbor: Uint8Array): void { rawPoolParams.set(poolId.toLowerCase(), paramsCbor); }
export function clearRawPoolParams(): void { rawPoolParams.clear(); }

export interface PoolRecord { vrf: string; registeredSlot: number; retiringEpoch: number | null; params: PoolRewardParams | null }
export interface PoolPendingRecord { vrf: string; registeredSlot: number; params: PoolRewardParams | null }
export interface PotsRecord { reserves: bigint; treasury: bigint; feePot: bigint; donationPot: bigint; initializedEpoch: number }
export interface MirRow { seq: bigint; recordedEpoch: number; source: number; stakeKey: string | null; amount: bigint }

const enc = new TextEncoder(), dec = new TextDecoder();
export const hexKey = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.toLowerCase(), "hex"));
export const keyHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const rdU32 = (b: Uint8Array, o = 0): number => new DataView(b.buffer, b.byteOffset).getUint32(o, false);
export function cat(...parts: Uint8Array[]): Uint8Array { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; }
const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
const unjson = <T>(b: Uint8Array | undefined): T | null => (b ? (JSON.parse(dec.decode(b)) as T) : null);
const EMPTY = new Uint8Array(0);
const ONE = Uint8Array.of(1);
const pointerKey = (slot: number, txIx: number, certIx: number) => cat(u64(BigInt(slot)), u32(txIx), u32(certIx));
const POT_KEYS = { reserves: enc.encode("reserves"), treasury: enc.encode("treasury"), feePot: enc.encode("fee_pot"), donationPot: enc.encode("donation_pot"), initEpoch: enc.encode("init_epoch") };
const MIR_SEQ = enc.encode("mir_seq");

/** Reads over the store or a frozen view. */
export class StakeReads {
    constructor(private readonly s: LedgerStore | LedgerView) {}

    isRegistered(typedHex: string): boolean { return this.s.get(SDB.stake, hexKey(typedHex)) !== undefined; }
    registeredStakeKeys(): Set<string> { const out = new Set<string>(); for (const [k] of this.s.range(SDB.stake, EMPTY)) out.add(keyHex(k)); return out; }
    delegationOf(typedHex: string): string | null { const v = this.s.get(SDB.deleg, hexKey(typedHex)); return v ? keyHex(v) : null; }
    allDelegations(): Array<[string, string]> { const out: Array<[string, string]> = []; for (const [k, v] of this.s.range(SDB.deleg, EMPTY)) out.push([keyHex(k), keyHex(v)]); return out; }
    pointer(slot: number, txIx: number, certIx: number): string | null { const v = this.s.get(SDB.pointer, pointerKey(slot, txIx, certIx)); return v ? keyHex(v) : null; }
    rewardBalance(typedHex: string): bigint { return this.s.getU64(SDB.reward, hexKey(typedHex)); }
    /** Every reward account with a non-zero balance. */
    rewardBalances(): Map<string, bigint> { const out = new Map<string, bigint>(); for (const [k, v] of this.s.range(SDB.reward, EMPTY)) out.set(keyHex(k), readU64(v)); return out; }

    pool(poolId: string): PoolRecord | null { return unjson<PoolRecord>(this.s.get(SDB.pool, hexKey(poolId))); }
    poolCbor(poolId: string): Uint8Array | null { return this.s.get(SDB.poolCbor, hexKey(poolId)) ?? null; }
    pools(): Map<string, PoolRecord> { const out = new Map<string, PoolRecord>(); for (const [k, v] of this.s.range(SDB.pool, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    pendingPools(): Map<string, PoolPendingRecord> { const out = new Map<string, PoolPendingRecord>(); for (const [k, v] of this.s.range(SDB.poolPending, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    poolRelays(): Array<{ pool: string; host: string; port: number }> {
        const out: Array<{ pool: string; host: string; port: number }> = [];
        for (const [k, v] of this.s.range(SDB.poolRelays, EMPTY)) { try { for (const x of (JSON.parse(dec.decode(v)) as { relays: Array<{ host: string; port: number }> }).relays) if (x && typeof x.host === "string" && Number.isInteger(x.port)) out.push({ pool: keyHex(k), host: x.host, port: x.port }); } catch { /* skip */ } }
        return out;
    }
    opcert(poolId: string): { counter: number; slot: number } | null { const v = this.s.get(SDB.opcert, hexKey(poolId)); return v && v.length >= 12 ? { counter: rdU32(v, 0), slot: Number(readU64(v.subarray(4, 12))) } : null; }
    blocksMade(epoch: number): Map<string, number> { const out = new Map<string, number>(); for (const [k, v] of this.s.range(SDB.blocksMade, u32(epoch))) out.set(keyHex(k.subarray(4)), Number(readU64(v))); return out; }
    genesisDelegsAt(slot: number): Map<string, { delegate: string; vrf: string }> {
        const best = new Map<string, { slot: number; delegate: string; vrf: string }>();
        for (const [k, v] of this.s.range(SDB.gdeleg, EMPTY)) {
            const gk = keyHex(k.subarray(0, 28)), eff = Number(readU64(k.subarray(28, 36)));
            if (eff > slot) continue;
            const cur = best.get(gk);
            if (!cur || eff >= cur.slot) { const r = JSON.parse(dec.decode(v)) as { delegate: string; vrf: string }; best.set(gk, { slot: eff, ...r }); }
        }
        const out = new Map<string, { delegate: string; vrf: string }>();
        for (const [k, v] of best) out.set(k, { delegate: v.delegate, vrf: v.vrf });
        return out;
    }
    pendingMir(beforeEpoch: number): MirRow[] {
        const out: MirRow[] = [];
        for (const [k, v] of this.s.range(SDB.mir, EMPTY)) {
            const recordedEpoch = rdU32(k, 0);
            if (recordedEpoch >= beforeEpoch) continue;
            const r = JSON.parse(dec.decode(v)) as { source: number; stakeKey: string | null; amount: string };
            out.push({ seq: readU64(k.subarray(4, 12)), recordedEpoch, source: r.source, stakeKey: r.stakeKey, amount: BigInt(r.amount) });
        }
        return out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    }
    pots(): PotsRecord | null {
        const init = this.s.get(SDB.pots, POT_KEYS.initEpoch);
        if (!init) return null;
        return { reserves: this.s.getU64(SDB.pots, POT_KEYS.reserves), treasury: this.s.getU64(SDB.pots, POT_KEYS.treasury), feePot: this.s.getU64(SDB.pots, POT_KEYS.feePot), donationPot: this.s.getU64(SDB.pots, POT_KEYS.donationPot), initializedEpoch: rdU32(init) };
    }
    snapshotTotals(takenAt: number): { total: bigint; pools: number } | null { const v = this.s.get(SDB.snapTotals, u32(takenAt)); return v && v.length >= 12 ? { total: readU64(v), pools: rdU32(v, 8) } : null; }
    snapshotPoolStake(takenAt: number): Map<string, bigint> { const out = new Map<string, bigint>(); for (const [k, v] of this.s.range(SDB.snapPool, u32(takenAt))) out.set(keyHex(k.subarray(4)), readU64(v)); return out; }
    snapshotMembers(takenAt: number): Map<string, Array<{ credential: string; stake: bigint }>> {
        const out = new Map<string, Array<{ credential: string; stake: bigint }>>();
        for (const [k, v] of this.s.range(SDB.snapCred, u32(takenAt))) {
            const pool = keyHex(v.subarray(0, 28));
            let list = out.get(pool); if (!list) { list = []; out.set(pool, list); }
            list.push({ credential: keyHex(k.subarray(4)), stake: readU64(v.subarray(28, 36)) });
        }
        return out;
    }
    snapshotCredentials(takenAt: number): Map<string, { pool: string; stake: bigint }> {
        const out = new Map<string, { pool: string; stake: bigint }>();
        for (const [k, v] of this.s.range(SDB.snapCred, u32(takenAt))) out.set(keyHex(k.subarray(4)), { pool: keyHex(v.subarray(0, 28)), stake: readU64(v.subarray(28, 36)) });
        return out;
    }
    snapshotPoolParams(takenAt: number): Map<string, { vrf: string; params: PoolRewardParams | null }> { const out = new Map<string, { vrf: string; params: PoolRewardParams | null }>(); for (const [k, v] of this.s.range(SDB.snapPParams, u32(takenAt))) out.set(keyHex(k.subarray(4)), JSON.parse(dec.decode(v))); return out; }
    /** Per pool of the snapshot: delegators (zero-stake ones included) and the owners delegating to it; empty for snapshots taken before it was kept. */
    snapshotPoolMeta(takenAt: number): Map<string, { delegators: number; owners: string[] }> { const out = new Map<string, { delegators: number; owners: string[] }>(); for (const [k, v] of this.s.range(SDB.snapPoolMeta, u32(takenAt))) out.set(keyHex(k.subarray(4)), JSON.parse(dec.decode(v))); return out; }
    snapshotZeroPools(takenAt: number): string[] { const out: string[] = []; for (const [k] of this.s.range(SDB.snapPoolZero, u32(takenAt))) out.push(keyHex(k.subarray(4))); return out; }
    snapshotEpochs(): number[] { const out: number[] = []; for (const [k] of this.s.range(SDB.snapTotals, EMPTY)) out.push(rdU32(k)); return out; }
    latestSnapshotEpoch(): number | null { const e = this.snapshotEpochs(); return e.length ? Math.max(...e) : null; }
    pendingRewards(payAt: number): Map<string, bigint> { const out = new Map<string, bigint>(); for (const [k, v] of this.s.range(SDB.pendingRew, u32(payAt))) out.set(keyHex(k.subarray(4)), readU64(v)); return out; }
    rewardEpochDone(perfEpoch: number): boolean { return this.s.get(SDB.rewardEpochs, u32(perfEpoch)) !== undefined; }
    rewardEpoch(perfEpoch: number): Record<string, string | number> | null { return unjson(this.s.get(SDB.rewardEpochs, u32(perfEpoch))); }
    rewardPayouts(perfEpoch: number): Map<string, bigint> { const out = new Map<string, bigint>(); for (const [k, v] of this.s.range(SDB.rewardPayouts, u32(perfEpoch))) out.set(keyHex(k.subarray(4)), readU64(v)); return out; }
    poolRewards(perfEpoch: number): Map<string, Record<string, string | number>> { const out = new Map<string, Record<string, string | number>>(); for (const [k, v] of this.s.range(SDB.rewardPoolEpochs, u32(perfEpoch))) out.set(keyHex(k.subarray(4)), JSON.parse(dec.decode(v))); return out; }
    potSnapshot(epoch: number): { reserves: bigint; treasury: bigint; feesCollected: bigint } | null { const r = unjson<{ reserves: string; treasury: string; feesCollected: string }>(this.s.get(SDB.potSnap, u32(epoch))); return r ? { reserves: BigInt(r.reserves), treasury: BigInt(r.treasury), feesCollected: BigInt(r.feesCollected) } : null; }
    stakeBalance(typedHex: string): bigint { return this.s.getU64(DB_STAKE_BAL, hexKey(typedHex)); }
    /** `esNonMyopic` as of `epoch` (written at its boundary), or null when not recorded. */
    nonMyopic(epoch: number): NonMyopicState | null { const v = this.s.get(SDB.nonMyopic, u32(epoch)); return v ? decodeNonMyopic(epoch, v) : null; }
    nonMyopicEpochs(): number[] { const out: number[] = []; for (const [k] of this.s.range(SDB.nonMyopic, EMPTY)) out.push(rdU32(k)); return out; }
}

/** Writes: inside an open block of the store. */
export class StakeWrites {
    readonly reads: StakeReads;
    constructor(private readonly s: LedgerStore) { this.reads = new StakeReads(s); }

    // ---- credentials
    registerStake(typedHex: string): void { this.s.put(SDB.stake, hexKey(typedHex), ONE); }
    deregisterStake(typedHex: string): void { const k = hexKey(typedHex); this.s.del(SDB.stake, k); this.s.del(SDB.deleg, k); }
    delegate(typedHex: string, poolId: string): void { this.s.put(SDB.deleg, hexKey(typedHex), hexKey(poolId)); }
    putPointer(slot: number, txIx: number, certIx: number, typedHex: string): void { this.s.put(SDB.pointer, pointerKey(slot, txIx, certIx), hexKey(typedHex)); }

    // ---- rewards
    /** Withdrawal: like SQLite's UPDATE, a credential without a reward row is untouched. */
    debitReward(typedHex: string, amount: bigint): boolean {
        if (amount <= 0n) return true;
        const cur = this.s.getU64(SDB.reward, hexKey(typedHex));
        if (cur < amount) return false;
        this.s.addU64(SDB.reward, hexKey(typedHex), -amount);
        return true;
    }
    creditRewards(amounts: Map<string, bigint>): bigint { let total = 0n; for (const [c, a] of amounts) { if (a <= 0n) continue; this.s.addU64(SDB.reward, hexKey(c), a); total += a; } return total; }
    queuePendingRewards(payAt: number, paid: Map<string, bigint>): void { for (const [c, a] of paid) if (a > 0n) this.s.addU64(SDB.pendingRew, cat(u32(payAt), hexKey(c)), a); }
    payPendingRewards(epoch: number): { accounts: number; total: bigint } {
        const rows = this.reads.pendingRewards(epoch);
        let total = 0n;
        for (const [c, a] of rows) { total += a; this.s.addU64(SDB.reward, hexKey(c), a); this.s.del(SDB.pendingRew, cat(u32(epoch), hexKey(c))); }
        return { accounts: rows.size, total };
    }
    recordRewardEpoch(perfEpoch: number, r: { rewardPot: bigint; treasuryDelta: bigint; paid: bigint; unclaimed: bigint; pools: number; accounts: number }): void {
        this.s.put(SDB.rewardEpochs, u32(perfEpoch), json({ rewardPot: r.rewardPot.toString(), treasuryDelta: r.treasuryDelta.toString(), paid: r.paid.toString(), unclaimed: r.unclaimed.toString(), pools: r.pools, accounts: r.accounts }));
    }
    recordRewardPayouts(perfEpoch: number, paid: Map<string, bigint>): void { for (const [c, a] of paid) if (a > 0n) this.s.put(SDB.rewardPayouts, cat(u32(perfEpoch), hexKey(c)), u64(a)); }
    recordPoolRewards(perfEpoch: number, pools: Array<{ poolId: string; maxPool: bigint; poolReward: bigint; operator: bigint; members: bigint; ownerStake: bigint; stake: bigint; blocks: bigint }>): void {
        for (const p of pools) this.s.put(SDB.rewardPoolEpochs, cat(u32(perfEpoch), hexKey(p.poolId)), json({ maxPool: p.maxPool.toString(), poolReward: p.poolReward.toString(), operator: p.operator.toString(), members: p.members.toString(), ownerStake: p.ownerStake.toString(), stake: p.stake.toString(), blocks: Number(p.blocks) }));
    }

    /** The pool-ranking state of `epoch`; epochs more than three before it are dropped (a rollback past a boundary restores them from the diff). */
    putNonMyopic(epoch: number, nm: { rewardPot: bigint; likelihoods: ReadonlyMap<string, Float32Array> }): void {
        this.s.put(SDB.nonMyopic, u32(epoch), encodeNonMyopic(nm));
        for (const e of this.reads.nonMyopicEpochs()) if (e < epoch - 3) this.s.del(SDB.nonMyopic, u32(e));
    }

    // ---- pots
    initPots(epoch: number, reserves: bigint): PotsRecord {
        const cur = this.reads.pots();
        if (cur) return cur;
        this.s.put(SDB.pots, POT_KEYS.initEpoch, u32(epoch));
        this.s.addU64(SDB.pots, POT_KEYS.reserves, reserves);
        return { reserves, treasury: 0n, feePot: 0n, donationPot: 0n, initializedEpoch: epoch };
    }
    addFee(fee: bigint): void { if (fee !== 0n && this.reads.pots()) this.s.addU64(SDB.pots, POT_KEYS.feePot, fee); }
    addDonation(a: bigint): void { if (a > 0n && this.reads.pots()) this.s.addU64(SDB.pots, POT_KEYS.donationPot, a); }
    settleDonations(): bigint {
        const p = this.reads.pots();
        if (!p || p.donationPot <= 0n) return 0n;
        this.s.addU64(SDB.pots, POT_KEYS.treasury, p.donationPot);
        this.s.addU64(SDB.pots, POT_KEYS.donationPot, -p.donationPot);
        return p.donationPot;
    }
    updatePots(delta: { reserves: bigint; treasury: bigint; resetFees: boolean }): void {
        const p = this.reads.pots();
        if (!p) return;
        if (delta.reserves !== 0n) this.s.addU64(SDB.pots, POT_KEYS.reserves, delta.reserves);
        if (delta.treasury !== 0n) this.s.addU64(SDB.pots, POT_KEYS.treasury, delta.treasury);
        if (delta.resetFees && p.feePot !== 0n) this.s.addU64(SDB.pots, POT_KEYS.feePot, -p.feePot);
    }
    recordPotSnapshot(epoch: number, pots: { reserves: bigint; treasury: bigint; feesCollected: bigint }): void { this.s.put(SDB.potSnap, u32(epoch), json({ reserves: pots.reserves.toString(), treasury: pots.treasury.toString(), feesCollected: pots.feesCollected.toString() })); }
    refreshPotSnapshot(epoch: number, pots: { reserves: bigint; treasury: bigint }): void {
        const cur = this.reads.potSnapshot(epoch);
        if (!cur) return;
        this.recordPotSnapshot(epoch, { reserves: pots.reserves, treasury: pots.treasury, feesCollected: cur.feesCollected });
    }

    // ---- pools
    recordPoolRegistration(poolId: string, vrf: string, slot: number, params: PoolRewardParams | null): void {
        const id = poolId.toLowerCase(), k = hexKey(id);
        const existing = this.reads.pool(id);
        const raw = rawPoolParams.get(id);
        rawPoolParams.delete(id);
        if (!existing) { this.s.put(SDB.pool, k, json({ vrf: vrf.toLowerCase(), registeredSlot: slot, retiringEpoch: null, params } satisfies PoolRecord)); if (raw) this.s.put(SDB.poolCbor, k, raw); return; }
        if (raw) this.s.put(SDB.poolCborPending, k, raw);
        if (existing.retiringEpoch !== null) this.s.put(SDB.pool, k, json({ ...existing, retiringEpoch: null } satisfies PoolRecord));
        this.s.put(SDB.poolPending, k, json({ vrf: vrf.toLowerCase(), registeredSlot: slot, params } satisfies PoolPendingRecord));
    }
    promotePendingPoolParams(): number {
        const pending = this.reads.pendingPools();
        for (const [id, p] of pending) {
            const cur = this.reads.pool(id);
            if (cur) this.s.put(SDB.pool, hexKey(id), json({ vrf: p.vrf, registeredSlot: p.registeredSlot, retiringEpoch: cur.retiringEpoch, params: p.params ?? cur.params } satisfies PoolRecord));
            this.s.del(SDB.poolPending, hexKey(id));
            const raw = this.s.get(SDB.poolCborPending, hexKey(id));
            if (raw) { if (cur) this.s.put(SDB.poolCbor, hexKey(id), raw); this.s.del(SDB.poolCborPending, hexKey(id)); }
        }
        return pending.size;
    }
    recordPoolRetirement(poolId: string, epoch: number): void {
        const id = poolId.toLowerCase();
        const cur = this.reads.pool(id);
        if (cur) this.s.put(SDB.pool, hexKey(id), json({ ...cur, retiringEpoch: epoch } satisfies PoolRecord));
    }
    /** POOLREAP: pools whose retirement epoch arrived leave with the delegations pointing at them. */
    retirePoolsAtEpoch(epoch: number): Array<{ poolId: string; rewardAccount: string | null; delegationsRemoved: number }> {
        const out: Array<{ poolId: string; rewardAccount: string | null; delegationsRemoved: number }> = [];
        const retiring = new Map<string, PoolRecord>();
        for (const [id, p] of this.reads.pools()) if (p.retiringEpoch !== null && p.retiringEpoch <= epoch) retiring.set(id, p);
        if (!retiring.size) return out;
        const removed = new Map<string, number>();
        for (const [cred, pool] of this.reads.allDelegations()) if (retiring.has(pool)) { this.s.del(SDB.deleg, hexKey(cred)); removed.set(pool, (removed.get(pool) ?? 0) + 1); }
        for (const [id, p] of retiring) {
            let rewardAccount: string | null = null;
            const ra = p.params?.rewardAccount ? String(p.params.rewardAccount).toLowerCase() : "";
            if (/^(01)?[0-9a-f]{56}$/.test(ra)) rewardAccount = ra;
            this.s.del(SDB.pool, hexKey(id));
            if (this.s.get(SDB.poolCbor, hexKey(id))) this.s.del(SDB.poolCbor, hexKey(id));
            if (this.s.get(SDB.poolCborPending, hexKey(id))) this.s.del(SDB.poolCborPending, hexKey(id));
            out.push({ poolId: id, rewardAccount, delegationsRemoved: removed.get(id) ?? 0 });
        }
        return out;
    }
    recordPoolRelays(poolId: string, relays: Array<{ host: string; port: number }>, slot: number): void { this.s.put(SDB.poolRelays, hexKey(poolId), json({ relays, updatedSlot: slot })); }

    // ---- headers
    setOpcertCounter(poolId: string, counter: number, slot: number): void {
        const cur = this.reads.opcert(poolId);
        if (cur && cur.counter === counter) return;
        this.s.put(SDB.opcert, hexKey(poolId), cat(u32(counter), u64(BigInt(slot))));
    }
    noteBlockMade(poolId: string, epoch: number): void { this.s.addU64(SDB.blocksMade, cat(u32(epoch), hexKey(poolId)), 1n); }
    recordGenesisDelegation(genesisKeyHash: string, delegate: string, vrf: string, effectiveSlot: number): void { this.s.put(SDB.gdeleg, cat(hexKey(genesisKeyHash), u64(BigInt(effectiveSlot))), json({ delegate: delegate.toLowerCase(), vrf: vrf.toLowerCase() })); }

    // ---- MIR
    queueMir(recordedEpoch: number, source: number, entries: Array<{ stakeKey: string | null; amount: bigint }>): void {
        for (const e of entries) {
            const seq = this.s.getU64(SDB.counters, MIR_SEQ) + 1n;
            this.s.addU64(SDB.counters, MIR_SEQ, 1n);
            this.s.put(SDB.mir, cat(u32(recordedEpoch), u64(seq)), json({ source, stakeKey: e.stakeKey, amount: e.amount.toString() }));
        }
    }
    deletePendingMir(beforeEpoch: number): void { for (const r of this.reads.pendingMir(beforeEpoch)) this.s.del(SDB.mir, cat(u32(r.recordedEpoch), u64(r.seq))); }

    // ---- raw puts for the importer / seed (no semantics)
    putPool(poolId: string, r: PoolRecord): void { this.s.put(SDB.pool, hexKey(poolId), json(r)); }
    putPoolPending(poolId: string, r: PoolPendingRecord): void { this.s.put(SDB.poolPending, hexKey(poolId), json(r)); }
    putPots(p: PotsRecord): void {
        const cur = this.reads.pots();
        this.s.put(SDB.pots, POT_KEYS.initEpoch, u32(p.initializedEpoch));
        this.s.addU64(SDB.pots, POT_KEYS.reserves, p.reserves - (cur?.reserves ?? 0n));
        this.s.addU64(SDB.pots, POT_KEYS.treasury, p.treasury - (cur?.treasury ?? 0n));
        this.s.addU64(SDB.pots, POT_KEYS.feePot, p.feePot - (cur?.feePot ?? 0n));
        this.s.addU64(SDB.pots, POT_KEYS.donationPot, p.donationPot - (cur?.donationPot ?? 0n));
    }
    putSnapshotCred(takenAt: number, typedHex: string, poolId: string, stake: bigint): void { this.s.put(SDB.snapCred, cat(u32(takenAt), hexKey(typedHex)), cat(hexKey(poolId), u64(stake))); }
    putSnapshotPool(takenAt: number, poolId: string, stake: bigint): void { this.s.put(SDB.snapPool, cat(u32(takenAt), hexKey(poolId)), u64(stake)); }
    putSnapshotTotals(takenAt: number, total: bigint, pools: number): void { this.s.put(SDB.snapTotals, u32(takenAt), cat(u64(total), u32(pools))); }
    putSnapshotPoolParams(takenAt: number, poolId: string, vrf: string, params: PoolRewardParams | null): void { this.s.put(SDB.snapPParams, cat(u32(takenAt), hexKey(poolId)), json({ vrf, params })); }
    /** A pool the snapshot lists although its delegators' stake summed to zero (bug 188's key form: what `takeStakeSnapshot` writes). */
    putSnapshotPoolZero(takenAt: number, poolId: string): void { this.s.put(SDB.snapPoolZero, cat(u32(takenAt), hexKey(poolId)), EMPTY); }
    putSnapshotPoolMeta(takenAt: number, poolId: string, delegators: number, owners: string[]): void { this.s.put(SDB.snapPoolMeta, cat(u32(takenAt), hexKey(poolId)), json({ delegators, owners })); }
    putBlocksMade(epoch: number, poolId: string, n: number): void { this.s.addU64(SDB.blocksMade, cat(u32(epoch), hexKey(poolId)), BigInt(n)); }
    putOpcert(poolId: string, counter: number, slot: number): void { this.s.put(SDB.opcert, hexKey(poolId), cat(u32(counter), u64(BigInt(slot)))); }

    // ---- history retention (reports and per-epoch tables the rules no longer need)
    /** Oldest epoch present in an epoch-prefixed database, or null when empty. */
    oldestEpoch(db: string): number | null { const k = this.s.firstStoredKey(db); return k && k.length >= 4 ? rdU32(k) : null; }
    /** Delete every stored key of `db` with u32 epoch prefix `epoch` (LMDB only: pruned history is always promoted); returns keys deleted. Call inside `applyDirect` per epoch to keep transactions small. */
    pruneEpochBelow(db: string, epoch: number): number { let n = 0; for (const k of this.s.storedKeys(db, u32(epoch))) { this.s.del(db, k); n++; } return n; }
    /** Databases whose history is pruned to a retention window: payouts and pool reward reports, blocks made, per-pool snapshot stake. */
    static readonly PRUNED_DBS: readonly string[] = [SDB.rewardPayouts, SDB.rewardPoolEpochs, SDB.blocksMade, SDB.snapPool];

    // ---- snapshot (SNAP): stake per delegated credential = UTxO balance + reward balance; pools registered now
    takeStakeSnapshot(takenAt: number): { pools: number; total: bigint } {
        const have = this.reads.snapshotTotals(takenAt);
        if (have) return have;
        const pools = this.reads.pools();
        const perPool = new Map<string, bigint>();
        const delegatedTo = new Set<string>();
        const delegators = new Map<string, number>();
        let total = 0n;
        for (const [cred, pool] of this.reads.allDelegations()) {
            if (!pools.has(pool)) continue;
            delegatedTo.add(pool);
            delegators.set(pool, (delegators.get(pool) ?? 0) + 1);
            const stake = this.reads.stakeBalance(cred) + this.reads.rewardBalance(cred);
            if (stake === 0n) continue; // the ledger's snapshot holds no zero-stake credential
            this.s.put(SDB.snapCred, cat(u32(takenAt), hexKey(cred)), cat(hexKey(pool), u64(stake)));
            perPool.set(pool, (perPool.get(pool) ?? 0n) + stake);
            total += stake;
        }
        for (const [pool, stake] of perPool) this.s.put(SDB.snapPool, cat(u32(takenAt), hexKey(pool)), u64(stake));
        for (const pool of delegatedTo) if (!perPool.has(pool)) this.putSnapshotPoolZero(takenAt, pool);
        // `spssNumDelegators` / `spssSelfDelegatedOwners` (DebugNewEpochState): every delegator, and the owners among them
        for (const [id, p] of pools) {
            const n = delegators.get(id) ?? 0;
            const owners = [...new Set((p.params?.owners ?? []).map((o) => o.toLowerCase()))].filter((o) => this.reads.delegationOf(o) === id).sort();
            if (n || owners.length) this.s.put(SDB.snapPoolMeta, cat(u32(takenAt), hexKey(id)), json({ delegators: n, owners }));
        }
        for (const [id, p] of pools) this.s.put(SDB.snapPParams, cat(u32(takenAt), hexKey(id)), json({ vrf: p.vrf, params: p.params }));
        // three snapshots of credentials and parameters are kept (mark/set/go + one); per-pool totals for every epoch
        for (const e of this.reads.snapshotEpochs()) {
            if (e >= takenAt - 3) continue;
            for (const [k] of this.s.range(SDB.snapCred, u32(e))) this.s.del(SDB.snapCred, k);
            for (const [k] of this.s.range(SDB.snapPParams, u32(e))) this.s.del(SDB.snapPParams, k);
            for (const k of this.s.storedKeys(SDB.snapPoolZero, u32(e))) this.s.del(SDB.snapPoolZero, k);
            for (const k of this.s.storedKeys(SDB.snapPoolMeta, u32(e))) this.s.del(SDB.snapPoolMeta, k);
        }
        this.s.put(SDB.snapTotals, u32(takenAt), cat(u64(total), u32(perPool.size)));
        return { pools: perPool.size, total };
    }
}
