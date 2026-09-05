/**
 * TPraos overlay schedule (Shelley … Alonzo, decentralisation parameter d > 0),
 * cardano-ledger `lookupInOverlaySchedule`:
 *
 *   s = slot − firstSlotOfEpoch
 *   overlay slot   ⇔ floor(d·s) < floor(d·(s+1))
 *   position       = ceiling(d·s)
 *   active         ⇔ position mod ceiling(1/f) == 0          (f = activeSlotCoeff)
 *   genesis key    = sorted genesis keys [ (position div ceiling(1/f)) mod n ]
 *
 * An active overlay slot must be issued by that genesis key's delegate; a
 * non-active overlay slot must carry no block; a non-overlay slot follows the
 * stake-based Praos leader check. All arithmetic is exact rational.
 */
export interface Rational {
    num: bigint;
    den: bigint;
}

/** "0.8" → 8/10, 1 → 1/1, "0" → 0/1. */
export function rationalFromDecimal(v: string | number): Rational {
    const s = String(v).trim();
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`not a decimal: ${s}`);
    const frac = m[2] ?? "";
    return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}

function floorDiv(a: bigint, b: bigint): bigint {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}
function ceilDiv(a: bigint, b: bigint): bigint {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) === (b < 0n)) ? q + 1n : q;
}

export type OverlaySlot =
    | { kind: "praos" }
    | { kind: "inactive" }
    | { kind: "genesis"; genesisKeyHash: string };

export function overlaySlotKind(
    slot: bigint,
    firstSlotOfEpoch: bigint,
    d: Rational,
    activeSlotsCoeff: Rational,
    sortedGenesisKeys: readonly string[],
): OverlaySlot {
    if (d.num === 0n || sortedGenesisKeys.length === 0) return { kind: "praos" };
    const s = slot - firstSlotOfEpoch;
    if (s < 0n) return { kind: "praos" };
    // Shelley `isOverlaySlot`: step x = ceiling(x · d); overlay iff step s < step (s + 1).
    // (floor here misclassified the first slot of every epoch with 0 < d < 1 as a Praos
    // slot — mainnet slot 5788800, epoch 211, d = 0.9, issued by the first genesis delegate.)
    const stepS = ceilDiv(d.num * s, d.den);
    const stepNext = ceilDiv(d.num * (s + 1n), d.den);
    if (stepS >= stepNext) return { kind: "praos" };
    const position = ceilDiv(d.num * s, d.den);
    // ascInv = floor(1/f) with f = num/den → floor(den/num)
    const perActive = floorDiv(activeSlotsCoeff.den, activeSlotsCoeff.num);
    if (position % perActive !== 0n) return { kind: "inactive" };
    const idx = Number((position / perActive) % BigInt(sortedGenesisKeys.length));
    return { kind: "genesis", genesisKeyHash: sortedGenesisKeys[idx]! };
}
