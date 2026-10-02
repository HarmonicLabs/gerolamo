/**
 * `nesRu`, the reward update in progress, as DebugNewEpochState shows it (cardano-ledger-shelley 1.18
 * at cardano-ledger-conway-1.22.1.0: Rules/Rupd.hs, LedgerState/PulsingReward.hs, RewardUpdate.hs,
 * Rewards.hs). For the update computed during epoch E (applied at E + 1), with sr = ⌈4k/f⌉:
 *   SNothing   until the first block past E's first slot + sr (RewardsTooEarly)
 *   Pulsing    that block runs `startStep` (RewardSnapShot + the RSLP pulser over the go snapshot's
 *              active stake); each later block one `pulseM` of ⌈|stake| / 4k⌉ credentials, in
 *              credential order; once the stake is used up the next block completes it
 *   Complete   that block, or the first block past first slot + 2·sr (RewardsTooLate)
 * Everything is a function of E's records — the go snapshot (taken at E − 2), the blocks of E − 1,
 * the fee snapshot, reserves, the previous parameters, esNonMyopic — plus two facts of the chain
 * since the window opened, recovered by walking its blocks up to the acquired one: how many blocks
 * (pulses) there were, and the registered credentials at its first block (`fvAddrsRew`: the
 * current ones with the window's (de)registrations undone).
 *
 *   Pulsing   [0, [fees, ver, nonMyopic, ΔR1, R, ΔT1, {pool → likelihood}, {cred → {leader reward}}],
 *                 [pulseSize, [addrsRew, totalStake, ver, {pool → PoolRewardInfo}], {cred → [stake, pool]}, [accum, recent]]]
 *   Complete  [1, [ΔT1, −ΔR, {cred → {Reward}}, −ΔF, nonMyopic']]
 *   Reward    [0 member | 1 leader, pool, coin]; a set orders leader rewards first, then by pool
 */
import type { StakeReads } from "../../../ledger/stakeStore";
import type { GovReads } from "../../../ledger/govStore";
import { primaryBlockStore } from "../../../storage/nodeBlockStore";
import { leaderProbability, likelihood, maxPool, share, updateLikelihoods, type Likelihood, type NonMyopicState } from "../../../consensus/nonMyopic";
import { toFraction } from "../pparamsCbor";
import { chainBlocks } from "./chainWalk";
import { CborWriter, reduced } from "./cborWriter";
import { applyBlock, type GovFacts } from "./govIndex";
import { epochStartSlot, genesis, LsqUnanswerable, type Ctx } from "./queries";

// ---------------------------------------------------------------- credentials and snapshots

/** Credential order (`ScriptHashObj` before `KeyHashObj`, then the hash) of a typed key ("01"‖hash for scripts). */
export const typedKey = (typed: string) => (typed.length === 58 && typed.startsWith("01") ? `0${typed.slice(2)}` : `1${typed.slice(-56)}`);
export const byTyped = (a: string, b: string) => { const x = typedKey(a), y = typedKey(b); return x < y ? -1 : x > y ? 1 : 0; };
export function wTyped(w: CborWriter, typed: string): void { if (typed.length === 58 && typed.startsWith("01")) w.array(2).uint(1).hex(typed.slice(2)); else w.array(2).uint(0).hex(typed.slice(-56)); }

/** One pool of a stake snapshot (`StakePoolSnapShot`). */
export interface SnapPool {
    id: string; stake: bigint; ratio: [bigint, bigint]; owners: string[]; ownerStake: bigint; vrf: string;
    pledge: bigint; cost: bigint; margin: [bigint, bigint]; delegators: number; account: string;
}
/**
 * The snapshot taken at the boundary into `takenAt`: its active stake and every pool registered
 * then. `spssNumDelegators` / `spssSelfDelegatedOwners` come from `snap_pool_meta`; a snapshot taken
 * before that was kept counts only the stake-holding delegators (exact again three boundaries on).
 */
