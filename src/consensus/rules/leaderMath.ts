/**
 * Praos / TPraos slot-leader check (cardano-ledger `checkLeaderNatValue`):
 * with p = leaderValue / 2^(8·len) and q = 1 − p, the pool with relative stake
 * σ leads the slot iff 1/q < exp(−σ · ln(1 − f)), i.e. p < 1 − (1 − f)^σ.
 * Praos (Babbage+) uses the 32-byte blake2b("L" ‖ vrf) value; TPraos uses the
 * raw 64-byte VRF output, so the bound follows the value's length.
 * Evaluated with the same Taylor-series comparison the ledger uses (expCmp).
 */
import { BigDecimal, expCmp, ExpOrd } from "@harmoniclabs/cardano-math-ts";
import type { Rational } from "./overlay";

// ln(1 − f) per f, and −σ·ln(1 − f) per (f, σ): both are constant for a pool within an epoch
// while every header (from every hot peer) asked for them — 2.6 % of the applier thread in
// the 2026-09-07 profile went to the ln and the divisions. Bounded: cleared past 20 000 entries.
const lnOneMinusF = new Map<number, BigDecimal>();
const sigmaTerm = new Map<string, BigDecimal>();
const maxByLen = new Map<number, BigDecimal>();

export function isSlotLeader(leaderValue: Uint8Array, sigma: Rational, activeSlotsCoeff: number): boolean {
    if (sigma.num <= 0n || sigma.den <= 0n) return false;
    if (activeSlotsCoeff >= 1) return true;
    let max = maxByLen.get(leaderValue.length);
    if (!max) { max = BigDecimal.fromBigint(1n << BigInt(8 * leaderValue.length)); maxByLen.set(leaderValue.length, max); }
    const value = BigDecimal.from(leaderValue);
    const denom = BigDecimal.sub(max, value);
    if (denom.toString().startsWith("-") || denom.toString() === "0") return false;
    const recipQ = BigDecimal.div(max, denom);
    let c = lnOneMinusF.get(activeSlotsCoeff);
    if (!c) { c = BigDecimal.sub(BigDecimal.fromBigint(1n), BigDecimal.fromNumber(activeSlotsCoeff)).ln(); lnOneMinusF.set(activeSlotsCoeff, c); }
    const key = `${activeSlotsCoeff}|${sigma.num}/${sigma.den}`;
    let x = sigmaTerm.get(key);
    if (!x) {
        const s = BigDecimal.div(BigDecimal.fromBigint(sigma.num), BigDecimal.fromBigint(sigma.den));
        x = BigDecimal.mul(s, c).neg();
        if (sigmaTerm.size >= 20_000) sigmaTerm.clear();
        sigmaTerm.set(key, x);
    }
    return expCmp(x, 1000n, 3n, recipQ).estimation === ExpOrd.LT;
}
