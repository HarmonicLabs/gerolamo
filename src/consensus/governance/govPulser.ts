/**
 * The DRep pulser's frozen snapshot (bug 167): what cardano-ledger-conway 1.22.1 copies when it sets
 * up the pulser at the start of an epoch (`setFreshDRepPulsingState`) and keeps unchanged until the
 * next boundary — `psProposals` (the live proposals with their vote maps as of then), `psDRepDistr`
 * (the distribution `computeDRepDistr` yields, zero entries included), `psDRepState` (`vsDReps` as of
 * then: raw expiry, deposit, delegator set) and `psPoolDistr`. The node-to-client queries
 * GetProposals (31) and GetDRepStakeDistr (26) answer from it, and GetGovState (24) embeds it
 * (ledger-api `queryProposals`, `queryDRepStakeDistr`, `queryGovState`): a DRep vote cast before the
 * boundary and removed by a deregistration after it stays in the epoch's answers, while the live
 * proposals no longer hold it. Ours re-derived the pulser from the live state, so the two nodes'
 * answers differed from the relay's for the rest of any such epoch.
 *
 * `snapshotAtBoundary` runs inside the boundary (state.ts `ratifyForNext`) from the very data the
 * round is tallied with, so the ratification and the answers agree by construction.
 * `backfillPulserSnapshot` reconstructs the current epoch's snapshot on a restart whose boundary ran
 * before this code: proposals and their votes from the chain (the vote rules of govVotesRepair.ts up
 * to the epoch's first slot), the DRep distribution from the boundary's stored `drep_stake`, and the
 * DRep states, delegations and pool delegations from the store's state at the last block before the
 * epoch when that block is still in the ledger store's volatile window ("backfill-exact"), else from
 * today's state ("backfill-approx": a DRep that registered, voted or was delegated to since the
 * boundary carries today's values).
 */
import { sql } from "../../sql";
import type { LedgerStore } from "../../ledger/LedgerStore";
import { GovReads, type PulserSnapshot } from "../../ledger/govStore";
import { StakeReads } from "../../ledger/stakeStore";
import { getLedgerStore, ledgerGov, ledgerGovReads, ledgerKeepEpochs, ledgerStake, ledgerStakeReads, sqlLedgerWrites } from "../../ledger/nodeLedgerStore";
import { logger } from "../../utils/logger";
import { epochForSlot, firstSlotOfEpoch } from "../../utils/epochFromSlotCalculations";
import { drepCredOfRow, loadLiveProposals } from "./govLedgerView";
import { typedOf } from "./govTxDecode";
import { govTxsOfBlock, survivingVotes } from "./govVotesRepair";
import type { RatifyInput } from "./ratify";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; };
const drepDistrKey = (d: { type: number; hash: string }) => `${d.type}:${d.hash}`;

/** Reads the snapshot is built from: the gov and stake state (as of the boundary) and the boundary's stake snapshot. */
export interface PulserSources {
    gov: GovReads;
    stake: StakeReads;
    /** The boundary's stored DRep stake (non-zero sums) and pool stake: the current store. */
    now: { gov: GovReads; stake: StakeReads };
}

/** DRep states (`vsDReps`) with their delegator sets, from the gov reads of one point. */
export function drepStatesOf(gov: GovReads): PulserSnapshot["drepStates"] {
    const delegators = new Map<string, string[]>();
    for (const [stakeKey, d] of gov.drepDelegations()) {
        if ((d.type !== 0 && d.type !== 1) || !d.hash) continue;
        const k = typedOf(d.type, d.hash);
        let l = delegators.get(k); if (!l) delegators.set(k, (l = []));
        l.push(stakeKey);
    }
    const out: PulserSnapshot["drepStates"] = [];
    for (const [k, row] of gov.dreps()) {
        const cred = drepCredOfRow(k, row.isScript);
        out.push({ cred, expiry: row.expiryEpoch ?? row.lastActiveEpoch, deposit: row.deposit, delegators: (delegators.get(cred) ?? []).sort() });
    }
    return out.sort(byKey((s) => s.cred));
}

