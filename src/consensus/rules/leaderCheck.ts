/**
 * Main-thread header rules that need ledger state (the workers verify the
 * crypto: KES, VRF proof, operational certificate signature):
 *
 *   overlay slots (TPraos, d > 0): the scheduled genesis delegate must issue,
 *   with that delegate's registered VRF key; no block may sit in an inactive
 *   overlay slot.
 *   Praos slots: the issuer must be a registered pool whose registered VRF key
 *   hash matches the header's, and its leader value must clear the threshold
 *   for its relative stake σ from the epoch's snapshot.
 *   Operational certificate counters never decrease for a pool.
 *
 * Strictness: schedule, registration, VRF binding and a decreasing opcert counter
 * fail the header; the σ threshold when the stake snapshot is exact, an
 * over-incremented counter when the counter state as of the header's parent is
 * known (see STRICT_LEADER_CHECKS).
 */
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { sql } from "../../sql";
import { ledgerStakeReads, ledgerStateExact, primaryLedgerStore } from "../../ledger/nodeLedgerStore";
import { StakeReads } from "../../ledger/stakeStore";
import { genesisDelegsAt, opcertCounterState, poolStakeForEpoch, registeredPoolVrf, type PoolStakeDistribution } from "../../db/leaderState";
import { getEpochBodyParams } from "../epochParams";
import { firstSlotOfEpoch } from "../../utils/epochFromSlotCalculations";
import { isSlotLeader } from "./leaderMath";
import { overlaySlotKind, rationalFromDecimal, type Rational } from "./overlay";

export interface ShelleyHeaderFacts {
    era: number;
    slot: bigint;
    epoch: number;
    /** blake2b-224 of the issuer cold vkey, hex. */
    issuerHash: string;
    /** blake2b-256 of the VRF vkey, hex. */
    vrfKeyHash: string;
    /** Leader value bytes: 32-byte "L"-hash (Praos) or 64-byte VRF output (TPraos). */
    leaderValue: Uint8Array;
    opcertCounter: number;
    /** Header hash and its parent's (hex): the counter rule reads the counter state as of the parent. */
    hash?: string;
    prevHash?: string | null;
}

export interface LeaderVerdict {
    ok: boolean;
    reason?: string;
    reports: string[];
}

export const STRICT_LEADER_CHECKS = {
    overlay: true,
    poolRegistered: true,
    vrfBinding: true,
    /**
     * Forces σ strict everywhere. Otherwise it is strict when the snapshot is exact (`ledgerStateExact`:
     * an LMDB store imported from a NewEpochState, whose snapshots are the ledger's — GetPoolDistr2 and
     * GetStakeSnapshots byte-identical with cardano-node, every preview header of epochs 1419–1437
     * clearing its threshold, bug 275) and reported otherwise: the from-genesis SQLite replays of node
     * 3036 (2026-09-08) reported 41 canonical blocks just above our threshold (open item 3: snapshot ppm off).
     */
    sigma: false,
    /**
     * `CounterTooSmallOCERT` (n < m) is strict since 2026-09-28: the Praos/TPraos counter rule
     * held for every header of preview from genesis (scripts/utxo-rules-replay.ts, bug 183), and
     * the stored counter can only lag the header (checked ahead of apply), which never makes
     * n < m false-positive; headers at or before the stored counter's slot are skipped.
     */
    opcertCounter: true,
    /**
     * Forces `CounterOverIncrementedOCERT` (Praos, n > m + 1) strict everywhere. Otherwise it is strict
     * when m is the counter state as of the header's parent — the ledger store's state at the nearest
     * held ancestor, overridden by the headers validated on the way (bug 276) — and that store is exact
     * (`ledgerStateExact`); reported otherwise. The tip's counters lag a header checked ahead of apply
     * (a pool that rotated twice inside that window would be rejected), and a store seeded from SQLite
     * can hold stale counters: the producer's of 2026-09-30 had 520 for a pool the chain had moved to
     * 524, and reported 525 as over-incremented.
     */
    opcertOverIncrement: false,
};

/** The counter state the OCERT rule reads, pinned at a block. */
export interface CounterStateSource {
    /** Does the store hold the state after this block (hex)? */
    holds(blockHex: string): boolean;
    /** The pool's counter in the state after a held block; null = none recorded. */
    counterAt(blockHex: string, pool: string): { counter: number; slot: number } | null;
}

