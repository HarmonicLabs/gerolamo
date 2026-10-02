/**
 * Praos chain selection with ouroboros-consensus semantics (cardano-node 11, consensus 3.0):
 *
 *   - every upstream peer has a *candidate fragment* (the headers its ChainSync delivered,
 *     validated), anchored at a point of our current chain;
 *   - our *current chain* is the selected chain: an anchor (the immutable tip, k blocks back) and
 *     at most k volatile headers after it;
 *   - a candidate is eligible when it forks off our chain no more than k blocks back
 *     (`forksAtMostKBlocks`; a peer whose fork is deeper is `ForkTooDeep` and is disconnected by
 *     the ChainSync client), contains no block known to be invalid (the ChainSync
 *     `invalidBlockRejector` disconnects such a peer), and, with the Limit on Eagerness, is
 *     trimmed to extend the LoE tip by at most k blocks (`ChainSel.trimToLoE`);
 *   - an eligible candidate is *preferable* when `preferAnchoredCandidate` says switch: longer
 *     (block number of the tip), or equally long and the Praos tie-break prefers its tip
 *     (`comparePraos`, restricted VRF from Conway on — tieBreak.ts);
 *   - among preferable candidates the best one by `compareAnchoredFragments` (block number, then the
 *     *unrestricted* Praos `Ord`) is selected.
 *
 * Pure data structure: no I/O, no timers. The orchestrator feeds validated headers and applied /
 * rolled-back blocks, and acts on `select()`. Block numbers are derived from the parent (+1, +0 for
 * a Byron EBB), never trusted from a peer: chain length is what selection compares.
 */
import { comparePraos, comparePraosOrd, tieBreakInfoOf, vrfFlavorForEra, type PraosSwitchReason, type TieBreakInfo } from "../tieBreak";

export interface Point { hash: string; slot: bigint; blockNo: bigint }

export interface ChainHeader extends Point {
    prevHash: string | null;
    /** Hard-fork-combinator era index (Byron 0 … Conway 6). */
    hfcEra: number;
    isEbb?: boolean;
    /** Tie-break view; computed from `raw` on first use when absent. */
    tb?: TieBreakInfo | null;
    raw?: Uint8Array;
}

/** A header as it arrives from ChainSync (block number not yet derived). */
export type IncomingHeader = Omit<ChainHeader, "blockNo">;

export type SwitchReason = { kind: "longer"; ours: bigint; cand: bigint } | { kind: "tiebreak"; detail: PraosSwitchReason };

export interface Candidate {
    peer: string;
    /** Last point shared with our chain. */
    intersection: Point;
    /** Our blocks after the intersection that the switch rolls back. */
    rollback: number;
    /** The candidate's headers after the intersection (possibly LoE-trimmed). */
    suffix: ChainHeader[];
    tip: Point;
    reason: SwitchReason;
}

export type PeerStatus =
    | { kind: "no-candidate" } // nothing past the intersection, or the peer's tip is on our chain
    | { kind: "detached" } // headers that chain onto nothing we know (stale stream; ChainSync will re-intersect)
    | { kind: "fork-too-deep"; anchorSlot: bigint }
    | { kind: "invalid"; hash: string; reason: string }
    | { kind: "not-preferable"; tip: Point }
    | { kind: "preferable"; candidate: Candidate };

export interface SelectResult {
    best: Candidate | null;
    status: Map<string, PeerStatus>;
    /** Peers to disconnect: fork deeper than k, or a candidate containing a known-invalid block. */
    punish: Array<{ peer: string; why: string }>;
}

interface PeerFragment {
    /** Point on our chain the headers extend (null: detached). */
    anchor: Point | null;
    headers: ChainHeader[];
    /** Slot of the newest header received (GDD `csLatestSlot`), even when not on the fragment. */
    latestSlot: bigint | null;
}

export class ChainSel {
    readonly k: number;
    private ourAnchor: ChainHeader;
    private ours: ChainHeader[] = [];
    private readonly ourIndex = new Map<string, number>(); // hash → index in `ours`, -1 = anchor
    private readonly peers = new Map<string, PeerFragment>();
    private readonly invalid = new Map<string, string>();
    private static readonly INVALID_CAP = 4096;
    static FRAGMENT_CAP = 100_000;

    /**
     * Finds blocks of our chain older than the immutable tip (the DB): a fragment anchored there is a
     * fork deeper than k, not a stale stream. Optional; without it such fragments read "detached".
     */
    private readonly resolveOld: ((hash: string) => Point | null) | null;