/** `computeDRepDistr`: the stored non-zero sums plus a zero entry for every DRep (registered, or predefined) some account delegates to. */
export function drepDistrOf(epoch: number, src: PulserSources): PulserSnapshot["drepDistr"] {
    const out = new Map<string, { type: number; hash: string; stake: string }>();
    for (const r of src.now.gov.drepStake(epoch)) { const e = { type: r.type, hash: r.type <= 1 ? r.hash : "", stake: r.stake.toString() }; out.set(drepDistrKey(e), e); }
    const registered = new Set<string>();
    for (const [k, row] of src.gov.dreps()) registered.add(drepCredOfRow(k, row.isScript));
    for (const [, d] of src.gov.drepDelegations()) {
        const e = { type: d.type, hash: d.type <= 1 ? String(d.hash) : "", stake: "0" };
        if (out.has(drepDistrKey(e))) continue;
        if (d.type <= 1 && !registered.has(typedOf(d.type, String(d.hash)))) continue;
        out.set(drepDistrKey(e), e);
    }
    return [...out.values()].sort(byKey(drepDistrKey));
}

/** `psPoolDistr`: the boundary's pool snapshot (zero-stake pools included) plus the live proposals' deposits at the pools their return accounts delegate to. */
export function poolDistrOf(epoch: number, src: PulserSources, proposals: Array<{ returnAccount: string; deposit: bigint }>): PulserSnapshot["poolDistr"] {
    const stake = new Map(src.now.stake.snapshotPoolStake(epoch));
    for (const id of src.now.stake.snapshotZeroPools(epoch)) if (!stake.has(id)) stake.set(id, 0n);
    for (const p of proposals) { const pool = src.stake.delegationOf(p.returnAccount); if (pool && stake.has(pool)) stake.set(pool, stake.get(pool)! + p.deposit); }
    return [...stake.entries()].sort(byKey((e) => e[0])).map(([k, v]) => [k, v.toString()] as [string, string]);
}

const sortedVotes = (m: Map<string, number>): Array<[string, number]> => [...m.entries()].sort(byKey((e) => e[0]));

/**
 * The snapshot at the boundary of `epoch`, from the ratification round's input (the same proposals,
 * votes and distributions the round is tallied with) and the store's state at that moment.
 */
export function snapshotAtBoundary(input: RatifyInput, src: PulserSources, boundary: PulserSnapshot["boundary"], deposits: Map<string, { returnAccount: string; deposit: bigint }>): PulserSnapshot {
    const distr = new Map<string, { type: number; hash: string; stake: string }>();
    for (const [k, st] of input.drepDistr) {
        const e = k === "abstain" ? { type: 2, hash: "" } : k === "noconfidence" ? { type: 3, hash: "" } : { type: k.length === 58 ? 1 : 0, hash: k.length === 58 ? k.slice(2) : k };
        distr.set(drepDistrKey(e), { ...e, stake: st.toString() });
    }
    for (const e of drepDistrOf(input.epoch, src)) if (!distr.has(drepDistrKey(e))) distr.set(drepDistrKey(e), e);
    const snap: PulserSnapshot = { // version stamped by the completion below
        epoch: input.epoch, boundary, source: "boundary",
        proposals: input.proposals.map((p) => ({ actionId: p.id, cc: sortedVotes(p.ccVotes), drep: sortedVotes(p.drepVotes), spo: sortedVotes(p.spoVotes) })),
        drepDistr: [...distr.values()].sort(byKey(drepDistrKey)),
        drepStates: drepStatesOf(src.gov),
        poolDistr: input.poolDistr.size ? [...input.poolDistr.entries()].sort(byKey((e) => e[0])).map(([k, v]) => [k, v.toString()] as [string, string]) : poolDistrOf(input.epoch, src, [...deposits.values()]),
    };
    return completePulserPoolDistr(snap, src.now.stake, [...deposits.values()], src.stake);
}

/** Snapshot layout version: 2 since bug 247 (zero-stake pools in the pool distribution). */
export const PULSER_VERSION = 2;