/** The node's LMDB ledger store (lmdb mode): the anchor and every volatile block of the selected chain. */
export const ledgerStoreCounters: CounterStateSource = {
    holds: (h) => { const st = primaryLedgerStore(); return !!st && st.knowsHex(h); },
    counterAt: (h, pool) => { const v = primaryLedgerStore()?.viewAt(fromHex(h)); return v ? new StakeReads(v).opcert(pool) : null; },
};

export interface LeaderCheckerOptions {
    counters?: CounterStateSource;
    /** Are the stake snapshot and the counters exact (σ and the over-increment strict)? Default: `ledgerStateExact`. */
    stateExact?: () => { exact: boolean; why: string };
}

/**
 * OCERT counter rule for a header (Praos `validateKESSignature` / TPraos OCERT): with m the
 * last counter the chain-dependent state holds for the issuer (0 for a pool it has never seen
 * but that is in the stake distribution), `m ≤ n` always and, from Babbage (Praos), `n ≤ m + 1`.
 */
export function opcertCounterVerdict(era: number, lastCounter: number | null, n: number): { tooSmall: boolean; overIncremented: boolean; m: number } {
    const m = lastCounter ?? 0;
    return { m, tooSmall: n < m, overIncremented: era >= 6 && n > m + 1 };
}

interface EpochContext {
    epoch: number;
    d: Rational;
    activeSlotsCoeff: number;
    firstSlot: bigint;
    genesisKeysSorted: string[];
    genesisDelegs: Map<string, { delegate: string; vrf: string }>;
    distribution: PoolStakeDistribution | null;
    /** Pool parameters (VRF key) of the snapshot that leads the epoch, when recorded. */
    snapshotPools: Map<string, { vrf: string }> | null;
}

export class LeaderChecker {
    private readonly cache = new Map<number, Promise<EpochContext>>();
    private readonly pools = new Map<string, string | null>();
    /**
     * Validated headers (applied or not): parent and the opcert counter each set, so a header is
     * judged by the counters of its own chain — Praos `csCounters` after its parent — rather than
     * by the applied tip's. Insertion order; the oldest are evicted past HEADER_MEMORY.
     */
    private readonly headers = new Map<string, { prev: string | null; issuer: string; counter: number; slot: number }>();
    private static readonly HEADER_MEMORY = 50_000;
    /** A walk longer than this (a header far ahead of everything held) falls back to the tip's counters. */
    private static readonly MAX_WALK = 20_000;
    private readonly counters: CounterStateSource;
    private readonly stateExact: () => { exact: boolean; why: string };

    constructor(private readonly config: any, private readonly genesis: any, opts: LeaderCheckerOptions = {}) {
        this.counters = opts.counters ?? ledgerStoreCounters;
        this.stateExact = opts.stateExact ?? ledgerStateExact;
    }

    /** Record a validated header's counter (headers whose VRF check is deferred are recorded at once: the opcert is verified). */
    noteHeader(hash: string, prevHash: string | null | undefined, issuerHash: string, counter: number, slot: bigint | number): void {
        const k = hash.toLowerCase();
        if (this.headers.has(k)) return;
        this.headers.set(k, { prev: prevHash ? prevHash.toLowerCase() : null, issuer: issuerHash.toLowerCase(), counter, slot: Number(slot) });
        if (this.headers.size > LeaderChecker.HEADER_MEMORY) for (const old of this.headers.keys()) { this.headers.delete(old); if (this.headers.size <= LeaderChecker.HEADER_MEMORY * 0.9) break; }
    }

    /**
     * The pool's counter as of block `prevHex` along that block's own chain: walking back from it, the
     * first block the store holds answers from the store's state there (it includes everything below),
     * a validated header of the same pool on the way answers with its counter. Null when neither is
     * reached (sqlite mode, an unknown parent): the caller falls back to the tip's counters.
     */
    counterAsOf(prevHex: string | null | undefined, pool: string): { state: { counter: number; slot: number } | null } | null {
        let cur = prevHex ? prevHex.toLowerCase() : null;
        for (let steps = 0; cur && steps < LeaderChecker.MAX_WALK; steps++) {
            if (this.counters.holds(cur)) return { state: this.counters.counterAt(cur, pool) };
            const h = this.headers.get(cur);
            if (!h) return null;
            if (h.issuer === pool) return { state: { counter: h.counter, slot: h.slot } };
            cur = h.prev;
        }
        return null;
    }

