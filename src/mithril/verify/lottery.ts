/**
 * STM lottery check, exact port of mithril-stm `is_lottery_won` (num-integer backend, the default).
 *
 * A signature wins index i when p = ev / 2^512 < 1 - (1 - phi_f)^w, with w = stake / total_stake.
 * Mithril rewrites it as q < exp(x) with q = 2^512 / (2^512 - ev) and x = -w * ln(1 - phi_f), and
 * decides it with a Taylor series that stops as soon as the remaining error cannot change the
 * answer (error term = next term * 3), giving up (false) after 1000 terms.
 *
 * All arithmetic is exact over big integers. ln(1 - phi_f) is computed in f64 and then converted
 * exactly to a rational, as `Ratio::from_float` does.
 */

const EV_MAX = 1n << 512n;

/** Exact rational value of a finite double: [numerator, denominator > 0]. */
export function rationalFromFloat(f: number): [bigint, bigint] {
    if (!Number.isFinite(f)) throw new Error(`not a finite number: ${f}`);
    if (f === 0) return [0n, 1n];
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, f);
    const bits = view.getBigUint64(0);
    const sign = bits >> 63n ? -1n : 1n;
    const exp = Number((bits >> 52n) & 0x7ffn);
    let mant = bits & ((1n << 52n) - 1n);
    let e: number;
    if (exp === 0) {
        e = -1074; // subnormal
    } else {
        mant |= 1n << 52n;
        e = exp - 1075;
    }
    if (e >= 0) return [sign * (mant << BigInt(e)), 1n];
    // Reduce the power of two so the fraction is in lowest terms (not required for correctness).
    let den = 1n << BigInt(-e);
    while (mant % 2n === 0n && den > 1n) {
        mant /= 2n;
        den /= 2n;
    }
    return [sign * mant, den];
}

/** ev: the 64-byte dense mapping output, read as a little-endian integer. */
export function evToBigInt(ev: Uint8Array): bigint {
    if (ev.length !== 64) throw new Error(`ev must be 64 bytes, got ${ev.length}`);
    let n = 0n;
    for (let i = 63; i >= 0; i--) n = (n << 8n) | BigInt(ev[i]!);
    return n;
}

/**
 * True when cmp < exp(x), decided by the Taylor expansion with Mithril's early stop.
 * cmp = cn / cd, x = a / b, all positive, cd and b > 0.
 */
export function taylorComparison(bound: number, cn: bigint, cd: bigint, a: bigint, b: bigint): boolean {
    // phi = N / D (running sum), term = T / D' with D' = D * b * (t + 1) at each step.
    // Start: phi = 1, new_x = x.
    let N = 1n; // phi numerator over D
    let D = 1n;
    let T = a; // new_x numerator; new_x = T / (D * b) initially (= a / b)
    let termDen = b;
    let divisor = 1n;
    for (let i = 0; i < bound; i++) {
        // phi += new_x  (new_x = T / termDen, and termDen = D * b * divisor-chain)
        // Bring phi to termDen: N * (termDen / D) + T
        const scale = termDen / D; // exact by construction
        N = N * scale + T;
        D = termDen;
        divisor += 1n;
        // new_x = new_x * x / divisor
        T = T * a;
        termDen = termDen * b * divisor;
        // error_term = |new_x| * 3 = 3T / termDen; compare cmp against phi +- error.
        const s2 = termDen / D;
        const phiN = N * s2; // phi over termDen
        const err = 3n * (T < 0n ? -T : T);
        // cmp > phi + err  <=>  cn * termDen > cd * (phiN + err)
        if (cn * termDen > cd * (phiN + err)) return false;
        if (cn * termDen < cd * (phiN - err)) return true;
    }
    return false;
}

/** mithril-stm `is_lottery_won`. Throws on zero total stake or phi_f out of (0, 1]. */
export function isLotteryWon(phiF: number, ev: Uint8Array, stake: bigint, totalStake: bigint): boolean {
    if (totalStake === 0n) throw new Error("ZeroTotalStake");
    if (Math.abs(phiF - 1.0) < Number.EPSILON) return true;
    if (!(phiF > 0.0 && phiF <= 1.0)) throw new Error(`PhiFValueOutOfRange(${phiF})`);
    const evN = evToBigInt(ev);
    if (evN === EV_MAX) return false;
    // q = ev_max / (ev_max - ev)
    const qn = EV_MAX;
    const qd = EV_MAX - evN;
    // c = ln(1 - phi_f) as an exact rational (negative), x = -(w * c) >= 0
    const [lnN, lnD] = rationalFromFloat(Math.log(1.0 - phiF));
    const a = -(stake * lnN); // lnN < 0 so a >= 0
    const b = totalStake * lnD;
    return taylorComparison(1000, qn, qd, a, b);
}