export function snapshotPools(stake: StakeReads, takenAt: number): { creds: Map<string, { pool: string; stake: bigint }>; pools: SnapPool[]; total: bigint } {
    const creds = stake.snapshotCredentials(takenAt);
    const params = stake.snapshotPoolParams(takenAt), stakeBy = stake.snapshotPoolStake(takenAt), meta = stake.snapshotPoolMeta(takenAt);
    const total = stake.snapshotTotals(takenAt)?.total ?? 0n;
    if (!params.size) throw new LsqUnanswerable(`the pools of the snapshot taken at ${takenAt} are not kept`);
    const count = new Map<string, number>();
    for (const e of creds.values()) count.set(e.pool, (count.get(e.pool) ?? 0) + 1);
    const pools: SnapPool[] = [];
    for (const id of [...params.keys()].sort()) {
        const p = params.get(id)!, pp = p.params, m = meta.get(id);
        const s = stakeBy.get(id) ?? 0n;
        const owners = m ? m.owners : [...new Set((pp?.owners ?? []).map((o) => o.toLowerCase()))].filter((o) => creds.get(o)?.pool === id).sort();
        let ownerStake = 0n; for (const o of owners) ownerStake += creds.get(o)?.stake ?? 0n;
        pools.push({
            id, stake: s, ratio: reduced(s, total > 0n ? total : 1n), owners, ownerStake, vrf: p.vrf,
            pledge: BigInt(pp?.pledge ?? 0), cost: BigInt(pp?.cost ?? 0), margin: reduced(BigInt(pp?.marginNum ?? 0), BigInt(pp?.marginDen || 1)),
            delegators: m ? m.delegators : count.get(id) ?? 0, account: String(pp?.rewardAccount ?? "").toLowerCase(),
        });
    }
    return { creds, pools, total };
}
/** `StakePoolSnapShot` [stake, ratio, self-delegated owners, their stake, vrf, pledge, cost, margin, delegators, account]. */
export function wSnapPool(w: CborWriter, p: SnapPool): void {
    w.array(10).uint(p.stake).rational(p.ratio[0], p.ratio[1]).set(p.owners, (o) => w.hex(o)).uint(p.ownerStake).hex(p.vrf).uint(p.pledge).uint(p.cost).rational(p.margin[0], p.margin[1]).uint(p.delegators);
    wTyped(w, p.account);
}
/** `Likelihood`: 100 Float log-weights (an indefinite list: more than 23). */
export function wLikelihood(w: CborWriter, l: Likelihood): void {
    const f = new Uint8Array(5), dv = new DataView(f.buffer); f[0] = 0xfa;
    w.list([...l], (x) => { dv.setFloat32(1, x, false); w.raw(f); });
}
/** `NonMyopic` [{pool → likelihood}, rewardPot]. */
export function wNonMyopic(w: CborWriter, nm: { likelihoods: ReadonlyMap<string, Likelihood>; rewardPot: bigint }): void {
    w.array(2).mapOf([...nm.likelihoods.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), (k) => w.hex(k), (l) => wLikelihood(w, l));
    w.uint(nm.rewardPot);
}

// ---------------------------------------------------------------- startStep

type Reward = { type: 0 | 1; pool: string; amount: bigint };
interface PoolInfo { sigma: [bigint, bigint]; pot: bigint; snap: SnapPool; blocks: number; leader: bigint }
export interface RupdCore {
    epoch: number;
    fees: bigint; ver: [number, number];
    deltaR1: bigint; R: bigint; deltaT1: bigint;
    totalStake: bigint;
    /** `newLikelihoods`: every pool of the go snapshot */
    likelihoods: Map<string, Likelihood>;
    /** `fvPoolRewardInfo`: the pools that made blocks in E − 1 */
    info: Map<string, PoolInfo>;
    /** `rewLeaders` */
    leaders: Map<string, Reward[]>;
    /** the go snapshot's active stake, credential order */
    active: Array<{ typed: string; stake: bigint; pool: string }>;
}

