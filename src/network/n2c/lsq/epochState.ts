/**
 * `DebugEpochState` [8] and `DebugNewEpochState` [12] (cardano-ledger-shelley LedgerState/Types.hs,
 * cardano-ledger-conway 1.22.1 state, ouroboros-consensus 3.0.1): the ledger state as cardano-node 11
 * keeps it in memory under UTxO-HD — the UTxO map itself empty (it lives in the ledger tables) —
 * rebuilt from the acquired view. Tens of MB on preview (accounts, instant stake, three snapshots).
 *
 *   NewEpochState  [epoch, blocksPrev, blocksCur, EpochState, StrictMaybe PulsingRewUpdate, PoolDistr, null]
 *   EpochState     [[treasury, reserves], [CertState, UTxOState], [mark, set, go, fee], NonMyopic]
 *   CertState      [VState [dreps, committee state, dormant], PState [vrf counts, pools, future, retiring],
 *                   DState [accounts, {}, genesis delegations, [{}, {}, 0, 0]]]
 *   UTxOState      [{}, deposited, fees, GovState, instant stake, donation]
 *   SnapShot       [{credential → [stake, pool]}, {pool → StakePoolSnapShot (10 fields)}]
 *
 * The reward update in progress is lsq/rewardUpdate.ts. Byte-identical with cardano-node 11.0.1 on
 * preview (epoch 1437, bug 264) except where the store keeps less than the ledger: a snapshot taken
 * before `snap_pool_meta` was recorded (bug 263) counts only its stake-holding delegators
 * (`spssNumDelegators`, `spssSelfDelegatedOwners`), exact again three boundaries later; a pool's
 * deposit is the current pool deposit.
 */
import { CborArray, CborUInt } from "@harmoniclabs/cbor";
import { SDB } from "../../../ledger/stakeStore";
import { DB_STAKE_BAL } from "../../../ledger/utxoStore";
import { readU64 } from "../../../ledger/LedgerDiff";
import { cborItemLength } from "../../../storage/chunkFormat";
import { CborWriter } from "./cborWriter";
import { drepEntries, genesisCommitteeKinds, parseGovKey, type Cred } from "./govAdapter";
import type { GovFacts } from "./govIndex";
import { answerConwayQuery, genesis, govFacts, liveProposals, LsqUnanswerable, normalizePoolParams, pparamsRaw, type Ctx } from "./queries";
import { nonMyopicFor, type NonMyopicState } from "./rewardQueries";
import { snapshotPools, wNonMyopic, wSnapPool, writeRewardUpdate } from "./rewardUpdate";

const credKey = (c: Cred) => `${c.type === 1 ? 0 : 1}${c.hash}`;
const typedKey = (typed: string) => (typed.length === 58 && typed.startsWith("01") ? `0${typed.slice(2)}` : `1${typed.slice(-56)}`);
const credOfTyped = (typed: string): Cred => (typed.length === 58 && typed.startsWith("01") ? { type: 1, hash: typed.slice(2) } : { type: 0, hash: typed.slice(-56) });
const order = <T>(key: (x: T) => string) => (a: T, b: T) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; };
const wCred = (w: CborWriter, c: Cred) => { w.array(2).uint(c.type).hex(c.hash); };
const wTyped = (w: CborWriter, typed: string) => wCred(w, credOfTyped(typed));
const rawOf = (c: Ctx) => (c.stake as unknown as { s: { range(db: string, p: Uint8Array): Iterable<[Uint8Array, Uint8Array]>; get(db: string, k: Uint8Array): Uint8Array | undefined } }).s;
const EMPTY = new Uint8Array(0);

/** `DebugEpochState`. */
export async function debugEpochState(c: Ctx): Promise<Uint8Array> {
    const w = new CborWriter(48 << 20);
    await writeEpochState(c, w, await govFacts(c), await nonMyopicOf(c));
    return w.finishInPlace();
}