    /** Drop cached state (epoch boundary applied, rollback, pool changes). */
    invalidate(): void {
        this.cache.clear();
        this.pools.clear();
    }

    private context(epoch: number, slot: bigint): Promise<EpochContext> {
        let p = this.cache.get(epoch);
        if (!p) {
            p = this.buildContext(epoch, slot);
            this.cache.set(epoch, p);
            if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        }
        return p;
    }

    private async buildContext(epoch: number, slot: bigint): Promise<EpochContext> {
        const params = await getEpochBodyParams(this.config, epoch).catch(() => null);
        const raw = params?.raw ?? {};
        const dRaw = raw.decentralisation_param ?? this.genesis?.protocolParams?.decentralisationParam ?? 0;
        const d = rationalFromDecimal(String(dRaw));
        const genesisDelegs = await genesisDelegsAt(Number(slot));
        return {
            epoch,
            d,
            activeSlotsCoeff: Number(this.genesis?.activeSlotsCoeff ?? 0.05),
            firstSlot: firstSlotOfEpoch(epoch), // the process-wide epoch geometry (setEpochNetwork at startup)
            genesisKeysSorted: [...genesisDelegs.keys()].sort(),
            genesisDelegs,
            distribution: await poolStakeForEpoch(epoch),
            // Pool parameters as of the snapshot that leads this epoch: Praos judges a header
            // by the epoch's stake distribution (stake + VRF key), not by the live registry —
            // a pool retired at this boundary still forges through the epoch its snapshot leads.
            snapshotPools: await this.snapshotPools(epoch),
        };
    }

    private async snapshotPools(epoch: number): Promise<Map<string, { vrf: string }> | null> {
        const takenAt = epoch - 1;
        try {
            const sr = ledgerStakeReads();
            const rows: unknown[][] = sr
                ? [...sr.snapshotPoolParams(takenAt)].map(([id, p]) => [id, p.vrf])
                : (await sql`SELECT pool_id, vrf_key_hash FROM epoch_pool_params WHERE taken_at = ${takenAt}`.values()) as unknown[][];
            if (!rows.length) return null;
            return new Map(rows.map((r) => [String(r[0]).toLowerCase(), { vrf: String(r[1]).toLowerCase() }]));
        } catch {
            return null;
        }
    }

    private async poolVrf(poolId: string): Promise<string | null> {
        if (this.pools.has(poolId)) return this.pools.get(poolId)!;
        const v = await registeredPoolVrf(poolId);
        this.pools.set(poolId, v);
        return v;
    }