    constructor(opts: { k: number; anchor: Point & { hfcEra?: number }; resolveOld?: (hash: string) => Point | null }) {
        this.k = Math.max(1, opts.k);
        this.resolveOld = opts.resolveOld ?? null;
        this.ourAnchor = { ...opts.anchor, prevHash: null, hfcEra: opts.anchor.hfcEra ?? 6 };
        this.ourIndex.set(this.ourAnchor.hash, -1);
    }

    // ───────────────────────────── our chain ─────────────────────────────

    /** Reset our chain to `anchor` followed by `headers` (oldest first, each extending the previous). */
    resetOurChain(anchor: Point & { hfcEra?: number }, headers: IncomingHeader[] = []): void {
        this.ourAnchor = { ...anchor, prevHash: null, hfcEra: anchor.hfcEra ?? 6 };
        this.ours = [];
        this.ourIndex.clear();
        this.ourIndex.set(this.ourAnchor.hash, -1);
        for (const h of headers) this.extendOurs(h);
    }

    ourTip(): ChainHeader { return this.ours.length ? this.ours[this.ours.length - 1]! : this.ourAnchor; }
    immutableTip(): ChainHeader { return this.ourAnchor; }
    ourChain(): readonly ChainHeader[] { return this.ours; }
    onOurChain(hash: string): boolean { return this.ourIndex.has(hash.toLowerCase()); }
    /** Our header by hash (anchor included). */
    ourHeader(hash: string): ChainHeader | null {
        const i = this.ourIndex.get(hash.toLowerCase());
        return i === undefined ? null : i < 0 ? this.ourAnchor : this.ours[i]!;
    }

    /** A block was applied on top of our tip. */
    extendOurs(h: IncomingHeader): ChainHeader {
        const hash = h.hash.toLowerCase();
        const tip = this.ourTip();
        if (h.prevHash && h.prevHash.toLowerCase() !== tip.hash) throw new Error(`extendOurs: ${hash.slice(0, 12)}… does not extend our tip ${tip.hash.slice(0, 12)}…`);
        const full: ChainHeader = { ...h, hash, prevHash: h.prevHash?.toLowerCase() ?? tip.hash, blockNo: tip.blockNo + (h.isEbb ? 0n : 1n) };
        this.ours.push(full);
        this.ourIndex.set(hash, this.ours.length - 1);
        // the immutable tip follows k blocks behind the selection
        while (this.ours.length > this.k) {
            const old = this.ours.shift()!;
            this.ourIndex.delete(this.ourAnchor.hash);
            this.ourAnchor = old;
            this.reindex();
        }
        return full;
    }

    /**
     * Our chain rolled back to `hash` (on our chain). Peers anchored on the removed blocks keep them:
     * their fragments now start at the new tip with our removed blocks in front (the peer still
     * serves them — it is the chain we just left).
     */
    rollbackOursTo(hash: string): ChainHeader[] {
        const h = hash.toLowerCase();
        const i = this.ourIndex.get(h);
        if (i === undefined) throw new Error(`rollbackOursTo: ${h.slice(0, 12)}… is not on our chain (deeper than k?)`);
        const removed = this.ours.splice(i + 1);
        for (const r of removed) this.ourIndex.delete(r.hash);
        if (removed.length) {
            const pos = new Map(removed.map((r, j) => [r.hash, j]));
            const newTip = this.ourTip();
            for (const f of this.peers.values()) {
                const j = f.anchor ? pos.get(f.anchor.hash) : undefined;
                if (j === undefined) continue;
                f.headers = [...removed.slice(0, j + 1), ...f.headers];
                f.anchor = pointOf(newTip);
            }
        }
        return removed;
    }

    private reindex(): void {
        this.ourIndex.clear();
        this.ourIndex.set(this.ourAnchor.hash, -1);
        this.ours.forEach((x, j) => this.ourIndex.set(x.hash, j));
    }

    // ───────────────────────────── peers ─────────────────────────────

    addPeer(peer: string, at?: Point): void {
        if (this.peers.has(peer)) return;
        const a = at ? this.ourHeader(at.hash) ?? this.resolveOld?.(at.hash.toLowerCase()) ?? null : this.ourTip();
        this.peers.set(peer, { anchor: a ? pointOf(a) : null, headers: [], latestSlot: null });
    }

    removePeer(peer: string): void { this.peers.delete(peer); }
    hasPeer(peer: string): boolean { return this.peers.has(peer); }
    peerKeys(): string[] { return [...this.peers.keys()]; }