/**
 * Bug 247: the boundary wrote the pool distribution from the stake snapshot's non-zero sums, leaving
 * out the pools whose delegators hold nothing — `calculatePoolDistr` (EpochBoundary.hs) folds over
 * the snapshot's delegations, so every delegated-to pool is listed, at 0 when its delegators' stake
 * is 0 (36 of the 681 pools of preview epoch 1437). Adds the snapshot's zero-stake pools that are
 * missing (with any live proposal deposit whose return account delegates to them) and stamps the
 * version; a snapshot already at the version is returned as is.
 */
export function completePulserPoolDistr(snap: PulserSnapshot, stakeNow: StakeReads, deposits: Array<{ returnAccount: string; deposit: bigint }>, stakeAt: StakeReads = stakeNow): PulserSnapshot {
    if ((snap.version ?? 1) >= PULSER_VERSION) return snap;
    const distr = new Map(snap.poolDistr.map(([k, v]) => [k, BigInt(v)]));
    for (const id of stakeNow.snapshotZeroPools(snap.epoch)) if (!distr.has(id)) {
        let v = 0n;
        for (const d of deposits) if (stakeAt.delegationOf(d.returnAccount) === id) v += d.deposit;
        distr.set(id, v);
    }
    return { ...snap, version: PULSER_VERSION, poolDistr: [...distr.entries()].sort(byKey((e) => e[0])).map(([k, v]) => [k, v.toString()] as [string, string]) };
}

let poolDistrFixed = false;
/**
 * One-time correction at restart (from `migrateGovCredentials`, inside the first Conway block
 * applied): the current epoch's stored snapshot, when a boundary wrote it before bug 247, gets its
 * zero-stake pools. The deposits of pools missing from it use today's delegations (a return account
 * that re-delegated since the boundary is the only inexactness, none on preview).
 */
export async function fixPulserPoolDistrOnce(): Promise<number | null> {
    if (poolDistrFixed) return null;
    const gr = ledgerGovReads() ?? ledgerGov()?.reads ?? null, sr = ledgerStakeReads() ?? ledgerStake()?.reads ?? null;
    if (!gr || !sr || !gr.state()) return null;
    poolDistrFixed = true;
    let fixed = 0;
    for (const e of gr.pulserEpochs()) {
        const snap = gr.pulserSnapshot(e);
        if (!snap || (snap.version ?? 1) >= PULSER_VERSION) continue;
        const live = gr.proposals(["active", "ratified"]).filter((p) => p.proposedEpoch < e).map((p) => ({ returnAccount: p.returnAccount, deposit: BigInt(p.deposit) }));
        const done = completePulserPoolDistr(snap, sr, live);
        await storePulserSnapshot(done);
        fixed++;
        logger.info(`governance pulser snapshot of epoch ${e} completed (bug 247): ${done.poolDistr.length - snap.poolDistr.length} zero-stake pool(s) added, ${done.poolDistr.length} pools`);
    }
    return fixed;
}
export function resetPulserPoolDistrFixForTests(): void { poolDistrFixed = false; }

/** Write the snapshot (inside the block being applied) and forget the epochs beyond the retention window. */
export async function storePulserSnapshot(snap: PulserSnapshot): Promise<void> {
    const gw = ledgerGov();
    if (gw) {
        gw.putPulserSnapshot(snap);
        const cutoff = snap.epoch - ledgerKeepEpochs();
        for (const e of gw.reads.pulserEpochs()) if (e < cutoff) gw.delPulserSnapshot(e);
    }
    if (sqlLedgerWrites()) {
        await sql`CREATE TABLE IF NOT EXISTS gov_pulser_snapshot (epoch INTEGER PRIMARY KEY, snapshot TEXT NOT NULL)`;
        await sql`INSERT OR REPLACE INTO gov_pulser_snapshot (epoch, snapshot) VALUES (${snap.epoch}, ${JSON.stringify(snap)})`;
        await sql`DELETE FROM gov_pulser_snapshot WHERE epoch < ${snap.epoch - ledgerKeepEpochs()}`;
    }
}

// ───────────────────────────── backfill ─────────────────────────────

