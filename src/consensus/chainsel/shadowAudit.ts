/**
 * Shadow-mode audit (chainSelection "shadow"): every decision the ouroboros-consensus selection would
 * have taken differently from legacy is followed up until it resolves —
 *
 *   switch / promote to a candidate tip T:
 *     "legacy-followed": T became part of our (legacy) chain later — praos was right, and earlier
 *                        (the latency is how much earlier);
 *     "legacy-kept":     our chain moved RESOLVE_SLOTS past T's slot without T — legacy stayed on its
 *                        branch; whichever the network kept is the right one (check the relay's log);
 *   disconnect a peer P:
 *     "peer-dropped":    legacy lost P too within RESOLVE_MS (held cold, terminated);
 *     "peer-kept":       P still connected RESOLVE_MS later.
 *
 * Pure bookkeeping; the orchestrator records decisions and calls `resolve` with its own lookups.
 */

export type ShadowKind = "switch" | "promote" | "disconnect";
export type ShadowVerdict = "legacy-followed" | "legacy-kept" | "peer-dropped" | "peer-kept";

export interface ShadowEntry {
    key: string;
    kind: ShadowKind;
    peer: string;
    tip?: { hash: string; slot: bigint };
    at: number;
    detail: string;
}

export interface ShadowResolution extends ShadowEntry { verdict: ShadowVerdict; resolvedAt: number }

export class ShadowAudit {
    static RESOLVE_MS = 180_000;
    static RESOLVE_SLOTS = 180n;
    private static readonly CAP = 256;
    private readonly pending: ShadowEntry[] = [];
    readonly recent: ShadowResolution[] = [];
    readonly counts = { recorded: 0, legacyFollowed: 0, legacyKept: 0, peerDropped: 0, peerKept: 0, followLatencyMsMax: 0 };

    record(e: Omit<ShadowEntry, "key">): boolean {
        const key = `${e.kind}:${e.peer}:${e.tip?.hash ?? ""}`;
        if (this.pending.some((p) => p.key === key)) return false;
        this.pending.push({ ...e, key });
        if (this.pending.length > ShadowAudit.CAP) this.pending.shift();
        this.counts.recorded++;
        return true;
    }

    get pendingCount(): number { return this.pending.length; }

    async resolve(now: number, deps: { isApplied(hash: string): Promise<boolean>; ourTipSlot: bigint | null; peerConnected(peer: string): boolean }): Promise<ShadowResolution[]> {
        const out: ShadowResolution[] = [];
        for (let i = 0; i < this.pending.length; i++) {
            const e = this.pending[i]!;
            let verdict: ShadowVerdict | null = null;
            if (e.kind === "disconnect") {
                if (!deps.peerConnected(e.peer)) verdict = "peer-dropped";
                else if (now - e.at >= ShadowAudit.RESOLVE_MS) verdict = "peer-kept";
            } else if (e.tip) {
                if (await deps.isApplied(e.tip.hash)) verdict = "legacy-followed";
                else if (now - e.at >= ShadowAudit.RESOLVE_MS && deps.ourTipSlot != null && deps.ourTipSlot >= e.tip.slot + ShadowAudit.RESOLVE_SLOTS) verdict = "legacy-kept";
            }
            if (!verdict) continue;
            this.pending.splice(i--, 1);
            const r: ShadowResolution = { ...e, verdict, resolvedAt: now };
            if (verdict === "legacy-followed") { this.counts.legacyFollowed++; this.counts.followLatencyMsMax = Math.max(this.counts.followLatencyMsMax, now - e.at); }
            else if (verdict === "legacy-kept") this.counts.legacyKept++;
            else if (verdict === "peer-dropped") this.counts.peerDropped++;
            else this.counts.peerKept++;
            this.recent.push(r);
            if (this.recent.length > 64) this.recent.shift();
            out.push(r);
        }
        return out;
    }

    snapshot() {
        return { ...this.counts, pending: this.pending.length, recent: this.recent.slice(-8).map((r) => ({ kind: r.kind, peer: r.peer, tip: r.tip ? `${r.tip.hash.slice(0, 12)}@${r.tip.slot}` : null, verdict: r.verdict, afterMs: r.resolvedAt - r.at })) };
    }
}