/** `DebugNewEpochState`. */
export async function debugNewEpochState(c: Ctx): Promise<Uint8Array> {
    const w = new CborWriter(48 << 20);
    const facts = await govFacts(c);
    w.array(7).uint(c.epoch);
    writeBlocks(w, c.stake.blocksMade(c.epoch - 1));
    writeBlocks(w, c.stake.blocksMade(c.epoch));
    const nm = await nonMyopicOf(c);
    await writeEpochState(c, w, facts, nm);
    await writeRewardUpdate(c, w, nm);
    w.raw(await answerConwayQuery(c.view, c.env, [new CborUInt(36), new CborArray([])])); // nesPd = the set snapshot's pool distribution (GetPoolDistr2)
    w.null(); // stashedAVVMAddresses: () after Shelley
    return w.finishInPlace();
}

function writeBlocks(w: CborWriter, m: Map<string, number>): void { w.mapOf([...m.entries()].sort(order((e) => e[0])), (k) => w.hex(k), (n) => w.uint(n)); }

async function writeEpochState(c: Ctx, w: CborWriter, facts: GovFacts | null, nm: NonMyopicState): Promise<void> {
    const pots = c.stake.pots();
    if (!pots) throw new LsqUnanswerable("pots not initialised");
    w.array(4).array(2).uint(pots.treasury).uint(pots.reserves);
    w.array(2);
    writeCertState(c, w, facts);
    await writeUTxOState(c, w, facts);
    writeSnapShots(c, w);
    wNonMyopic(w, nm);
}

// ---------------------------------------------------------------- CertState

function kindOf(c: Ctx, facts: GovFacts | null): (h: string) => number | undefined {
    const g = genesisCommitteeKinds(genesis(c.env.network, "conway"));
    return (h) => facts?.credType.get(h) ?? g.get(h);
}