export interface BackfillContext {
    epoch: number;
    ledger: LedgerStore | null;
    /** The selected chain's blocks with slot in [from, to], ascending (scripts/gov-* and the node use blockReads.selectedChain). */
    chain: (fromSlot: number, toSlot: number) => AsyncIterable<{ slot: number; hash: Uint8Array; bytes: Uint8Array }>;
    now: { gov: GovReads; stake: StakeReads };
    /** Reads pinned to a past block of the ledger store (view.ts); null when the point is not in the volatile window. */
    viewAt: (slot: number, hash: Uint8Array) => { gov: GovReads; stake: StakeReads } | null;
    /** Tests feed decoded transactions; default: decode the block bytes. */
    txsOfBlock?: (b: { slot: number; bytes: Uint8Array }) => ReturnType<typeof govTxsOfBlock>;
}

/** Reconstruct the current epoch's snapshot (see the module comment). */
export async function backfillPulserSnapshot(ctx: BackfillContext): Promise<{ snap: PulserSnapshot; blocks: number; txs: number }> {
    const E = ctx.epoch, start = Number(firstSlotOfEpoch(E));
    // the last block before the epoch: the state the pulser copied
    let boundary: { slot: number; hash: Uint8Array } | null = null;
    for await (const b of ctx.chain(Math.max(0, start - 400_000), start - 1)) boundary = { slot: b.slot, hash: b.hash };
    const at = boundary ? ctx.viewAt(boundary.slot, boundary.hash) : null;
    const src: PulserSources = { gov: at?.gov ?? ctx.now.gov, stake: at?.stake ?? ctx.now.stake, now: ctx.now };
    // proposals the pulser holds: live now and submitted before the epoch (removals happen at boundaries only)
    const live = ctx.now.gov.proposals(["active", "ratified"]).filter((p) => p.proposedEpoch < E);
    const ids = new Set(live.map((p) => p.actionId));
    const txs: Array<{ slot: number; model: ReturnType<typeof govTxsOfBlock>[number]["model"] }> = [];
    let blocks = 0;
    const txsOfBlock = ctx.txsOfBlock ?? ((b) => govTxsOfBlock(b.slot, b.bytes));
    if (live.length) for await (const b of ctx.chain(Number(firstSlotOfEpoch(Math.min(...live.map((p) => p.proposedEpoch)))), start - 1)) { blocks++; txs.push(...txsOfBlock(b)); }
    const votes = survivingVotes(txs, ids);
    const proposals: PulserSnapshot["proposals"] = live.map((p) => {
        const m = votes.get(p.actionId)!;
        const cc = new Map<string, number>(), drep = new Map<string, number>(), spo = new Map<string, number>();
        for (const v of m.values()) { if (v.voterKind <= 1) cc.set(typedOf(v.voterKind, v.voterHash), v.vote); else if (v.voterKind <= 3) drep.set(typedOf(v.voterKind - 2, v.voterHash), v.vote); else spo.set(v.voterHash, v.vote); }
        return { actionId: p.actionId, cc: sortedVotes(cc), drep: sortedVotes(drep), spo: sortedVotes(spo) };
    });
    const snap: PulserSnapshot = {
        epoch: E, boundary: boundary ? { slot: boundary.slot, hash: hex(boundary.hash) } : null, source: at ? "backfill-exact" : "backfill-approx", version: PULSER_VERSION,
        proposals, drepDistr: drepDistrOf(E, src), drepStates: drepStatesOf(src.gov),
        poolDistr: poolDistrOf(E, src, live.map((p) => ({ returnAccount: p.returnAccount, deposit: BigInt(p.deposit) }))),
    };
    return { snap, blocks, txs: txs.length };
}

/** A `viewAt` over a ledger store: the frozen read view at a past block of the selected chain (view.ts's PointView), or null. */
export async function ledgerViewAt(store: LedgerStore | null): Promise<BackfillContext["viewAt"]> {
    if (!store) return () => null;
    const { PointView, resolveAcquireTarget } = await import("../../network/n2c/lsq/view");
    return (slot, hash) => {
        const r = resolveAcquireTarget(store, { kind: "point", slot: BigInt(slot), hash: hex(hash) });
        if ("failure" in r) return null;
        const pv = new PointView(store, r.chain) as unknown as ConstructorParameters<typeof GovReads>[0];
        return { gov: new GovReads(pv), stake: new StakeReads(pv) };
    };
}

