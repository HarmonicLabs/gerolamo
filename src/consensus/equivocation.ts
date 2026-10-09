/**
 * Equivocation detection: two different valid headers signed by the same pool (cold key) for the
 * same slot. Two pools never share a cold key, so such a pair means the pool's keys are forging
 * in two places at once (a second producer with copied keys, or stolen hot keys).
 *
 * Observation only, as in Dingo (node_equivocation.go) and ouroboros-consensus, which has no
 * equivocation rule at all: both headers stay valid for chain selection. Praos chain selection
 * already settles a same-slot, same-issuer pair by the higher operational-certificate counter
 * (tieBreak.ts, comparePraos), which is how an operator who re-keys after a hot-key theft makes
 * the network prefer the new key. Treating the second header as invalid would let whoever
 * delivers first decide which block this node keeps, splitting it from the network.
 *
 * Differences from Dingo: Dingo only sees a competitor after a rollback removed one of the two
 * blocks and also counts "same block number" pairs (which an honest pool produces after losing
 * its own fork); here every validated header from every peer is compared as it arrives, and
 * only the same-slot rule of the task / ouroboros-network's definition is used.
 */
import { logger } from "../utils/logger";

export interface ObservedHeader {
    slot: bigint;
    /** Header hash (hex). */
    hash: string;
    /** Pool id: blake2b-224 of the issuer's cold verification key (hex). */
    poolId: string;
    vrfKeyHash?: string | null;
    opcertCounter?: number | bigint | null;
    blockNo?: bigint | number | null;
    /** Who delivered it: a peer key, or "self" for a block this node forged. */
    source: string;
}

export interface EquivocationRecord {
    slot: string;
    poolId: string;
    /** The pool is this node's own (our keys are in use elsewhere). */
    self: boolean;
    /** Both header hashes: first seen, then the competitor. */
    hashes: [string, string];
    sources: [string, string];
    opcertCounters: [string | null, string | null];
    detectedAt: string;
}

export interface EquivocationStats {
    /** Distinct equivocating header pairs seen since start. */
    total: number;
    /** Of those, pairs signed with this node's own pool key. */
    self: number;
    /** (slot, pool) entries currently remembered. */
    tracked: number;
    /** Newest last, at most RECENT_MAX. */
    recent: EquivocationRecord[];
}

/**
 * (slot, pool) entries kept, oldest forgotten first: about 10 days of preview / mainnet blocks
 * (one per ~20 slots), far beyond the k-block window in which a competing header can still
 * matter; about 4 MB (measured: 3.8 MB, 6 µs per header).
 */
export const TRACK_MAX = 10_000;
export const RECENT_MAX = 32;

interface FirstSeen { hash: string; source: string; opcertCounter: string | null; others?: Set<string> }

export class EquivocationDetector {
    private readonly seen = new Map<string, FirstSeen>();
    private readonly recentList: EquivocationRecord[] = [];
    private totalCount = 0;
    private selfCount = 0;
    private selfPool: string | null = null;

    constructor(private readonly opts: { trackMax?: number; onEquivocation?: (r: EquivocationRecord) => void } = {}) {}

    setSelfPoolId(poolId: string | null): void {
        this.selfPool = poolId ? poolId.toLowerCase() : null;
    }

    /** Record a validated header; returns the equivocation it completes, if any (each pair is reported once). */
    observe(h: ObservedHeader): EquivocationRecord | null {
        const pool = h.poolId.toLowerCase(), hash = h.hash.toLowerCase();
        const key = `${h.slot}|${pool}`;
        const counter = h.opcertCounter == null ? null : String(h.opcertCounter);
        const first = this.seen.get(key);
        if (!first) {
            this.seen.set(key, { hash, source: h.source, opcertCounter: counter });
            const max = this.opts.trackMax ?? TRACK_MAX;
            while (this.seen.size > max) this.seen.delete(this.seen.keys().next().value!);
            return null;
        }
        if (first.hash === hash || first.others?.has(hash)) return null;
        (first.others ??= new Set()).add(hash);
        const self = this.selfPool != null && this.selfPool === pool;
        const rec: EquivocationRecord = {
            slot: h.slot.toString(), poolId: pool, self,
            hashes: [first.hash, hash], sources: [first.source, h.source], opcertCounters: [first.opcertCounter, counter],
            detectedAt: new Date().toISOString(),
        };
        this.totalCount++;
        if (self) this.selfCount++;
        this.recentList.push(rec);
        if (this.recentList.length > RECENT_MAX) this.recentList.shift();
        const msg = `Equivocation: pool ${pool}${self ? " (THIS NODE'S POOL)" : ""} signed two different headers for slot ${h.slot}: ${first.hash} (from ${first.source}, opcert counter ${first.opcertCounter ?? "?"}) and ${hash} (from ${h.source}, opcert counter ${counter ?? "?"})`;
        if (self) logger.error(`${msg}. This pool's KES key is forging somewhere else too: stop the other producer, or rotate the KES key with a higher opcert counter.`);
        else logger.warn(msg);
        try { this.opts.onEquivocation?.(rec); } catch { /* observer only */ }
        return rec;
    }

    stats(): EquivocationStats {
        return { total: this.totalCount, self: this.selfCount, tracked: this.seen.size, recent: [...this.recentList] };
    }
}

/** The node-wide detector: fed by the header pipeline and by our own forged blocks. */
let detector = new EquivocationDetector();

export function getEquivocationDetector(): EquivocationDetector {
    return detector;
}

export function equivocationStats(): EquivocationStats {
    return detector.stats();
}

/** Tests only. */
export function resetEquivocationDetector(d: EquivocationDetector = new EquivocationDetector()): void {
    detector = d;
}