function writeCertState(c: Ctx, w: CborWriter, facts: GovFacts | null): void {
    w.array(3).array(3);
    // VState: DReps with their stored expiry (no dormant-epoch adjustment), committee authorisations, dormant epochs
    const raw = pparamsRaw(c), st = c.gov.state();
    const delegators = new Map<string, string[]>();
    for (const [stakeKey, d] of c.gov.drepDelegations()) {
        if ((d.type !== 0 && d.type !== 1) || !d.hash) continue;
        const k = `${d.type}:${d.hash}`;
        let l = delegators.get(k); if (!l) delegators.set(k, (l = []));
        l.push(stakeKey);
    }
    const dreps = drepEntries(c.gov).sort((a, b) => order(credKey)(a.cred, b.cred));
    w.mapOf(dreps.map((d) => [d.cred, d] as const), (k) => wCred(w, k), ({ cred, row }) => {
        w.array(4).uint(row.expiryEpoch ?? row.lastActiveEpoch + Number(raw.drep_activity ?? 20));
        const a = facts?.drepAnchor.get(`${cred.type}:${cred.hash}`);
        if (a) w.array(1).raw(a); else w.array(0);
        w.uint(BigInt(row.deposit)).set((delegators.get(`${cred.type}:${cred.hash}`) ?? []).sort(order(typedKey)), (t) => wTyped(w, t));
    });
    const kind = kindOf(c, facts);
    const auth = new Map<string, { cold: Cred; hot: Cred | null; resigned: boolean }>();
    for (const [k, a] of c.gov.committeeAuths()) { const cold = parseGovKey(k, kind); auth.set(credKey(cold), { cold, hot: a.hot ? parseGovKey(a.hot, kind) : null, resigned: a.resigned !== 0 }); }
    for (const [k, m] of c.gov.committee()) { const cold = parseGovKey(k, kind); if (!auth.has(credKey(cold)) && (m.hot || m.resigned)) auth.set(credKey(cold), { cold, hot: m.hot ? parseGovKey(m.hot, kind) : null, resigned: m.resigned !== 0 }); }
    const cs = [...auth.values()].filter((a) => a.resigned || a.hot).sort((a, b) => order(credKey)(a.cold, b.cold));
    w.mapOf(cs.map((a) => [a.cold, a] as const), (k) => wCred(w, k), (a) => {
        if (a.resigned) { const an = facts?.ccResign.get(`${a.cold.type}:${a.cold.hash}`); w.array(2).uint(1); if (an) w.array(1).raw(an); else w.array(0); }
        else { w.array(2).uint(0); wCred(w, a.hot!); }
    });
    w.uint(Number(st?.dormantEpochs ?? 0));

    // PState
    const pools = c.stake.pools(), pending = c.stake.pendingPools();
    const deposit = BigInt(String(raw.pool_deposit ?? 500_000_000));
    const poolDelegators = new Map<string, string[]>();
    for (const [cred, pool] of c.stake.allDelegations()) { if (!pools.has(pool)) continue; let l = poolDelegators.get(pool); if (!l) poolDelegators.set(pool, (l = [])); l.push(cred); }
    const vrfs = new Map<string, number>();
    for (const [id, p] of pools) { vrfs.set(p.vrf, (vrfs.get(p.vrf) ?? 0) + 1); const f = pending.get(id); if (f && f.vrf !== p.vrf) vrfs.set(f.vrf, (vrfs.get(f.vrf) ?? 0) + 1); }
    w.array(4).mapOf([...vrfs.entries()].sort(order((e) => e[0])), (k) => w.hex(k), (n) => w.uint(n));
    const ids = [...pools.keys()].sort();
    const items: Array<[string, Uint8Array[]]> = [];
    for (const id of ids) { const r = c.stake.poolCbor(id); if (!r) throw new LsqUnanswerable(`pool ${id} has no raw parameters`); items.push([id, poolItems(normalizePoolParams(r))]); }
    w.mapOf(items.map(([id, it]) => [id, { id, it }] as const), (k) => w.hex(k), ({ id, it }) => {
        // StakePoolState [vrf, pledge, cost, margin, account (credential), owners, relays, metadata (StrictMaybe), deposit, delegators]
        w.array(10).raw(it[1]!).raw(it[2]!).raw(it[3]!).raw(it[4]!);
        wCred(w, accountCred(it[5]!));
        w.raw(it[6]!).raw(it[7]!);
        if (it[8]![0] === 0xf6) w.array(0); else w.array(1).raw(it[8]!);
        w.uint(deposit);
        w.set((poolDelegators.get(id) ?? []).sort(order(typedKey)), (t) => wTyped(w, t));
    });
    const future: Array<[string, Uint8Array]> = [];
    for (const id of [...pending.keys()].sort()) { const r = rawOf(c).get(SDB.poolCborPending, Uint8Array.from(Buffer.from(id, "hex"))); if (r) future.push([id, normalizePoolParams(r)]); }
    w.mapOf(future, (k) => w.hex(k), (v) => w.raw(v));
    w.mapOf(ids.filter((id) => pools.get(id)!.retiringEpoch != null).map((id) => [id, pools.get(id)!.retiringEpoch!] as const), (k) => w.hex(k), (e) => w.uint(e));

    // DState: accounts [balance, deposit, pool, DRep], no future genesis delegations, genesis delegations, no instantaneous rewards
    const keyDeposit = BigInt(String(raw.key_deposit ?? 2_000_000));
    const accounts = [...c.stake.registeredStakeKeys()].sort(order(typedKey));
    w.array(4);
    const end = w.mapHead(accounts.length);
    for (const t of accounts) {
        wTyped(w, t);
        const d = facts?.stakeDeposit.get(t);
        w.array(4).uint(c.stake.rewardBalance(t)).uint(d != null && d >= 0n ? d : keyDeposit);
        const pool = c.stake.delegationOf(t);
        if (pool) w.hex(pool); else w.null();
        const dr = c.gov.drepDelegation(t);
        if (!dr) w.null(); else if (dr.type === 2 || dr.type === 3) w.array(1).uint(dr.type); else w.array(2).uint(dr.type).hex(dr.hash!);
    }
    end();
    w.map(0);
    let gd = c.stake.genesisDelegsAt(c.slot);
    if (!gd.size) gd = new Map(Object.entries((genesis(c.env.network, "shelley").genDelegs ?? {}) as Record<string, { delegate: string; vrf: string }>));
    w.mapOf([...gd.entries()].sort(order((e) => e[0])), (k) => w.hex(k), (v) => w.array(2).hex(v.delegate).hex(v.vrf));
    w.array(4).map(0).map(0).uint(0).uint(0);
}