/** `startStep` for the update computed during `epoch`. */
export function rewardUpdateCore(stake: StakeReads, gov: GovReads, epoch: number, g: { activeSlotsCoeff: unknown; epochLength: unknown; maxLovelaceSupply: unknown }): RupdCore {
    const pots = stake.potSnapshot(epoch);
    if (!pots) throw new LsqUnanswerable(`no pot snapshot of epoch ${epoch}`);
    const pr = gov.epochParams(epoch - 1)?.params ?? gov.epochParams(epoch)?.params; // esPrevPp
    if (!pr) throw new LsqUnanswerable(`no parameters of epoch ${epoch - 1}`);
    const go = snapshotPools(stake, epoch - 2);
    const blocks = stake.blocksMade(epoch - 1);
    const slotsPerEpoch = Number(g.epochLength);
    const asc = toFraction(g.activeSlotsCoeff), d = toFraction(pr.decentralisation_param ?? 0);
    const rho = toFraction(pr.rho ?? "0.003"), tau = toFraction(pr.tau ?? "0.2"), a0 = toFraction(pr.a0 ?? "0.3");
    const nOpt = Number(pr.n_opt ?? 500);
    const ver: [number, number] = [Number(pr.protocol_major_ver ?? 0), Number(pr.protocol_minor_ver ?? 0)];
    const reserves = pots.reserves, fees = pots.feesCollected;
    // η = blocks made / expected blocks (1 from d ≥ 0.8); ΔR1 = ⌊min 1 η · ρ · reserves⌋
    let blocksMade = 0n; for (const n of blocks.values()) blocksMade += BigInt(n);
    const expected = (BigInt(slotsPerEpoch) * asc[0] * (d[1] - d[0])) / (asc[1] * d[1]);
    const dHigh = d[0] * 5n >= d[1] * 4n;
    const [eN, eD] = dHigh || blocksMade >= expected ? [1n, 1n] : [blocksMade, expected];
    const deltaR1 = (eN * rho[0] * reserves) / (eD * rho[1]);
    const rPot = fees + deltaR1;
    const deltaT1 = (tau[0] * rPot) / tau[1];
    const R = rPot - deltaT1;
    const totalStake = BigInt(String(g.maxLovelaceSupply)) - reserves;
    const likelihoods = new Map<string, Likelihood>(), info = new Map<string, PoolInfo>(), leaders = new Map<string, Reward[]>();
    for (const p of go.pools) {
        const sigma = share(p.stake, totalStake);
        const n = blocks.get(p.id);
        likelihoods.set(p.id, likelihood(n ?? 0, leaderProbability(asc, sigma, d), slotsPerEpoch));
        if (n == null) continue;
        // mkPoolRewardInfo: maxPool' when the pledge is met, times the apparent performance β/σa
        const maxP = p.pledge <= p.ownerStake ? maxPool(a0, nOpt, R, sigma, [p.pledge, totalStake]) : 0n;
        let pot: bigint;
        if (p.stake === 0n) pot = 0n;
        else if (dHigh) pot = maxP;
        else pot = (BigInt(n) * go.total * maxP) / ((blocksMade > 0n ? blocksMade : 1n) * p.stake);
        const [mN, mD] = p.margin;
        const leader = pot <= p.cost ? pot : p.cost + ((pot - p.cost) * (mN * p.stake + (mD - mN) * p.ownerStake)) / (mD * p.stake);
        info.set(p.id, { sigma: reduced(sigma[0], sigma[1]), pot, snap: p, blocks: n, leader });
        // collectLRs: from Babbage on every leader reward, registered account or not
        const l = leaders.get(p.account) ?? []; l.push({ type: 1, pool: p.id, amount: leader }); leaders.set(p.account, l);
    }
    const active = [...go.creds.entries()].map(([typed, e]) => ({ typed, stake: e.stake, pool: e.pool })).sort((a, b) => byTyped(a.typed, b.typed));
    return { epoch, fees, ver, deltaR1, R, deltaT1, totalStake, likelihoods, info, leaders, active };
}