/** How the snapshot compares with the live store's votes (the dry-run's report): votes the snapshot holds that the store no longer has, and the reverse. */
export function describePulserSnapshot(snap: PulserSnapshot, gov: GovReads): string[] {
    const out = [`epoch ${snap.epoch} (${snap.source}; boundary block ${snap.boundary ? `${snap.boundary.slot} ${snap.boundary.hash.slice(0, 16)}…` : "unknown"}): ${snap.proposals.length} proposal(s), ${snap.drepDistr.length} DRep distribution entr(y|ies), ${snap.drepStates.length} DRep state(s), ${snap.poolDistr.length} pool(s)`];
    for (const p of snap.proposals) {
        const frozen = new Map<string, number>();
        for (const [c, v] of p.cc) frozen.set(`cc ${c}`, v);
        for (const [c, v] of p.drep) frozen.set(`drep ${c}`, v);
        for (const [c, v] of p.spo) frozen.set(`spo ${c}`, v);
        const now = new Map<string, number>();
        for (const v of gov.votes(p.actionId)) now.set(`${v.voterKind <= 1 ? "cc" : v.voterKind <= 3 ? "drep" : "spo"} ${v.voterKind <= 1 ? typedOf(v.voterKind, v.voterHash) : v.voterKind <= 3 ? typedOf(v.voterKind - 2, v.voterHash) : v.voterHash}`, v.vote);
        for (const [k, v] of frozen) { const n = now.get(k); if (n === undefined) out.push(`  ${p.actionId.slice(0, 12)}… ${k} vote ${v}: in the epoch's snapshot, not in the live proposals`); else if (n !== v) out.push(`  ${p.actionId.slice(0, 12)}… ${k}: snapshot vote ${v}, live ${n}`); }
        for (const [k, v] of now) if (!frozen.has(k)) out.push(`  ${p.actionId.slice(0, 12)}… ${k} vote ${v}: cast after the boundary (live only)`);
    }
    return out;
}

let attempted = false;
/**
 * The node's one-time backfill on restart (from `migrateGovCredentials`, inside the first Conway
 * block applied): the epoch of the selected tip (the block's parent) gets its snapshot when the
 * store has none for it or any later epoch — a boundary this build ran has written one already.
 */
export async function backfillPulserSnapshotOnce(): Promise<PulserSnapshot | null> {
    if (attempted) return null;
    const gr = ledgerGovReads() ?? ledgerGov()?.reads ?? null, sr = ledgerStakeReads() ?? ledgerStake()?.reads ?? null; // dual mode too (bug 246)
    if (!gr || !sr || !gr.state()) return null;
    const { getNodeBlockStore } = await import("../../storage/nodeBlockStore");
    const { selectedChain, selectedTip } = await import("../../storage/blockReads");
    const bs = getNodeBlockStore();
    if (!bs) { attempted = true; return null; }
    attempted = true;
    const tip = await selectedTip(bs);
    if (!tip) return null;
    const E = Number(epochForSlot(tip.slot));
    if (gr.pulserEpochs().some((e) => e >= E)) return null;
    const t0 = performance.now();
    const ledger = getLedgerStore();
    const { snap, blocks, txs } = await backfillPulserSnapshot({ epoch: E, ledger, chain: (from, to) => selectedChain(bs, from, to), now: { gov: gr, stake: sr }, viewAt: await ledgerViewAt(ledger) });
    await storePulserSnapshot(snap);
    for (const line of describePulserSnapshot(snap, gr)) logger.info(`governance pulser backfill (bug 167): ${line}`);
    logger.info(`governance pulser backfill (bug 167): ${blocks} block(s), ${txs} transaction(s) walked in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return snap;
}
export function resetPulserBackfillForTests(): void { attempted = false; }
