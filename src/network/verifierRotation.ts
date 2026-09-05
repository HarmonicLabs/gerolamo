/**
 * Which hot verifiers to swap out because they have fallen too far behind the
 * primary to be useful near the tip.
 *
 * A verifier slower than the primary drops out of the k-deep comparison window
 * within minutes of a fast sync. Its headers are still checked against the
 * applied chain (ConsensusOrchestrator.confirmBehindPoint), so it keeps
 * confirming history, but agreement near the tip — what makes a rollback
 * possible — only comes from a verifier that keeps up. Past `maxLagSlots` it
 * is rotated for a warm peer, which starts at our tip and is fresh for a while.
 */

export interface RotationCandidate {
    key: string;
    role: "primary" | "verifier" | null;
    /** Slots between the primary's tip and this verifier's tip; null when unknown. */
    lagSlots: bigint | null;
    /** When the peer became hot; null when unknown. */
    promotedAt: number | null;
}

export interface RotationOpts {
    maxLagSlots: bigint;
    /** Give a fresh verifier this long before its lag counts. */
    minHotAgeMs: number;
    now: number;
}

export const DEFAULT_VERIFIER_MAX_LAG_SLOTS = 200_000n;
export const DEFAULT_VERIFIER_LAG_HOLD_MS = 10 * 60_000;
export const DEFAULT_VERIFIER_MIN_HOT_AGE_MS = 2 * 60_000;

/** Lagging verifiers, most behind first. Never the primary, never a fresh promotion. */
export function pickLaggingVerifiers(peers: RotationCandidate[], opts: RotationOpts): RotationCandidate[] {
    return peers
        .filter((p) =>
            p.role === "verifier" &&
            p.lagSlots != null &&
            p.lagSlots > opts.maxLagSlots &&
            (p.promotedAt == null || opts.now - p.promotedAt >= opts.minHotAgeMs)
        )
        .sort((a, b) => (b.lagSlots! > a.lagSlots! ? 1 : b.lagSlots! < a.lagSlots! ? -1 : 0));
}