/** `rewardOnePoolMember`: ⌊(f̂ − c)(1 − m)·t/σ⌋ for a delegator of a pool that made blocks, not one of its self-delegated owners; null for none or 0. */
export function memberReward(r: RupdCore, a: { typed: string; stake: bigint; pool: string }): Reward | null {
    const i = r.info.get(a.pool);
    if (!i) return null;
    if (a.typed.length === 56 && i.snap.owners.includes(a.typed)) return null;
    const { pot, snap } = i;
    if (pot <= snap.cost || snap.stake === 0n) return null;
    const [mN, mD] = snap.margin;
    const amount = ((pot - snap.cost) * (mD - mN) * a.stake) / (mD * snap.stake);
    return amount === 0n ? null : { type: 0, pool: a.pool, amount };
}

const rewardOrder = (a: Reward, b: Reward) => (a.type !== b.type ? b.type - a.type : a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0);
const wReward = (w: CborWriter, x: Reward) => { w.array(3).uint(x.type).hex(x.pool).uint(x.amount); };
const wRewardSet = (w: CborWriter, xs: Reward[]) => { w.set([...xs].sort(rewardOrder), (x) => wReward(w, x)); };

/** `startStep`'s pulse size (max 1 ⌈N / 4k⌉) and the pulses until the stake is used up. */
export function pulsePlan(credentials: number, k: number): { size: number; pulses: number } {
    const N = BigInt(credentials), K = 4n * BigInt(k);
    const size = N === 0n ? 1n : (N + K - 1n) / K;
    return { size: Number(size), pulses: Number((N + size - 1n) / size) };
}

// ---------------------------------------------------------------- the window's chain facts

export interface WindowFacts { blocks: number; firstOp: Map<string, "reg" | "dereg"> }
let windowSource: ((c: Ctx, fromSlot: number) => Promise<WindowFacts>) | null = null;
/** Tests: the window facts without a block store. */
export function setRewardWindowSource(fn: ((c: Ctx, fromSlot: number) => Promise<WindowFacts>) | null): void { windowSource = fn; }

/** The selected chain's blocks from `fromSlot` up to the acquired one, and each credential's first (de)registration among them. */
export async function windowFacts(c: Ctx, fromSlot: number): Promise<WindowFacts> {
    if (windowSource) return windowSource(c, fromSlot);
    const bs = primaryBlockStore();
    if (!bs || !c.view.point) throw new LsqUnanswerable("the reward pulser's position needs the block store");
    const firstOp = new Map<string, "reg" | "dereg">();
    // the gov index's certificate walk, recording each stake credential's first registration or deregistration
    class Recorder extends Map<string, bigint> {
        override set(k: string, v: bigint): this { if (!firstOp.has(k)) firstOp.set(k, "reg"); return super.set(k, v); }
        override delete(k: string): boolean { if (!firstOp.has(k)) firstOp.set(k, "dereg"); return super.delete(k); }
    }
    const facts: GovFacts = { drepAnchor: new Map(), proposal: new Map(), credType: new Map(), ccResign: new Map(), stakeDeposit: new Recorder() };
    let blocks = 0;
    for await (const b of chainBlocks(bs, fromSlot, c.view.point.hash, Number(c.view.point.slot))) { blocks++; applyBlock(facts, b.bytes); }
    return { blocks, firstOp };
}

// ---------------------------------------------------------------- the answer

/** `randomnessStabilisationWindow` = ⌈4k/f⌉. */
export function rewardStartOffset(c: Ctx): number { const g = genesis(c.env.network, "shelley"); return Math.ceil((4 * Number(g.securityParam)) / Number(g.activeSlotsCoeff)); }