    async check(h: ShelleyHeaderFacts): Promise<LeaderVerdict> {
        const reports: string[] = [];
        const fail = (reason: string): LeaderVerdict => ({ ok: false, reason, reports });
        const ctx = await this.context(h.epoch, h.slot);
        const asc = rationalFromDecimal(String(ctx.activeSlotsCoeff));
        const kind = overlaySlotKind(h.slot, ctx.firstSlot, ctx.d, asc, ctx.genesisKeysSorted);

        if (kind.kind === "inactive") {
            const msg = `slot ${h.slot} is an inactive overlay slot (d=${ctx.d.num}/${ctx.d.den}); no block may be issued`;
            if (STRICT_LEADER_CHECKS.overlay) return fail(msg);
            reports.push(msg);
        } else if (kind.kind === "genesis") {
            const gd = ctx.genesisDelegs.get(kind.genesisKeyHash);
            if (!gd) return fail(`overlay slot scheduled for genesis key ${kind.genesisKeyHash.slice(0, 12)}… with no delegation in force`);
            if (gd.delegate !== h.issuerHash) {
                const msg = `overlay slot ${h.slot} belongs to genesis delegate ${gd.delegate.slice(0, 12)}…, issued by ${h.issuerHash.slice(0, 12)}…`;
                if (STRICT_LEADER_CHECKS.overlay) return fail(msg);
                reports.push(msg);
            }
            if (gd.vrf !== h.vrfKeyHash) {
                const msg = `overlay issuer VRF key ${h.vrfKeyHash.slice(0, 12)}… ≠ registered ${gd.vrf.slice(0, 12)}…`;
                if (STRICT_LEADER_CHECKS.vrfBinding) return fail(msg);
                reports.push(msg);
            }
        } else {
            // Epoch-snapshot view first (the ledger's PoolDistr); live registry only when the
            // snapshot carries no parameters (DBs from before they were recorded).
            const snap = ctx.snapshotPools?.get(h.issuerHash);
            const vrf = ctx.snapshotPools ? (snap?.vrf ?? null) : await this.poolVrf(h.issuerHash);
            if (vrf == null) {
                const msg = `issuer ${h.issuerHash.slice(0, 12)}… is not a registered pool`;
                if (STRICT_LEADER_CHECKS.poolRegistered) return fail(msg);
                reports.push(msg);
            } else if (vrf !== h.vrfKeyHash) {
                const msg = `issuer VRF key ${h.vrfKeyHash.slice(0, 12)}… ≠ registered ${vrf.slice(0, 12)}…`;
                if (STRICT_LEADER_CHECKS.vrfBinding) return fail(msg);
                reports.push(msg);
            }
            const dist = ctx.distribution;
            if (!dist) {
                reports.push(`no stake snapshot for epoch ${h.epoch}; leader threshold not checked`);
            } else {
                // σ = the ledger's `individualPoolStake` for the epoch (`nesPd`, the snapshot taken at its
                // predecessor's start): spssStake / ssTotalActiveStake, exact. A pool outside the
                // distribution (no stake) has σ = 0 and leads no slot (Praos: VRFKeyUnknown).
                const stake = dist.stake.get(h.issuerHash) ?? 0n;
                const leads = dist.total > 0n && isSlotLeader(h.leaderValue, { num: stake, den: dist.total }, ctx.activeSlotsCoeff);
                if (!leads) {
                    const msg = `leader value fails the threshold for σ=${stake}/${dist.total} (snapshot ${dist.takenAt}, ${dist.stake.size} pools, issuer ${h.issuerHash.slice(0, 12)}…)`;
                    const ex = this.stateExact();
                    if (STRICT_LEADER_CHECKS.sigma || ex.exact) return fail(msg);
                    reports.push(`${msg} (report-only: ${ex.why})`);
                }
            }
        }

        // OCERT: m is the counter state as of the header's parent on the header's own chain (Praos
        // `csCounters`), exact when the walk reaches a held block or a validated header of the pool.
        // Otherwise the tip's counters stand in: headers at or before the block that set the stored
        // counter (a lagging verifier re-sending applied history) are not "after" it — comparing them
        // produced thousands of false reports — and an over-increment is only reported.
        const issuer = h.issuerHash.toLowerCase();
        const asOf = h.prevHash !== undefined ? this.counterAsOf(h.prevHash, issuer) : null;
        if (h.hash) this.noteHeader(h.hash, h.prevHash, issuer, h.opcertCounter, h.slot);
        const last = asOf ? asOf.state : await opcertCounterState(h.issuerHash);
        if (asOf || last == null || BigInt(h.slot) > BigInt(last.slot)) {
            const v = opcertCounterVerdict(h.era, last?.counter ?? null, h.opcertCounter);
            if (v.tooSmall) {
                const msg = `operational certificate counter ${h.opcertCounter} below the last seen ${v.m} (set at slot ${last?.slot})`;
                if (STRICT_LEADER_CHECKS.opcertCounter) return fail(msg);
                reports.push(msg);
            } else if (v.overIncremented) {
                const msg = `CounterOverIncrementedOCERT: operational certificate counter ${h.opcertCounter} more than one above ${v.m}${last ? ` (set at slot ${last.slot})` : " (no counter recorded)"} for ${issuer.slice(0, 12)}…`;
                const ex = asOf ? this.stateExact() : null;
                if (STRICT_LEADER_CHECKS.opcertOverIncrement || ex?.exact) return fail(msg);
                reports.push(`${msg} (report-only: ${ex ? ex.why : "the counter state as of the parent is not known here"})`);
            }
        }
        return { ok: true, reports };
    }
}
