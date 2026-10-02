/**
 * Hard-fork combinator history, computed the way ouroboros-consensus 3.0 does it (cardano-node 11):
 * `HardFork.History.{EraParams,Summary}` and `HardFork.Combinator.State.Infra.reconstructSummary`.
 *
 *   - era parameters come from the genesis files: Byron epoch = 10k slots of `slotDuration`, safe
 *     zone and Genesis window 2k; Shelley-based eras use the Shelley genesis epoch length and slot
 *     length, safe zone and Genesis window = the stability window ⌈3k/f⌉;
 *   - past eras end where the next one started (the start epochs come from the ledger: see
 *     HardForkHistory);
 *   - the current era ends at the transition epoch when it is known (`TransitionKnown`: a
 *     `Test*HardForkAtEpoch` override, or the next era's protocol version adopted for the next
 *     epoch with k blocks past the voting deadline), otherwise at the safe zone:
 *     the first epoch boundary at or after `ledgerTip + 1 + safeZone` (`TransitionUnknown`);
 *   - when the transition is known, the next era's summary follows, ending at the safe zone from
 *     its own start.
 *
 * `encodeInterpreter` writes the summary exactly like the consensus `Serialise (Summary xs)`
 * instance (GetInterpreter): an indefinite list of `[start, end|null, params]`, bound =
 * `[relativeTime picoseconds, slot, epoch]`, params = `[epochSize, slotLength ms,
 * [0, safeFromTip, [0]], genesisWindow]` (no Peras on any public network).
 */
import { CborArray, CborBytes, CborSimple, CborUInt, type CborObj } from "@harmoniclabs/cbor";

export const HFC_ERAS = ["Byron", "Shelley", "Allegra", "Mary", "Alonzo", "Babbage", "Conway", "Dijkstra"] as const;
/** Index of the last era cardano-node 11 can reach in this execution (Conway: its successor is `TriggerHardForkNotDuringThisExecution`). */
export const LAST_REACHABLE_ERA = 6;
/** `eraProtVerLow` of each era: the major version that triggers the hard fork INTO it (index 0 unused). */
export const ERA_TRIGGER_MAJOR = [0, 2, 3, 4, 5, 7, 9, 12] as const;

export interface EraParams {
    epochSize: bigint;
    slotLengthMs: bigint;
    /** null = `UnsafeIndefiniteSafeZone`. */
    safeZone: bigint | null;
    genesisWindow: bigint;
}

export interface Bound { timePicos: bigint; slot: bigint; epoch: bigint }
export interface EraSummary { start: Bound; end: Bound | null; params: EraParams }

export const INIT_BOUND: Bound = { timePicos: 0n, slot: 0n, epoch: 0n };

/** An exact fraction for a decimal genesis value (`activeSlotsCoeff`, e.g. 0.05). */
function ratio(x: number): { num: bigint; den: bigint } {
    const s = x.toString();
    if (/e/i.test(s)) { const den = 10n ** 18n; return { num: BigInt(Math.round(x * 1e18)), den }; }
    const [i = "0", f = ""] = s.split(".");
    const den = 10n ** BigInt(f.length);
    return { num: BigInt(i) * den + BigInt(f || "0"), den };
}

/** `SL.computeStabilityWindow k f` = ⌈3k/f⌉. */
export function stabilityWindow(k: number, activeSlotsCoeff: number): bigint {
    const { num, den } = ratio(activeSlotsCoeff);
    const n = 3n * BigInt(k) * den;
    return (n + num - 1n) / num;
}

export interface GenesisGeometry {
    byron: { k: number; slotDurationMs: number };
    shelley: { epochLength: number; slotLengthSec: number; securityParam: number; activeSlotsCoeff: number; systemStart: string };
}

export function byronEraParams(g: GenesisGeometry["byron"]): EraParams {
    const k = BigInt(g.k);
    return { epochSize: 10n * k, slotLengthMs: BigInt(g.slotDurationMs), safeZone: 2n * k, genesisWindow: 2n * k };
}

export function shelleyEraParams(g: GenesisGeometry["shelley"]): EraParams {
    const sw = stabilityWindow(g.securityParam, g.activeSlotsCoeff);
    return { epochSize: BigInt(g.epochLength), slotLengthMs: BigInt(Math.round(g.slotLengthSec * 1000)), safeZone: sw, genesisWindow: sw };
}

/** The shape: Byron's parameters, then the Shelley parameters for every Shelley-based era. */
export function eraShape(g: GenesisGeometry): EraParams[] {
    const s = shelleyEraParams(g.shelley);
    return [byronEraParams(g.byron), ...HFC_ERAS.slice(1).map(() => s)];
}

/** `mkUpperBound params lo hiEpoch`. */
export function mkUpperBound(p: EraParams, lo: Bound, hiEpoch: bigint): Bound {
    const epochs = hiEpoch - lo.epoch;
    if (epochs < 0n) throw new Error(`mkUpperBound: epoch ${hiEpoch} before era start ${lo.epoch}`);
    const slots = epochs * p.epochSize;
    return { timePicos: lo.timePicos + slots * p.slotLengthMs * 1_000_000_000n, slot: lo.slot + slots, epoch: hiEpoch };
}

