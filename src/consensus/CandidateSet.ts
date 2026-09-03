/**
 * Multi-peer chain agreement ("keep it honest").
 *
 * network-design §5.2: ChainSync from every hot upstream peer yields a
 * *candidate chain* per peer; BlockFetch and adoption act on one of them.
 * Gerolamo keeps one **primary** hot peer whose headers drive BlockFetch and
 * apply, and treats every other hot peer as a **verifier**: its headers are
 * validated and compared, slot by slot, against the primary's fragment.
 *
 *   equal hash at a slot  → the verifier agrees (its trust score rises)
 *   different hash        → divergence; the caller decides whether that is a
 *                           lying peer (demote) or the primary being on the
 *                           wrong fork (majority of verifiers disagree with it)
 *
 * Fragments are bounded deques of `{slot, hash}` (depth `k`, 2160 by default).
 * A slot may carry several hashes (Byron EBB + first main block share a slot),
 * so agreement is "hash ∈ primary hashes at slot".
 *
 * Pure data structure — no I/O, no timers — so it is unit-testable and can
 * live on the main thread or in a worker.
 */

export type PeerRole = "primary" | "verifier";

export interface CandidatePoint {
    slot: bigint;
    hash: string;
    /** Byron epoch-boundary block: the same slot also holds the epoch's first main block. */
    ebb?: boolean;
}

export type AgreementStatus = "agrees" | "divergent" | "unknown" | "ahead" | "behind";

export interface PeerAgreement {
    key: string;
    role: PeerRole;
    status: AgreementStatus;
    /** Highest slot at which this peer matched the primary. */
    agreedAtSlot: bigint | null;
    /** Where it diverged, if it did. */
    divergence: { slot: bigint; peerHash: string; primaryHashes: string[] } | null;
    tipSlot: bigint | null;
    tipHash: string | null;
    headersSeen: number;
}

export type ObserveVerdict =
    | { kind: "primary-advance"; slot: bigint }
    | { kind: "agree"; slot: bigint }
    | { kind: "divergent"; slot: bigint; peerHash: string; primaryHashes: string[] }
    | { kind: "ahead"; slot: bigint }
    | { kind: "behind"; slot: bigint }
    | { kind: "duplicate"; slot: bigint }
    | { kind: "unknown-peer" };

interface Fragment {
    /** Ordered oldest→newest. */
    points: CandidatePoint[];
    bySlot: Map<string, string[]>;
}

interface PeerState {
    key: string;
    role: PeerRole;
    fragment: Fragment;
    agreedAtSlot: bigint | null;
    divergence: PeerAgreement["divergence"];
    headersSeen: number;
    /** Verifier headers beyond the primary tip, waiting to be compared. */
    pending: Map<string, string>;
}

function newFragment(): Fragment {
    return { points: [], bySlot: new Map() };
}

function fragmentPush(f: Fragment, p: CandidatePoint, depth: number): void {
    const key = p.slot.toString();
    const list = f.bySlot.get(key);
    if (list) {
        if (!list.includes(p.hash)) list.push(p.hash);
    } else {
        f.bySlot.set(key, [p.hash]);
    }
    f.points.push(p);
    while (f.points.length > depth) {
        const old = f.points.shift()!;
        const k = old.slot.toString();
        const l = f.bySlot.get(k);
        if (l) {
            const i = l.indexOf(old.hash);
            if (i >= 0) l.splice(i, 1);
            if (l.length === 0) f.bySlot.delete(k);
        }
    }
}

