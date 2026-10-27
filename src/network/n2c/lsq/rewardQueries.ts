/**
 * The wallet reward queries (cardano-ledger-shelley API/Wallet.hs, served by ouroboros-consensus
 * 3.0.1 for Conway): `GetNonMyopicMemberRewards` [2] and `GetRewardInfoPools` [18]. Both rank the
 * pools of the *current* stake distribution (`currentSnapshot`: instant stake plus reward balances
 * of credentials delegated to a registered pool, every registered pool listed, zero-stake ones
 * included) with the ledger's `esNonMyopic` performance likelihoods (consensus/nonMyopic.ts) and its
 * reward pot `rewardPotNM`; the total stake is the circulation (max supply − reserves).
 *   [2]  ToCBOR (definite maps): { Left coin [0, c] | Right credential [1, cred] → { pool → coin } }
 *   [18] EncCBOR: [[nOpt, a0, rPot, totalStake], { pool → [stake, pledge, ownerStake, cost, margin, perf (float64)] }]
 */
import { settings } from "../../../config/settings";
import { Cbor, CborArray, CborBytes, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { readFileSync } from "node:fs";
import type { StakeReads } from "../../../ledger/stakeStore";
import type { GovReads } from "../../../ledger/govStore";
import { advanceNonMyopicTo, nonMyopicOfLedgerState, type AdvanceEnv } from "../../../consensus/nonMyopicSeed";
import { nonMyopicMemberReward, performanceEstimate, share, topRankedPools, type NonMyopicState, type Q, type RankParams, type RankPool } from "../../../consensus/nonMyopic";
import { toFraction } from "../pparamsCbor";
import { CborWriter, reduced } from "./cborWriter";

export type { NonMyopicState };

export interface CurrentSnapshot {
    /** typed credential → active stake (UTxO + rewards, non-zero, delegated to a registered pool) */
    active: Map<string, bigint>;
    /** every registered pool, by id */
    pools: RankPool[];
    circulation: bigint;
}

/** Pool parameters from the registration's raw CBOR `[operator, vrf, pledge, cost, margin, account, owners, relays, metadata]`. */
function rawPoolTerms(raw: Uint8Array): { pledge: bigint; cost: bigint; margin: Q; owners: string[] } | null {
    try {
        const a = (Cbor.parse(raw) as CborArray).array;
        const m = a[4] as unknown as { data: CborArray };
        const owners = a[6] as unknown as { data?: CborArray; array?: CborObj[] };
        const ownerList = (owners.data?.array ?? owners.array ?? []) as CborObj[];
        return {
            pledge: BigInt((a[2] as CborUInt).num), cost: BigInt((a[3] as CborUInt).num),
            margin: [BigInt((m.data.array[0] as CborUInt).num), BigInt((m.data.array[1] as CborUInt).num)],
            owners: ownerList.map((o) => Buffer.from((o as CborBytes).bytes).toString("hex")),
        };
    } catch { return null; }
}

/** `currentSnapshot` (`snapShotFromInstantStake` over the current instant stake, accounts and pools). */
export function currentSnapshot(stake: StakeReads, maxSupply: bigint): CurrentSnapshot {
    const pots = stake.pots();
    if (!pots) throw new Error("pots not initialised");
    const reg = stake.pools();
    const active = new Map<string, bigint>();
    const perPool = new Map<string, bigint>();
    const delegatorsOf = new Map<string, Set<string>>();
    for (const [cred, pool] of stake.allDelegations()) {
        if (!reg.has(pool)) continue;
        let d = delegatorsOf.get(pool); if (!d) delegatorsOf.set(pool, (d = new Set()));
        d.add(cred);
        const s = stake.stakeBalance(cred) + stake.rewardBalance(cred);
        if (s === 0n) continue;
        active.set(cred, s);
        perPool.set(pool, (perPool.get(pool) ?? 0n) + s);
    }
    const pools: RankPool[] = [];
    for (const id of [...reg.keys()].sort()) {
        const p = reg.get(id)!;
        const raw = stake.poolCbor(id);
        const terms = (raw && rawPoolTerms(raw)) || (p.params ? { pledge: BigInt(p.params.pledge), cost: BigInt(p.params.cost), margin: [BigInt(p.params.marginNum), BigInt(p.params.marginDen || "1")] as Q, owners: p.params.owners } : null);
        if (!terms) throw new Error(`pool ${id} has no parameters`);
        // `spssSelfDelegatedOwners`: owners (key credentials) that delegate to this very pool
        const dels = delegatorsOf.get(id);
        let ownerStake = 0n;
        for (const o of new Set(terms.owners.map((x) => x.toLowerCase()))) if (dels?.has(o)) ownerStake += active.get(o) ?? 0n;
        pools.push({ id, stake: perPool.get(id) ?? 0n, ownerStake, pledge: terms.pledge, cost: terms.cost, margin: terms.margin });
    }
    return { active, pools, circulation: maxSupply - pots.reserves };
}

function rankParams(pparams: Record<string, unknown>, nm: NonMyopicState, circulation: bigint): RankParams {
    const [an, ad] = toFraction(pparams.a0 ?? "0.3");
    return { a0: [an, ad], nOpt: Number(pparams.n_opt ?? 500), rPot: nm.rewardPot, totalStake: circulation };
}

/** `getRewardInfoPools`. */
export function rewardInfoPoolsBytes(snap: CurrentSnapshot, pparams: Record<string, unknown>, nm: NonMyopicState): Uint8Array {
    const rp = rankParams(pparams, nm, snap.circulation);
    const w = new CborWriter(1 << 16);
    const [an, ad] = reduced(rp.a0[0], rp.a0[1]);
    w.array(2).array(4).uint(rp.nOpt).rational(an, ad).uint(rp.rPot).uint(rp.totalStake);
    w.mapOf(snap.pools.map((p) => [p.id, p] as const), (k) => w.hex(k), (p) => {
        const [mn, md] = reduced(p.margin[0], p.margin[1]);
        w.array(6).uint(p.stake).uint(p.pledge).uint(p.ownerStake).uint(p.cost).rational(mn, md);
        writeFloat64(w, performanceEstimate(nm.likelihoods.get(p.id)));
    });
    return w.finish();
}
function writeFloat64(w: CborWriter, v: number): void { const b = new Uint8Array(9); b[0] = 0xfb; new DataView(b.buffer).setFloat64(1, v, false); w.raw(b); }

export type MemberArg = { kind: "coin"; coin: bigint } | { kind: "cred"; type: number; hash: string };
/** The query's `Set (Either Coin (Credential Staking))`; unrecognised items are skipped. */
export function memberArgs(items: CborObj[]): MemberArg[] {
    const out: MemberArg[] = [];
    for (const it of items) {
        if (!(it instanceof CborArray) || it.array.length !== 2 || !(it.array[0] instanceof CborUInt)) continue;
        const tag = Number(it.array[0].num), v = it.array[1];
        if (tag === 0 && v instanceof CborUInt) out.push({ kind: "coin", coin: BigInt(v.num) });
        else if (tag === 1 && v instanceof CborArray && v.array.length === 2 && v.array[0] instanceof CborUInt && v.array[1] instanceof CborBytes) out.push({ kind: "cred", type: Number(v.array[0].num), hash: Buffer.from(v.array[1].bytes).toString("hex") });
    }
    return out;
}
/** Haskell `Ord (Either Coin Credential)`: every Left before every Right; coins by amount; credentials script first, then hash bytes. */
const argKey = (a: MemberArg) => (a.kind === "coin" ? `0${a.coin.toString(16).padStart(20, "0")}` : `1${a.type === 1 ? 0 : 1}${a.hash}`);

/** `getNonMyopicMemberRewards`. */
export function nonMyopicMemberRewardsBytes(snap: CurrentSnapshot, pparams: Record<string, unknown>, nm: NonMyopicState, args: MemberArg[]): Uint8Array {
    const rp = rankParams(pparams, nm, snap.circulation);
    const perf = new Map<string, number>();
    for (const p of snap.pools) perf.set(p.id, performanceEstimate(nm.likelihoods.get(p.id)));
    // `getTopRankedPools` over the pools that have a likelihood and are in the current snapshot
    const top = topRankedPools(rp, snap.pools.filter((p) => nm.likelihoods.has(p.id)).map((p) => ({ ...p, perf: perf.get(p.id)! })));
    const uniq = new Map<string, MemberArg>();
    for (const a of args) uniq.set(argKey(a), a);
    const keys = [...uniq.keys()].sort();
    const w = new CborWriter(1 << 16);
    w.map(keys.length);
    for (const k of keys) {
        const a = uniq.get(k)!;
        if (a.kind === "coin") w.array(2).uint(0).uint(a.coin);
        else w.array(2).uint(1).array(2).uint(a.type).hex(a.hash);
        const typed = a.kind === "cred" ? (a.type === 1 ? "01" : "") + a.hash : "";
        const t = share(a.kind === "coin" ? a.coin : snap.active.get(typed) ?? 0n, snap.circulation);
        w.map(snap.pools.length);
        for (const p of snap.pools) {
            w.hex(p.id);
            w.uint(p.pledge <= p.ownerStake ? nonMyopicMemberReward(rp, p, perf.get(p.id)!, t, top) : 0n);
        }
    }
    return w.finish();
}

// ---------------------------------------------------------------- the state the answers read

const seedMemo = new Map<string, Promise<NonMyopicState | null>>();
/**
 * `esNonMyopic` of the view's epoch: what its boundary recorded; failing that (a store bootstrapped
 * before bug 262), `--lsq-nonmyopic-seed <cardano-node ledger state file>` seeds it in memory,
 * advanced over the store's boundaries (scripts/lsq-host.ts on a node's stores, read-only). Null: unknown.
 */
export async function nonMyopicFor(stake: StakeReads, gov: GovReads, epoch: number, key: string, env: AdvanceEnv): Promise<NonMyopicState | null> {
    const stored = stake.nonMyopic(epoch);
    if (stored) return stored;
    const seedPath = settings().lsqNonmyopicSeed ?? undefined;
    if (!seedPath) return null;
    const k = `${epoch}:${key}`;
    let p = seedMemo.get(k);
    if (!p) {
        p = (async () => {
            const seed = nonMyopicOfLedgerState(new Uint8Array(readFileSync(seedPath)));
            // the store may hold an epoch between the seed's and the view's: start from the latest one
            let from = seed;
            for (let e = epoch - 1; e > seed.epoch; e--) { const s = stake.nonMyopic(e); if (s) { from = s; break; } }
            return advanceNonMyopicTo(from, epoch, stake, gov, env);
        })();
        seedMemo.set(k, p);
        while (seedMemo.size > 4) seedMemo.delete(seedMemo.keys().next().value!);
    }
    return p;
}
