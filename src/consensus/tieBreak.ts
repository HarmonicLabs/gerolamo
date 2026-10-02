/**
 * Praos chain-selection tie-break for two chains of equal length, exactly as ouroboros-consensus
 * 3.0 (`Ouroboros.Consensus.Protocol.Praos.Common.comparePraos`, cardano-node 11):
 *   - both tips in the SAME slot by the same issuer (cold key) → the higher operational-certificate
 *     issue number wins (the operator rotated keys and re-forged);
 *   - otherwise, when the VRF comparison is armed → the lower VRF output wins (Praos: the header's
 *     single VRF result; TPraos: the leader VRF), compared as unsigned big-endian bytes;
 *   - the VRF comparison is armed always for `UnrestrictedVRFTiebreaker` (Shelley … Babbage), and
 *     for `RestrictedVRFTiebreaker 5` (Conway on, `Shelley.Ledger.Config.mkShelleyBlockConfig`)
 *     only when the two tips' slots are at most 5 apart: two blocks further apart are not a
 *     propagation race, and preferring the lower VRF there would let a late block displace an
 *     earlier one the network already built on;
 *   - no preference → the node keeps its own chain (`ShouldNotSwitch EQ`).
 * Across eras the later era's flavour applies (`HardFork.Combinator.Protocol.ChainSel`,
 * `SameTiebreakerAcrossEras`); a Byron tip has no Praos tie-breaker (`NoTiebreakerAcrossEras`).
 *
 * Every honest node applies the same rule, so following it is how a node lands on the block the
 * network keeps (2026-09-26 13:36 UTC, preview slot 123 773 790: two blocks in one slot, the vote
 * count split 2–2, our node switched twice and ended on the losing block for 8 minutes).
 */
import { Cbor, CborArray, CborBytes, CborUInt } from "@harmoniclabs/cbor";

export interface TieBreakInfo {
    issuer: string;
    opcertCounter: bigint;
    vrfOutput: Uint8Array;
    /** Slot of the tip (the same-issuer rule and the restricted VRF rule need it); absent in old callers. */
    slot?: bigint;
    /** Block number of the tip (chain length). */
    blockNo?: bigint;
}

/** `UnrestrictedVRFTiebreaker` or `RestrictedVRFTiebreaker maxDist`. */
export type VrfTiebreakerFlavor = { restricted: false } | { restricted: true; maxDist: bigint };
export const UNRESTRICTED_VRF: VrfTiebreakerFlavor = { restricted: false };
/** Conway on: 5 slots, "the usual value we consider when talking about the maximum propagation delay". */
export const CONWAY_RESTRICTED_VRF: VrfTiebreakerFlavor = { restricted: true, maxDist: 5n };