    /** Latest header slot a peer announced (GDD needs it even for headers not yet on the fragment). */
    noteLatestSlot(peer: string, slot: bigint): void {
        const f = this.peers.get(peer);
        if (f && (f.latestSlot == null || slot > f.latestSlot)) f.latestSlot = slot;
    }

    /** A validated header from `peer`'s ChainSync (RollForward). */
    rollForward(peer: string, h: IncomingHeader): void {
        let f = this.peers.get(peer);
        if (!f) { this.addPeer(peer); f = this.peers.get(peer)!; }
        const hash = h.hash.toLowerCase(), prev = h.prevHash?.toLowerCase() ?? null;
        this.noteLatestSlot(peer, h.slot);
        let parent: Point | null = null;
        const last = f.headers[f.headers.length - 1];
        if (last && prev === last.hash) parent = last;
        else if (!last && f.anchor && prev === f.anchor.hash) parent = f.anchor;
        else {
            // not the fragment's tip: an implicit rollback inside the fragment, a stream that
            // re-intersected on our chain, or a header we cannot place
            const j = prev ? f.headers.findIndex((x) => x.hash === prev) : -1;
            if (j >= 0) { f.headers.length = j + 1; parent = f.headers[j]!; }
            else {
                const ourParent = prev ? this.ourHeader(prev) ?? this.resolveOld?.(prev) ?? null : null;
                if (ourParent) { f.anchor = pointOf(ourParent); f.headers = []; parent = f.anchor; }
                else { f.anchor = null; f.headers = []; return; } // detached until the stream re-intersects
            }
        }
        if (f.headers.some((x) => x.hash === hash)) return; // duplicate
        f.headers.push({ ...h, hash, prevHash: prev ?? parent.hash, blockNo: parent.blockNo + (h.isEbb ? 0n : 1n) });
        // Memory is bounded by the orchestrator's back-pressure (header lookahead, paused verifiers)
        // and by normalize() dropping what we applied. This cap is only an emergency brake: the
        // fragment is cut at its oldest end and detached, so it cannot be selected any more.
        if (f.headers.length > ChainSel.FRAGMENT_CAP) { this.normalize(f); if (f.headers.length > ChainSel.FRAGMENT_CAP) { f.headers.splice(0, f.headers.length - ChainSel.FRAGMENT_CAP); f.anchor = null; } }
    }

    /** `peer`'s ChainSync rolled back to `point` (RollBackward). */
    rollBackward(peer: string, point: { hash: string | null; slot: bigint }): void {
        const f = this.peers.get(peer);
        if (!f) return;
        const h = point.hash?.toLowerCase() ?? null;
        if (h) {
            const j = f.headers.findIndex((x) => x.hash === h);
            if (j >= 0) { f.headers.length = j + 1; return; }
            if (f.anchor?.hash === h) { f.headers = []; return; }
            const ours = this.ourHeader(h);
            if (ours) { f.anchor = pointOf(ours); f.headers = []; return; }
        }
        // a point we do not know (older than our window, or genesis): nothing usable until the
        // stream continues from a known block
        f.anchor = null;
        f.headers = [];
    }

    /** Move the fragment's anchor over headers that are on our chain (they are the common prefix). */
    private normalize(f: PeerFragment): void {
        if (!f.anchor && f.headers.length) {
            const first = f.headers[0]!;
            const p = first.prevHash ? this.ourHeader(first.prevHash) : null;
            if (p) f.anchor = pointOf(p);
        }
        if (f.anchor && !this.ourIndex.has(f.anchor.hash)) {
            // our chain moved on (its anchor advanced past it) or rolled back past it without the
            // re-anchoring in rollbackOursTo: find the newest header that is on our chain
            let j = f.headers.length - 1;
            while (j >= 0 && !this.ourIndex.has(f.headers[j]!.hash)) j--;
            if (j >= 0) { f.anchor = pointOf(f.headers[j]!); f.headers.splice(0, j + 1); }
            else return; // stays off our window: judged in select()
        }
        let n = 0;
        while (n < f.headers.length && this.ourIndex.has(f.headers[n]!.hash)) n++;
        if (n) { f.anchor = pointOf(f.headers[n - 1]!); f.headers.splice(0, n); }
    }

