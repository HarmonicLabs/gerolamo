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

export function isSlotLeader(leaderValue: Uint8Array, sigma: Rational, activeSlotsCoeff: number): boolean {
    if (sigma.num <= 0n || sigma.den <= 0n) return false;
    if (activeSlotsCoeff >= 1) return true;
    const max = BigDecimal.fromBigint(1n << BigInt(8 * leaderValue.length));
    const value = BigDecimal.from(leaderValue);
    const denom = BigDecimal.sub(max, value);
    if (denom.toString().startsWith("-") || denom.toString() === "0") return false;
    const recipQ = BigDecimal.div(max, denom);
    const c = BigDecimal.sub(BigDecimal.fromBigint(1n), BigDecimal.fromNumber(activeSlotsCoeff)).ln();
    const s = BigDecimal.div(BigDecimal.fromBigint(sigma.num), BigDecimal.fromBigint(sigma.den));
    const x = BigDecimal.mul(s, c).neg();
    return expCmp(x, 1000n, 3n, recipQ).estimation === ExpOrd.LT;
}