/** `slotToEpochBound params lo hiSlot`: the first epoch boundary at or after `hiSlot`. */
export function slotToEpochBound(p: EraParams, lo: Bound, hiSlot: bigint): bigint {
    const slots = hiSlot - lo.slot;
    const epochs = slots / p.epochSize, inEpoch = slots % p.epochSize;
    return lo.epoch + (inEpoch === 0n ? epochs : epochs + 1n);
}

function applySafeZone(p: EraParams, start: Bound, fromSlot: bigint): Bound | null {
    if (p.safeZone == null) return null;
    return mkUpperBound(p, start, slotToEpochBound(p, start, fromSlot + p.safeZone));
}

export type Transition = { kind: "known"; epoch: bigint } | { kind: "unknown"; ledgerTipSlot: bigint | null } | { kind: "impossible" };

/**
 * `reconstructSummary`: `startEpochs[i]` is the first epoch of era i for every era up to and
 * including the current one (the era of the ledger state); `transition` is the current era's.
 */
export function reconstructSummary(shape: EraParams[], startEpochs: bigint[], transition: Transition): EraSummary[] {
    if (!startEpochs.length) throw new Error("reconstructSummary: no era");
    const cur = startEpochs.length - 1;
    const out: EraSummary[] = [];
    let start = INIT_BOUND;
    for (let i = 0; i < cur; i++) {
        const end = mkUpperBound(shape[i]!, start, startEpochs[i + 1]!);
        out.push({ start, end, params: shape[i]! });
        start = end;
    }
    const p = shape[cur]!;
    if (transition.kind === "known") {
        const end = mkUpperBound(p, start, transition.epoch);
        out.push({ start, end, params: p });
        const np = shape[cur + 1];
        if (np) out.push({ start: end, end: applySafeZone(np, end, end.slot), params: np });
    } else if (transition.kind === "unknown") {
        // even with a zero safe zone the next era starts at the next slot at the earliest; the ledger
        // tip lies in the current era (a caller without a tip gets the era's own start)
        const next = transition.ledgerTipSlot == null ? 0n : transition.ledgerTipSlot + 1n;
        out.push({ start, end: applySafeZone(p, start, next > start.slot ? next : start.slot), params: p });
    } else {
        out.push({ start, end: applySafeZone(p, start, start.slot), params: p });
    }
    return out;
}

/** Era summary index containing `slot` (past the last era's end: null — `PastHorizon`). */
export function eraIndexOfSlot(summary: EraSummary[], slot: bigint): number | null {
    for (let i = 0; i < summary.length; i++) {
        const s = summary[i]!;
        if (slot >= s.start.slot && (s.end == null || slot < s.end.slot)) return i;
    }
    return null;
}

export function epochOfSlot(summary: EraSummary[], slot: bigint): bigint | null {
    const i = eraIndexOfSlot(summary, slot);
    if (i == null) return null;
    const s = summary[i]!;
    return s.start.epoch + (slot - s.start.slot) / s.params.epochSize;
}

/** Wall-clock offset of `slot` from the system start, ms (`slotToWallclock`). */
export function slotToRelativeMs(summary: EraSummary[], slot: bigint): bigint | null {
    const i = eraIndexOfSlot(summary, slot);
    if (i == null) return null;
    const s = summary[i]!;
    return s.start.timePicos / 1_000_000_000n + (slot - s.start.slot) * s.params.slotLengthMs;
}

/** A uint beyond 2^64 as a CBOR bignum (tag 2, minimal big-endian bytes), like the reference node. */
function bigUInt(v: bigint): CborUInt {
    if (v < 1n << 64n) return new CborUInt(v);
    let hex = v.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    return new CborUInt(v, undefined, new CborBytes(Uint8Array.from(Buffer.from(hex, "hex"))));
}

function encodeBound(b: Bound): CborArray {
    return new CborArray([bigUInt(b.timePicos), new CborUInt(b.slot), new CborUInt(b.epoch)]);
}

function encodeParams(p: EraParams): CborArray {
    const sz = p.safeZone == null ? new CborArray([new CborUInt(1)]) : new CborArray([new CborUInt(0), new CborUInt(p.safeZone), new CborArray([new CborUInt(0)])]);
    return new CborArray([new CborUInt(p.epochSize), new CborUInt(p.slotLengthMs), sz, new CborUInt(p.genesisWindow)]);
}

/** GetInterpreter result (the consensus `Serialise (Summary xs)` encoding). */
export function encodeInterpreter(summary: EraSummary[]): CborObj {
    return new CborArray(summary.map((s) => new CborArray([encodeBound(s.start), s.end ? encodeBound(s.end) : new CborSimple(null), encodeParams(s.params)])), { indefinite: true });
}