/** `nesRu` (StrictMaybe PulsingRewUpdate) of the acquired block. */
export async function writeRewardUpdate(c: Ctx, w: CborWriter, nm: NonMyopicState): Promise<void> {
    const sr = rewardStartOffset(c), start = epochStartSlot(c.env.network, c.epoch) + sr, force = start + sr;
    if (c.slot <= start) { w.array(0); return; } // RewardsTooEarly: SNothing
    const g = genesis(c.env.network, "shelley");
    const r = rewardUpdateCore(c.stake, c.gov, c.epoch, g);
    const plan = pulsePlan(r.active.length, Number(g.securityParam));
    // the window's first block started the pulser, each later one pulsed (or completed it once done)
    let pulses = Infinity, facts: WindowFacts | null = null;
    if (c.slot <= force) { facts = await windowFacts(c, start + 1); pulses = facts.blocks - 1; }
    w.array(1);
    if (pulses > plan.pulses) { writeComplete(w, r, nm); return; }
    const n = plan.size, done = pulses * n;
    w.array(3).uint(0);
    // RewardSnapShot
    w.array(8).uint(r.fees).array(2).uint(r.ver[0]).uint(r.ver[1]);
    wNonMyopic(w, nm);
    w.uint(r.deltaR1).uint(r.R).uint(r.deltaT1);
    w.mapOf([...r.likelihoods.entries()], (id) => w.hex(id), (l) => wLikelihood(w, l)); // go pools in id order
    w.mapOf([...r.leaders.entries()].sort((a, b) => byTyped(a[0], b[0])), (t) => wTyped(w, t), (xs) => wRewardSet(w, xs));
    // RSLP: the pulse size, FreeVars, the stake not visited yet, RewardAns
    w.array(4).uint(n);
    const registered = c.stake.registeredStakeKeys();
    for (const [t, op] of facts!.firstOp) { if (op === "reg") registered.delete(t); else registered.add(t); } // the window's certificates undone
    w.array(4).set([...registered].sort(byTyped), (t) => wTyped(w, t)).uint(r.totalStake).array(2).uint(r.ver[0]).uint(r.ver[1]);
    w.mapOf([...r.info.entries()], (id) => w.hex(id), (i) => {
        w.array(5).rational(i.sigma[0], i.sigma[1]).uint(i.pot);
        wSnapPool(w, i.snap);
        w.uint(i.blocks).array(2).hex(i.snap.id).uint(i.leader);
    });
    w.mapOf(r.active.slice(done).map((a) => [a.typed, a] as const), (t) => wTyped(w, t), (a) => w.array(2).uint(a.stake).hex(a.pool));
    const visited = (from: number, to: number) => r.active.slice(Math.max(0, from), to).flatMap((a) => { const x = memberReward(r, a); return x ? [[a.typed, x] as const] : []; });
    w.array(2);
    w.mapOf(visited(0, done), (t) => wTyped(w, t), (x) => wReward(w, x));
    w.mapOf(pulses > 0 ? visited(done - n, done) : [], (t) => wTyped(w, t), (x) => wRewardSet(w, [x])); // the last pulse's events (`clearRecent` before each)
}

/** `completeRupd`: every member reward with the leader rewards, ΔR2 = R − their sum back to the reserves, the likelihoods advanced. */
function writeComplete(w: CborWriter, r: RupdCore, nm: NonMyopicState): void {
    const rs = new Map<string, Reward[]>();
    for (const [t, xs] of r.leaders) rs.set(t, [...xs]);
    for (const a of r.active) { const x = memberReward(r, a); if (x) { const l = rs.get(a.typed) ?? []; l.push(x); rs.set(a.typed, l); } }
    let sum = 0n; for (const xs of rs.values()) for (const x of xs) sum += x.amount;
    const deltaR2 = r.R - sum;
    w.array(2).uint(1).array(5).int(r.deltaT1).int(r.deltaR1 - deltaR2);
    w.mapOf([...rs.entries()].sort((a, b) => byTyped(a[0], b[0])), (t) => wTyped(w, t), (xs) => wRewardSet(w, xs));
    w.int(r.fees);
    wNonMyopic(w, { likelihoods: updateLikelihoods(nm.likelihoods, r.likelihoods), rewardPot: r.R });
}