/** The nine items of a (normalised) PoolParams array. */
function poolItems(raw: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let p = 1;
    for (let i = 0; i < 9; i++) { const n = cborItemLength(raw, p); out.push(raw.subarray(p, p + n)); p += n; }
    return out;
}
/** A reward account's bytes (header ‖ hash) as the credential. */
function accountCred(item: Uint8Array): Cred {
    const off = item[0] === 0x58 ? 2 : 1; // bytes(29)
    const header = item[off]!;
    return { type: (header >> 4) === 0xf ? 1 : 0, hash: Buffer.from(item.subarray(off + 1, off + 29)).toString("hex") };
}

// ---------------------------------------------------------------- UTxOState

async function writeUTxOState(c: Ctx, w: CborWriter, facts: GovFacts | null): Promise<void> {
    const raw = pparamsRaw(c), pots = c.stake.pots()!;
    const keyDeposit = BigInt(String(raw.key_deposit ?? 2_000_000)), poolDeposit = BigInt(String(raw.pool_deposit ?? 500_000_000));
    let deposited = 0n;
    for (const t of c.stake.registeredStakeKeys()) { const d = facts?.stakeDeposit.get(t); deposited += d != null && d >= 0n ? d : keyDeposit; }
    deposited += poolDeposit * BigInt(c.stake.pools().size);
    for (const [, d] of c.gov.dreps()) deposited += BigInt(d.deposit);
    for (const p of liveProposals(c)) deposited += BigInt(p.deposit);
    // the ledger keeps the previous epoch's fees (the snapshot's) until the reward update takes them
    const frozen = c.stake.potSnapshot(c.epoch)?.feesCollected ?? 0n;
    w.array(6).map(0).uint(deposited).uint(pots.feePot + frozen);
    w.raw(await answerConwayQuery(c.view, c.env, [new CborUInt(24)]));
    const stake: Array<[string, bigint]> = [];
    for (const [k, v] of rawOf(c).range(DB_STAKE_BAL, EMPTY)) { const n = readU64(v); if (n !== 0n) stake.push([Buffer.from(k).toString("hex"), n]); }
    stake.sort(order((e) => typedKey(e[0])));
    w.mapOf(stake, (t) => wTyped(w, t), (n) => w.uint(n));
    w.uint(pots.donationPot);
}

// ---------------------------------------------------------------- SnapShots, NonMyopic

function writeSnapShots(c: Ctx, w: CborWriter): void {
    w.array(4);
    for (const takenAt of [c.epoch, c.epoch - 1, c.epoch - 2]) writeSnapShot(c, w, takenAt);
    w.uint(c.stake.potSnapshot(c.epoch)?.feesCollected ?? 0n);
}

function writeSnapShot(c: Ctx, w: CborWriter, takenAt: number): void {
    const { creds, pools } = snapshotPools(c.stake, takenAt);
    w.array(2);
    w.mapOf([...creds.entries()].sort(order((e) => typedKey(e[0]))), (t) => wTyped(w, t), (e) => w.array(2).uint(e.stake).hex(e.pool));
    w.mapOf(pools.map((p) => [p.id, p] as const), (k) => w.hex(k), (p) => wSnapPool(w, p));
}

/** `esNonMyopic` of the acquired epoch. */
async function nonMyopicOf(c: Ctx): Promise<NonMyopicState> {
    const g = genesis(c.env.network, "shelley");
    const nm = await nonMyopicFor(c.stake, c.gov, c.epoch, c.view.anchorKey + (c.view.point?.hash ?? ""), { activeSlotsCoeff: g.activeSlotsCoeff, slotsPerEpoch: Number(g.epochLength), maxSupply: BigInt(g.maxLovelaceSupply) });
    if (!nm) throw new LsqUnanswerable(`the pool-ranking likelihoods of epoch ${c.epoch} are not recorded`);
    return nm;
}