/** `host:port` → `host` (IPv6 literals keep their brackets). */
export function hostOfPeerKey(key: string): string {
    const i = key.lastIndexOf(":");
    if (i < 0) return key;
    const host = key.slice(0, i);
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function distinctHosts(keys: readonly string[]): number {
    return new Set(keys.map(hostOfPeerKey)).size;
}

export class CandidateSet {
    private readonly depth: number;
    private readonly peers = new Map<string, PeerState>();
    private primaryKey: string | null = null;

    constructor(opts: { depth?: number } = {}) {
        this.depth = Math.max(16, opts.depth ?? 2160);
    }

    /** Add a hot peer. The first peer added becomes primary unless a role is forced. */
    addPeer(key: string, role?: PeerRole): PeerRole {
        const existing = this.peers.get(key);
        if (existing) return existing.role;
        const assigned: PeerRole = role ?? (this.primaryKey ? "verifier" : "primary");
        this.peers.set(key, {
            key,
            role: assigned,
            fragment: newFragment(),
            agreedAtSlot: null,
            divergence: null,
            headersSeen: 0,
            pending: new Map(),
        });
        if (assigned === "primary") {
            if (this.primaryKey && this.primaryKey !== key) {
                const prev = this.peers.get(this.primaryKey);
                if (prev) prev.role = "verifier";
            }
            this.primaryKey = key;
        }
        return assigned;
    }

    removePeer(key: string): void {
        this.peers.delete(key);
        if (this.primaryKey === key) this.primaryKey = null;
    }

    hasPeer(key: string): boolean {
        return this.peers.has(key);
    }

    primary(): string | null {
        return this.primaryKey;
    }

    roleOf(key: string): PeerRole | null {
        return this.peers.get(key)?.role ?? null;
    }

    /** Promote `key` to primary; the old primary becomes a verifier. Its fragment is kept. */
    setPrimary(key: string): boolean {
        const p = this.peers.get(key);
        if (!p) return false;
        if (this.primaryKey && this.primaryKey !== key) {
            const prev = this.peers.get(this.primaryKey);
            if (prev) prev.role = "verifier";
        }
        p.role = "primary";
        this.primaryKey = key;
        // Re-evaluate every verifier against the new primary fragment.
        for (const v of this.peers.values()) {
            if (v.role !== "verifier") continue;
            v.agreedAtSlot = null;
            v.divergence = null;
            for (const pt of v.fragment.points) this.compareAgainstPrimary(v, pt);
        }
        return true;
    }

    /**
     * Pick the best replacement primary: an agreeing verifier with the highest
     * agreed slot, else the verifier with the longest fragment, else null.
     */
    bestSuccessor(exclude?: string): string | null {
        let best: PeerState | null = null;
        for (const p of this.peers.values()) {
            if (p.key === exclude || p.role === "primary") continue;
            if (p.divergence) continue;
            if (!best) {
                best = p;
                continue;
            }
            const a = p.agreedAtSlot ?? -1n;
            const b = best.agreedAtSlot ?? -1n;
            if (a > b || (a === b && p.fragment.points.length > best.fragment.points.length)) best = p;
        }
        return best?.key ?? null;
    }

    /**
     * The verifier that agrees with the primary through the primary's current tip and
     * has validated the most headers beyond it, when that lead is at least `minLead`.
     * Header rate is per connection, so such a peer is a faster source of the same chain.
     */
    fasterAgreeingVerifier(minLead: number): { key: string; lead: number; primaryTipSlot: bigint } | null {
        const prim = this.primaryState();
        const primTip = prim?.fragment.points.at(-1);
        if (!prim || !primTip) return null;
        let best: { key: string; lead: number; primaryTipSlot: bigint } | null = null;
        for (const v of this.peers.values()) {
            if (v.role !== "verifier" || v.divergence) continue;
            if (v.agreedAtSlot == null || v.agreedAtSlot < primTip.slot) continue;
            let lead = 0;
            for (let i = v.fragment.points.length - 1; i >= 0 && v.fragment.points[i]!.slot > primTip.slot; i--) lead++;
            if (lead >= minLead && (!best || lead > best.lead)) best = { key: v.key, lead, primaryTipSlot: primTip.slot };
        }
        return best;
    }

    /**
     * Verifier headers beyond the primary tip wait here until the primary reaches
     * them. Bounded like the fragments: past `depth` entries the newest are not
     * recorded (the orchestrator also pauses a verifier's stream well before that),
     * otherwise a body-bound primary let uncapped verifiers grow this without limit.
     */
    private rememberPending(v: PeerState, pt: CandidatePoint): void {
        if (v.pending.size >= this.depth) return;
        v.pending.set(pt.slot.toString(), pt.hash);
    }

    /** Headers of `key` waiting for the primary to reach their slot. */
    pendingCount(key: string): number {
        return this.peers.get(key)?.pending.size ?? 0;
    }

    /** Fragment depth (k): the bound on fragments and on pending verifier headers. */
    get fragmentDepth(): number {
        return this.depth;
    }

    private primaryState(): PeerState | null {
        return this.primaryKey ? this.peers.get(this.primaryKey) ?? null : null;
    }

    private compareAgainstPrimary(v: PeerState, pt: CandidatePoint): ObserveVerdict {
        const prim = this.primaryState();
        if (!prim) return { kind: "unknown-peer" };
        const primaryHashes = prim.fragment.bySlot.get(pt.slot.toString());
        const primTip = prim.fragment.points.at(-1);
        if (primaryHashes) {
            if (primaryHashes.includes(pt.hash)) {
                if (v.agreedAtSlot == null || pt.slot > v.agreedAtSlot) v.agreedAtSlot = pt.slot;
                return { kind: "agree", slot: pt.slot };
            }
            // A Byron epoch-boundary block shares its slot with the epoch's first main
            // block. While the primary's tip is that EBB it may yet deliver the main block,
            // so a mismatch there is only a fork once the primary has moved on. Peers
            // validate concurrently, so a verifier regularly reports the main block first.
            if (primTip && primTip.slot === pt.slot && primTip.ebb) {
                this.rememberPending(v, pt);
                return { kind: "ahead", slot: pt.slot };
            }
            v.divergence = { slot: pt.slot, peerHash: pt.hash, primaryHashes: [...primaryHashes] };
            return { kind: "divergent", slot: pt.slot, peerHash: pt.hash, primaryHashes: [...primaryHashes] };
        }
        const primOldest = prim.fragment.points[0];
        if (!primTip || pt.slot > primTip.slot) {
            this.rememberPending(v, pt);
            return { kind: "ahead", slot: pt.slot };
        }
        if (primOldest && pt.slot < primOldest.slot) return { kind: "behind", slot: pt.slot };
        // Slot inside the primary window but the primary has no block there:
        // the verifier claims a block the primary never saw. That is a fork.
        v.divergence = { slot: pt.slot, peerHash: pt.hash, primaryHashes: [] };
        return { kind: "divergent", slot: pt.slot, peerHash: pt.hash, primaryHashes: [] };
    }

    /** Record a validated header from `key`. */
    observe(key: string, pt: CandidatePoint): ObserveVerdict {
        const p = this.peers.get(key);
        if (!p) return { kind: "unknown-peer" };
        p.headersSeen++;
        const slotKey = pt.slot.toString();
        if (p.fragment.bySlot.get(slotKey)?.includes(pt.hash)) return { kind: "duplicate", slot: pt.slot };
        fragmentPush(p.fragment, pt, this.depth);

        if (p.role === "primary") {
            // Resolve verifiers that were ahead at this slot or at any slot the primary has
            // now passed (a pending second block at an earlier slot is settled either way).
            for (const v of this.peers.values()) {
                if (v.role !== "verifier" || v.pending.size === 0) continue;
                // Snapshot the due entries first: compareAgainstPrimary may re-add an entry
                // (the EBB deferral), and a Map for-of visits entries added during iteration —
                // that was an infinite loop at mainnet slot 0 (EBB + block 1 share the slot).
                const due: Array<[string, string]> = [];
                for (const [k, hash] of v.pending) if (BigInt(k) <= pt.slot) due.push([k, hash]);
                for (const [k, hash] of due) {
                    v.pending.delete(k);
                    this.compareAgainstPrimary(v, { slot: BigInt(k), hash });
                }
            }
            return { kind: "primary-advance", slot: pt.slot };
        }
        return this.compareAgainstPrimary(p, pt);
    }

    /** Verifiers that currently disagree with the primary. */
    divergentPeers(): string[] {
        return [...this.peers.values()].filter((p) => p.role === "verifier" && p.divergence).map((p) => p.key);
    }

    /** Verifiers that have agreed with the primary at some slot and have not diverged. */
    agreeingPeers(): string[] {
        return [...this.peers.values()]
            .filter((p) => p.role === "verifier" && !p.divergence && p.agreedAtSlot != null)
            .map((p) => p.key);
    }

    /**
     * Should the primary be considered the outlier? True when at least
     * `quorum` verifiers diverge from it *and* they agree with each other at
     * the divergence slot (same alternative hash).
     */
    primaryOutvoted(quorum = 2): { outvoted: boolean; slot?: bigint; hash?: string; by?: string[] } {
        const div = [...this.peers.values()].filter((p) => p.role === "verifier" && p.divergence);
        if (div.length < quorum) return { outvoted: false };
        const groups = new Map<string, string[]>();
        for (const p of div) {
            const g = `${p.divergence!.slot}:${p.divergence!.peerHash}`;
            groups.set(g, [...(groups.get(g) ?? []), p.key]);
        }
        for (const [g, keys] of groups) {
            // Quorum counts distinct remote hosts, not connections: one operator
            // answering on several ports (or one relay reached twice) is one vote.
            if (distinctHosts(keys) >= quorum) {
                const [slot, hash] = g.split(":");
                return { outvoted: true, slot: BigInt(slot!), hash, by: keys };
            }
        }
        return { outvoted: false };
    }

    /** Points a verifier holds that a scheduler could fetch from it (agreeing peers only). */
    fragmentOf(key: string): readonly CandidatePoint[] {
        return this.peers.get(key)?.fragment.points ?? [];
    }

    /** Does `key` agree with the primary at or beyond `slot`? (safe to fetch bodies up to `slot` from it) */
    agreesThrough(key: string, slot: bigint): boolean {
        const p = this.peers.get(key);
        if (!p) return false;
        if (p.role === "primary") return true;
        if (p.divergence) return false;
        return p.agreedAtSlot != null && p.agreedAtSlot >= slot;
    }

    agreement(key: string): PeerAgreement | null {
        const p = this.peers.get(key);
        if (!p) return null;
        const tip = p.fragment.points.at(-1) ?? null;
        let status: AgreementStatus = "unknown";
        if (p.role === "verifier") {
            if (p.divergence) status = "divergent";
            else if (p.agreedAtSlot != null) status = "agrees";
            else if (p.pending.size > 0) status = "ahead";
            else if (tip && this.primaryState()?.fragment.points[0] && tip.slot < this.primaryState()!.fragment.points[0]!.slot) status = "behind";
        }
        return {
            key: p.key,
            role: p.role,
            status,
            agreedAtSlot: p.agreedAtSlot,
            divergence: p.divergence,
            tipSlot: tip?.slot ?? null,
            tipHash: tip?.hash ?? null,
            headersSeen: p.headersSeen,
        };
    }

    snapshot(): { primary: string | null; peers: PeerAgreement[] } {
        return {
            primary: this.primaryKey,
            peers: [...this.peers.keys()].map((k) => this.agreement(k)!).filter(Boolean),
        };
    }

    /** Drop all fragments (after a rollback the compared history is void). */
    reset(): void {
        for (const p of this.peers.values()) {
            p.fragment = newFragment();
            p.agreedAtSlot = null;
            p.divergence = null;
            p.pending.clear();
        }
    }
}