/** HFC era index (Byron 0 … Babbage 5, Conway 6, Dijkstra 7) → flavour; null for Byron (no tie-break). */
export function vrfFlavorForEra(hfcEra: number): VrfTiebreakerFlavor | null {
    if (hfcEra <= 0) return null;
    return hfcEra >= 6 ? CONWAY_RESTRICTED_VRF : UNRESTRICTED_VRF;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** From a Shelley+ header's raw bytes (`[header_body, kes_signature]`); null for Byron or unknown shapes. */
export function tieBreakInfoOf(rawHeader: Uint8Array): TieBreakInfo | null {
    try {
        const h = Cbor.parse(rawHeader);
        if (!(h instanceof CborArray) || h.array.length !== 2) return null;
        const body = h.array[0];
        if (!(body instanceof CborArray)) return null;
        const a = body.array;
        const issuer = a[3];
        if (!(issuer instanceof CborBytes)) return null;
        const blockNo = a[0] instanceof CborUInt ? a[0].num : undefined;
        const slot = a[1] instanceof CborUInt ? a[1].num : undefined;
        if (a.length === 10) { // Praos (Babbage, Conway): [..., vrf_result [output, proof], size, body_hash, opcert [hot, seq, period, sig], pv]
            const vrf = a[5], oc = a[8];
            if (!(vrf instanceof CborArray) || !(vrf.array[0] instanceof CborBytes) || !(oc instanceof CborArray) || !(oc.array[1] instanceof CborUInt)) return null;
            return { issuer: toHex(issuer.bytes), opcertCounter: oc.array[1].num, vrfOutput: vrf.array[0].bytes, slot, blockNo };
        }
        if (a.length === 15) { // TPraos (Shelley … Alonzo): [..., nonce_vrf, leader_vrf, size, body_hash, hot, seq, period, sig, major, minor]
            const leader = a[6], seq = a[10];
            if (!(leader instanceof CborArray) || !(leader.array[0] instanceof CborBytes) || !(seq instanceof CborUInt)) return null;
            return { issuer: toHex(issuer.bytes), opcertCounter: seq.num, vrfOutput: leader.array[0].bytes, slot, blockNo };
        }
        return null;
    } catch {
        return null;
    }
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length - b.length;
}

export type PraosSwitchReason = { kind: "higher-ocert"; ours: bigint; cand: bigint } | { kind: "vrf"; ours: Uint8Array; cand: Uint8Array };
/** `ShouldSwitch reason` or `ShouldNotSwitch ord` (ord of ours against cand: 1 = ours better, 0 = no preference). */
export type ShouldSwitch = { switch: true; reason: PraosSwitchReason } | { switch: false; ord: 0 | 1 };

/** `comparePraos flavor ours cand`: switch when `cand` is strictly preferred. */
export function comparePraos(flavor: VrfTiebreakerFlavor, ours: TieBreakInfo, cand: TieBreakInfo): ShouldSwitch {
    // issueNoArmed: identical slots and issuers (a missing slot counts as equal: the same-slot callers)
    const sameSlot = ours.slot === undefined || cand.slot === undefined || ours.slot === cand.slot;
    const issueNoArmed = sameSlot && ours.issuer === cand.issuer;
    let vrfArmed = true;
    if (flavor.restricted && ours.slot !== undefined && cand.slot !== undefined) {
        const d = ours.slot >= cand.slot ? ours.slot - cand.slot : cand.slot - ours.slot;
        vrfArmed = d <= flavor.maxDist;
    }
    if (issueNoArmed && ours.opcertCounter !== cand.opcertCounter) {
        return ours.opcertCounter < cand.opcertCounter
            ? { switch: true, reason: { kind: "higher-ocert", ours: ours.opcertCounter, cand: cand.opcertCounter } }
            : { switch: false, ord: 1 };
    }
    if (!vrfArmed) return { switch: false, ord: 0 };
    const c = compareBytes(ours.vrfOutput, cand.vrfOutput); // `Down`: the lower VRF output is the better chain
    if (c > 0) return { switch: true, reason: { kind: "vrf", ours: ours.vrfOutput, cand: cand.vrfOutput } };
    return { switch: false, ord: c < 0 ? 1 : 0 };
}

/** The `Ord` instance of `PraosTiebreakerView` (always unrestricted): how ChainSel ranks preferable candidates. -1 = a worse. */
export function comparePraosOrd(a: TieBreakInfo, b: TieBreakInfo): -1 | 0 | 1 {
    const r = comparePraos(UNRESTRICTED_VRF, a, b);
    return r.switch ? -1 : r.ord;
}

/**
 * Which of two equal-length chains' tip blocks Praos prefers: "a", "b", or "equal" (no preference —
 * the node keeps the chain it has). `a` plays "ours". Without a flavour the unrestricted rule
 * applies (pre-Conway; for two tips in one slot both flavours agree).
 */
export function preferByTieBreak(a: TieBreakInfo, b: TieBreakInfo, flavor: VrfTiebreakerFlavor = UNRESTRICTED_VRF): "a" | "b" | "equal" {
    const r = comparePraos(flavor, a, b);
    if (r.switch) return "b";
    return r.ord > 0 ? "a" : "equal";
}