    /** The peer's candidate as full headers after `anchor` (read-only view for tests and GDD). */
    fragmentOf(peer: string): { anchor: Point | null; headers: readonly ChainHeader[]; latestSlot: bigint | null } | null {
        const f = this.peers.get(peer);
        if (!f) return null;
        this.normalize(f);
        return { anchor: f.anchor, headers: f.headers, latestSlot: f.latestSlot };
    }

    /**
     * The peer's candidate as headers after our immutable tip (our chain up to the fragment's
     * anchor, then the fragment): the fragments GDD and the LoE work on. null when the fragment is
     * detached or anchored before the immutable tip (GDD then treats it as empty at the immutable
     * tip: Note [CSJ truncates the candidate fragments]).
     */
    candidateFromImmutable(peer: string): ChainHeader[] | null {
        const f = this.peers.get(peer);
        if (!f) return null;
        this.normalize(f);
        if (!f.anchor) return null;
        const ia = this.ourIndex.get(f.anchor.hash);
        if (ia === undefined) return null;
        return [...this.ours.slice(0, ia + 1), ...f.headers];
    }

    // ───────────────────────────── invalid blocks ─────────────────────────────

    /** Remember an invalid block (never selected again); returns the peers whose candidates contain it. */
    markInvalid(hash: string, reason: string): string[] {
        const h = hash.toLowerCase();
        if (!this.invalid.has(h)) {
            this.invalid.set(h, reason);
            if (this.invalid.size > ChainSel.INVALID_CAP) this.invalid.delete(this.invalid.keys().next().value!);
        }
        const out: string[] = [];
        for (const [peer, f] of this.peers) if (f.headers.some((x) => x.hash === h)) out.push(peer);
        return out;
    }
    isInvalid(hash: string): string | null { return this.invalid.get(hash.toLowerCase()) ?? null; }

    // ───────────────────────────── selection ─────────────────────────────

    /**
     * Decide. `loe`: the Limit on Eagerness tip (a point on some candidate / our chain) when Genesis
     * is syncing, `null` when the LoE is disabled (Praos mode, or Genesis CaughtUp).
     * `prefer`: peer to favour among equally good candidates (the current primary: least churn).
     */
    select(opts: { loe?: Point | null; prefer?: string | null } = {}): SelectResult {
        const status = new Map<string, PeerStatus>();
        const punish: SelectResult["punish"] = [];
        const ourTip = this.ourTip();
        const preferable: Candidate[] = [];
        for (const [peer, f] of this.peers) {
            this.normalize(f);
            if (!f.anchor) { status.set(peer, f.headers.length ? { kind: "detached" } : { kind: "no-candidate" }); continue; }
            const ia = this.ourIndex.get(f.anchor.hash);
            if (ia === undefined) {
                // anchored before our immutable tip: harmless if the whole fragment is our old chain
                // (a lagging peer re-streaming), a fork deeper than k otherwise (normalize() would have
                // re-anchored a fragment that reached our window)
                const tip = f.headers[f.headers.length - 1];
                const lagging = !tip || (this.resolveOld ? this.resolveOld(tip.hash) !== null : tip.slot <= this.ourAnchor.slot);
                if (!lagging) {
                    status.set(peer, { kind: "fork-too-deep", anchorSlot: f.anchor.slot });
                    punish.push({ peer, why: `fork too deep: intersection at slot ${f.anchor.slot} is before our immutable tip (slot ${this.ourAnchor.slot}, k=${this.k})` });
                } else status.set(peer, { kind: "no-candidate" });
                continue;
            }
            let suffix: ChainHeader[] = f.headers;
            const bad = suffix.findIndex((x) => this.invalid.has(x.hash));
            if (bad >= 0) {
                const b = suffix[bad]!;
                status.set(peer, { kind: "invalid", hash: b.hash, reason: this.invalid.get(b.hash)! });
                punish.push({ peer, why: `candidate contains invalid block ${b.hash.slice(0, 12)}…@${b.slot}: ${this.invalid.get(b.hash)}` });
                continue;
            }
            const rollback = ia < 0 ? this.ours.length : this.ours.length - 1 - ia;
            if (rollback > this.k) { // cannot happen with ≤ k volatile headers, kept for clarity
                status.set(peer, { kind: "fork-too-deep", anchorSlot: f.anchor.slot });
                punish.push({ peer, why: `fork too deep: ${rollback} blocks > k=${this.k}` });
                continue;
            }
            if (opts.loe !== undefined && opts.loe !== null) suffix = this.trimToLoE(f.anchor, suffix, opts.loe);
            const cTip = suffix.length ? suffix[suffix.length - 1]! : null;
            if (!cTip) { status.set(peer, { kind: "no-candidate" }); continue; }
            const r = this.preferCandidate(ourTip, cTip);
            if (!r) { status.set(peer, { kind: "not-preferable", tip: pointOf(cTip) }); continue; }
            const cand: Candidate = { peer, intersection: f.anchor, rollback, suffix, tip: pointOf(cTip), reason: r };
            status.set(peer, { kind: "preferable", candidate: cand });
            preferable.push(cand);
        }
        let best: Candidate | null = null;
        for (const c of preferable) {
            if (!best) { best = c; continue; }
            const o = this.compareTips(c.suffix[c.suffix.length - 1]!, best.suffix[best.suffix.length - 1]!);
            if (o > 0 || (o === 0 && (c.peer === opts.prefer || (best.peer !== opts.prefer && c.rollback < best.rollback)))) best = c;
        }
        return { best, status, punish };
    }

