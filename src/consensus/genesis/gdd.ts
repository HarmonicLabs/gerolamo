/**
 * Genesis Density Disconnector and the Limit on Eagerness fragment, ported from
 * ouroboros-consensus 3.0 `Ouroboros.Consensus.Genesis.Governor` (cardano-node 11):
 *
 *   - `sharedCandidatePrefix`: the LoE fragment is the longest common prefix of every candidate
 *     fragment, anchored at the immutable tip (a candidate that does not intersect the selection
 *     counts as empty at the immutable tip);
 *   - `densityDisconnect`: in the Genesis window of `sgen` slots after the LoE tip, a peer whose
 *     chain is known to be no denser than another peer's (disagreeing) chain is disconnected. The
 *     honest chain is the densest in any window (Ouroboros Genesis), so an adversary that offers a
 *     longer-looking but sparser fork, or stalls, loses the comparison.
 *
 * Pure functions over plain header lists; the orchestrator's GenesisDriver runs them at most once
 * per `gddRateLimitMs` while the GSM is Syncing.
 */
import type { ChainHeader, Point } from "../chainsel/ChainSel";

export interface GddPeerState {
    /** Slot of the newest header the peer sent (`csLatestSlot`); null = sent nothing yet (skipped: timeouts handle it). */
    latestSlot: bigint | null;
    /** The peer said MsgAwaitReply: it has no more headers for now (`csIdling`). */
    idling: boolean;
}

export interface DensityBounds {
    clippedLength: number;
    /** Last point of the clipped fragment (its anchor — the LoE tip — when empty). */
    clippedTip: string;
    offersMoreThanK: boolean;
    lowerBound: bigint;
    upperBound: bigint;
    hasBlockAfter: boolean;
    latestSlot: bigint;
    idling: boolean;
}

/**
 * `sharedCandidatePrefix`: candidates are header lists after the immutable tip (null = no
 * intersection → empty). Returns the LoE fragment (common prefix) and every candidate's suffix after it.
 */
export function sharedCandidatePrefix(candidates: Map<string, readonly ChainHeader[] | null>): { loe: ChainHeader[]; suffixes: Map<string, ChainHeader[]> } {
    const lists = [...candidates.values()].map((c) => c ?? []);
    let n = 0;
    if (lists.length) {
        const min = Math.min(...lists.map((l) => l.length));
        outer: for (; n < min; n++) {
            const h = lists[0]![n]!.hash;
            for (const l of lists) if (l[n]!.hash !== h) break outer;
        }
    }
    const loe = lists.length ? lists[0]!.slice(0, n) : [];
    const suffixes = new Map<string, ChainHeader[]>();
    for (const [peer, c] of candidates) suffixes.set(peer, (c ?? []).slice(n));
    return { loe, suffixes };
}

/**
 * `densityDisconnect sgen k states candidateSuffixes loeFrag`: the peers known to lose the density
 * comparison against some other peer in the Genesis window after the LoE tip.
 * `loeTip` is the head of the LoE fragment (the immutable tip when the fragment is empty;
 * `slot: null` = Origin).
 */
export function densityDisconnect(
    sgen: bigint,
    k: number,
    states: Map<string, GddPeerState>,
    suffixes: Map<string, readonly ChainHeader[]>,
    loeTip: { hash: string; slot: bigint | null },
): { losing: string[]; bounds: Map<string, DensityBounds> } {
    const firstSlotAfterWindow = (loeTip.slot == null ? 0n : loeTip.slot + 1n) + sgen;
    const bounds = new Map<string, DensityBounds>();
    for (const [peer, suffix] of suffixes) {
        const st = states.get(peer);
        if (!st || st.latestSlot == null) continue; // skip peers that have not sent any header yet
        const clipped = suffix.filter((h) => h.slot < firstSlotAfterWindow); // splitAtSlot: headers before the first slot after the window
        const suffixHeadSlot = suffix.length ? suffix[suffix.length - 1]!.slot : loeTip.slot;
        const maxSeen = suffixHeadSlot == null ? st.latestSlot : (suffixHeadSlot > st.latestSlot ? suffixHeadSlot : st.latestSlot);
        const hasBlockAfter = maxSeen >= firstSlotAfterWindow;
        const clippedHeadSlot = clipped.length ? clipped[clipped.length - 1]!.slot : loeTip.slot;
        const unknownTrailingSlots = firstSlotAfterWindow - (clippedHeadSlot == null ? 0n : clippedHeadSlot + 1n);
        const potentialSlots = hasBlockAfter ? 0n : unknownTrailingSlots;
        const lowerBound = BigInt(clipped.length);
        bounds.set(peer, {
            clippedLength: clipped.length,
            clippedTip: clipped.length ? clipped[clipped.length - 1]!.hash : loeTip.hash,
            offersMoreThanK: suffix.length > k,
            lowerBound,
            upperBound: lowerBound + potentialSlots,
            hasBlockAfter,
            latestSlot: st.latestSlot,
            idling: st.idling,
        });
    }
    const losing: string[] = [];
    for (const [peer0, b0] of bounds) {
        for (const [, b1] of bounds) {
            // Note [Chain disagreement]: not before peer0 sent a header after the intersection or idles
            if (!(b0.idling || b0.clippedLength > 0 || b0.hasBlockAfter)) continue;
            if (b0.clippedTip === b1.clippedTip) continue; // the two fragments share their last header after the LoE
            if (!(b1.offersMoreThanK || b0.lowerBound === b0.upperBound)) continue;
            if (!(b1.lowerBound >= (b0.idling ? b0.lowerBound : b0.upperBound))) continue;
            losing.push(peer0);
            break;
        }
    }
    return { losing, bounds };
}

/**
 * The Genesis window of the era the first slot after the LoE tip lies in (`slotToGenesisWindow`):
 * Byron 2k, Shelley-based eras 3k/f slots (sgGenesisWindow = the stability window).
 */
export function genesisWindowFor(isByronSlot: boolean, k: number, activeSlotsCoeff: number): bigint {
    return isByronSlot ? BigInt(2 * k) : BigInt(Math.ceil((3 * k) / activeSlotsCoeff));
}

export type LoePoint = Point;
