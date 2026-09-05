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
 * Strictness: schedule, registration and VRF binding fail the header. The
 * σ threshold and the counter are reported until the local stake snapshot is
 * proven exact against a reference (see PLAN_FULL_VALIDATION.md, Phase 2).
 */
import { sql } from "../../sql";
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
    sigma: false,
    opcertCounter: false,
};

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

    constructor(private readonly config: any, private readonly genesis: any) {}

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
            const rows = (await sql`SELECT pool_id, vrf_key_hash FROM epoch_pool_params WHERE taken_at = ${takenAt}`.values()) as unknown[][];
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
                const stake = dist.stake.get(h.issuerHash) ?? 0n;
                const leads = dist.total > 0n && isSlotLeader(h.leaderValue, { num: stake, den: dist.total }, ctx.activeSlotsCoeff);
                if (!leads) {
                    const msg = `leader value fails the threshold for σ=${stake}/${dist.total} (snapshot ${dist.takenAt}, ${dist.stake.size} pools, issuer ${h.issuerHash.slice(0, 12)}…)`;
                    if (STRICT_LEADER_CHECKS.sigma) return fail(msg);
                    reports.push(msg);
                }
            }
        }

        // The counter may not decrease along the chain. Headers at or before the block
        // that set the stored counter (a lagging verifier re-sending applied history)
        // are not "after" it; comparing them produced thousands of false reports.
        const last = await opcertCounterState(h.issuerHash);
        if (last != null && BigInt(h.slot) > BigInt(last.slot) && h.opcertCounter < last.counter) {
            const msg = `operational certificate counter ${h.opcertCounter} below the last seen ${last.counter} (set at slot ${last.slot})`;
            if (STRICT_LEADER_CHECKS.opcertCounter) return fail(msg);
            reports.push(msg);
        }
        return { ok: true, reports };
    }
}