    /** `preferAnchoredCandidate` for two non-empty fragments intersecting at our chain: the reason to switch, or null. */
    preferCandidate(ours: ChainHeader, cand: ChainHeader): SwitchReason | null {
        if (cand.hash === ours.hash) return null;
        if (cand.blockNo > ours.blockNo) return { kind: "longer", ours: ours.blockNo, cand: cand.blockNo };
        if (cand.blockNo < ours.blockNo) return null;
        // equal length: the tie-breaker of the later era (none if either tip is Byron)
        if (ours.hfcEra <= 0 || cand.hfcEra <= 0) return null;
        const flavor = vrfFlavorForEra(Math.max(ours.hfcEra, cand.hfcEra));
        const a = tbOf(ours), b = tbOf(cand);
        if (!flavor || !a || !b) return null;
        const r = comparePraos(flavor, a, b);
        return r.switch ? { kind: "tiebreak", detail: r.reason } : null;
    }

    /** `compareAnchoredFragments` on two tips (block number, then the unrestricted Praos `Ord`). */
    compareTips(a: ChainHeader, b: ChainHeader): -1 | 0 | 1 {
        if (a.blockNo !== b.blockNo) return a.blockNo > b.blockNo ? 1 : -1;
        if (a.hfcEra <= 0 || b.hfcEra <= 0) return 0;
        const ta = tbOf(a), tb = tbOf(b);
        if (!ta || !tb) return 0;
        return comparePraosOrd(ta, tb);
    }

    /**
     * `trimToLoE`: the candidate (our chain up to `anchor`, then `suffix`) cut so that, if it contains
     * the LoE tip, it extends it by at most k blocks; if it does not, it is cut at its intersection
     * with the LoE fragment (the candidate prefix shared with the LoE chain).
     */
    private trimToLoE(anchor: Point, suffix: ChainHeader[], loe: Point): ChainHeader[] {
        // LoE tip on our chain at or below the anchor: the whole suffix is "after the LoE tip"
        const loeOurs = this.ourIndex.get(loe.hash.toLowerCase());
        const anchorIdx = this.ourIndex.get(anchor.hash)!;
        if (loeOurs !== undefined && loeOurs <= anchorIdx) {
            const after = anchorIdx - loeOurs; // our blocks between the LoE tip and the anchor count too
            return suffix.slice(0, Math.max(0, this.k - after));
        }
        if (loeOurs !== undefined) return []; // LoE tip is on our chain beyond the fork point: the candidate diverges before it
        const j = suffix.findIndex((x) => x.hash === loe.hash.toLowerCase());
        if (j >= 0) return suffix.slice(0, j + 1 + this.k);
        // the candidate does not contain the LoE tip: keep only what the LoE fragment shares. The
        // LoE fragment is the common prefix of all candidates, so it runs through this candidate
        // up to the LoE tip when the tip is in it; otherwise the LoE tip lies on another branch
        // and the shared part ends at or before our anchor.
        return [];
    }
}

export function pointOf(h: Point): Point { return { hash: h.hash, slot: h.slot, blockNo: h.blockNo }; }

const tbCache = new WeakMap<ChainHeader, TieBreakInfo | null>();
export function tbOf(h: ChainHeader): TieBreakInfo | null {
    if (h.tb !== undefined) return h.tb ? { ...h.tb, slot: h.tb.slot ?? h.slot } : null;
    if (tbCache.has(h)) return tbCache.get(h)!;
    const t = h.raw ? tieBreakInfoOf(h.raw) : null;
    const v = t ? { ...t, slot: h.slot } : null;
    tbCache.set(h, v);
    return v;
}
