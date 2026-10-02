/**
 * Shelley pool ranking (cardano-ledger-shelley PoolRank.hs, LedgerState/PulsingReward.hs, API/Wallet.hs
 * at cardano-ledger-conway-1.22.1.0): the per-pool performance likelihoods the ledger keeps in
 * `esNonMyopic`, their update at each reward update, and the wallet queries built on them
 * (`GetNonMyopicMemberRewards`, `GetRewardInfoPools`).
 *
 * The ledger does this in floating point and the answers depend on the exact bits, so every
 * operation mirrors GHC's: a `LogWeight` is a 32-bit `Float` (each +, −, × rounded to single:
 * `Math.fround` of the double result is exact for one operation on two singles), sample values are
 * computed in `Double` and rounded once to `Float` (`realToFrac`), `log` / `exp` / `**` are the C
 * library's (as `Math.log` / `Math.exp` / `Math.pow`), and a `Rational` becomes a `Double` correctly
 * rounded (`fromRational`), which `rationalToDouble` reproduces for any bigint ratio.
 *
 *   likelihood n t  : L(x) = n·log x + (slotsPerEpoch − n)·log(1 − t·x) at x = (i + 0.5)/100, i < 100
 *   t               : leaderProbability = (1 − (1 − f)^σ)·(1 − d), σ = pool stake / circulation
 *   update (RUPD)   : for every pool of the `go` snapshot: (0.9 · old, or 0) + new, minus its minimum
 *   percentile'     : posterior = prior Beta(40, 1) + likelihood, normalised; the first sample whose
 *                     running sum of exp(posterior) exceeds 0.5 (1 when none does)
 */

/** One likelihood: 100 log-weights (Float). */
export type Likelihood = Float32Array;
export const SAMPLES = 100;
/** `samplePositions`: (x + 0.5) / 100 for x = 0 … 99, in Double. */
export const SAMPLE_POSITIONS: readonly number[] = Array.from({ length: SAMPLES }, (_, i) => (i + 0.5) / 100);
/** `decayFactor :: Float`. */
const DECAY = Math.fround(0.9);
const f32 = Math.fround;

// ---------------------------------------------------------------- exact rational helpers

export type Q = readonly [bigint, bigint]; // numerator, denominator (> 0), not necessarily reduced
const bitLength = (x: bigint): number => (x === 0n ? 0 : x.toString(2).length);
/** `fromRational :: Rational -> Double`: the nearest double, ties to even (GHC `rationalToDouble`). */
export function rationalToDouble(num: bigint, den: bigint): number {
    if (den < 0n) { num = -num; den = -den; }
    if (den === 0n) throw new Error("rationalToDouble: zero denominator");
    if (num === 0n) return 0;
    const neg = num < 0n;
    const n = neg ? -num : num;
    // q = ⌊n·2^k / d⌋ with exactly 53 bits
    let k = 53 - (bitLength(n) - bitLength(den));
    const quot = (kk: number) => (kk >= 0 ? ((n << BigInt(kk)) / den) : (n / (den << BigInt(-kk))));
    let q = quot(k);
    while (q >= 1n << 53n) { k--; q = quot(k); }
    while (q < 1n << 52n) { k++; q = quot(k); }
    const scaledN = k >= 0 ? n << BigInt(k) : n, scaledD = k >= 0 ? den : den << BigInt(-k);
    const r2 = 2n * (scaledN - q * scaledD);
    if (r2 > scaledD || (r2 === scaledD && (q & 1n) === 1n)) q++;
    if (q === 1n << 53n) { q = 1n << 52n; k--; }
    // q·2^−k, exact while the result is a normal double (always so for these quantities)
    let v = Number(q);
    let e = -k;
    while (e > 0) { const s = Math.min(e, 1000); v *= 2 ** s; e -= s; }
    while (e < 0) { const s = Math.max(e, -1000); v *= 2 ** s; e -= s; }
    return neg ? -v : v;
}
const qmin = (a: Q, b: Q): Q => (a[0] * b[1] <= b[0] * a[1] ? a : b);
const qmax = (a: Q, b: Q): Q => (a[0] * b[1] >= b[0] * a[1] ? a : b);
const qadd = (a: Q, b: Q): Q => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const qsub = (a: Q, b: Q): Q => [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];
const qmul = (a: Q, b: Q): Q => [a[0] * b[0], a[1] * b[1]];
const qdiv = (a: Q, b: Q): Q => (b[0] < 0n ? [-a[0] * b[1], -a[1] * b[0]] : [a[0] * b[1], a[1] * b[0]]);
/** ⌊a⌋ (toward −∞). */
export const qfloor = (a: Q): bigint => { const q = a[0] / a[1]; return a[0] % a[1] !== 0n && a[0] < 0n ? q - 1n : q; };
/** `a %? b`: 0 when b is 0. */
export const share = (a: bigint, b: bigint): Q => (b === 0n ? [0n, 1n] : [a, b]);

// ---------------------------------------------------------------- likelihoods

/** `leaderProbability asc σ d` = (1 − (1 − asc) ** σ) · (1 − d), every input a Rational converted to Double. */
export function leaderProbability(asc: Q, sigma: Q, d: Q): number {
    const a = rationalToDouble(asc[0], asc[1]), s = rationalToDouble(sigma[0], sigma[1]), dd = rationalToDouble(d[0], d[1]);
    return (1 - Math.pow(1 - a, s)) * (1 - dd);
}

/** `likelihood blocks t slotsPerEpoch`. */
export function likelihood(blocks: number, t: number, slotsPerEpoch: number): Likelihood {
    const n = blocks, m = slotsPerEpoch - blocks;
    const out = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) { const x = SAMPLE_POSITIONS[i]!; out[i] = f32(n * Math.log(x) + m * Math.log(1 - t * x)); }
    return out;
}

/** `normalizeLikelihood`: subtract the minimum (Float). */
export function normalizeLikelihood(xs: Likelihood): Likelihood {
    let m = xs[0]!;
    for (let i = 1; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
    const out = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = f32(xs[i]! - m);
    return out;
}
/** `Likelihood`'s `<>`: pointwise sum, normalised. */
export function combineLikelihoods(a: Likelihood, b: Likelihood): Likelihood {
    const s = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) s[i] = f32(a[i]! + b[i]!);
    return normalizeLikelihood(s);
}
/** `applyDecay 0.9`. */
export function applyDecay(l: Likelihood): Likelihood { const out = new Float32Array(SAMPLES); for (let i = 0; i < SAMPLES; i++) out[i] = f32(DECAY * l[i]!); return out; }
export const emptyLikelihood = (): Likelihood => new Float32Array(SAMPLES);

/**
 * `updateNonMyopic`: the likelihoods of the pools in `fresh` (the reward update's `go` snapshot
 * pools; every other pool is dropped), each the decayed history (or `mempty`) combined with its new
 * likelihood.
 */
export function updateLikelihoods(history: ReadonlyMap<string, Likelihood>, fresh: ReadonlyMap<string, Likelihood>): Map<string, Likelihood> {
    const out = new Map<string, Likelihood>();
    for (const [pool, l] of fresh) { const h = history.get(pool); out.set(pool, combineLikelihoods(h ? applyDecay(h) : emptyLikelihood(), l)); }
    return out;
}

export interface GoPool { stake: bigint; blocks: number }
/**
 * The likelihoods `startStep` computes for one reward update: every pool of the `go` snapshot, its
 * relative stake over the circulation the update uses (`poolTotalStake %? totalStake`), blocks made
 * in the performance epoch (0 for a pool absent from `BlocksMade`).
 */
export function freshLikelihoods(pools: ReadonlyMap<string, GoPool>, circulation: bigint, asc: Q, d: Q, slotsPerEpoch: number): Map<string, Likelihood> {
    const out = new Map<string, Likelihood>();
    for (const [id, p] of pools) out.set(id, likelihood(p.blocks, leaderProbability(asc, share(p.stake, circulation), d), slotsPerEpoch));
    return out;
}

// ---------------------------------------------------------------- performance estimate

/** `normalize` of a Histogram: subtract the maximum, then the log of the Riemann area (width 0.01, Double sum). */
function normalizeHistogram(values: Float32Array): Float32Array {
    let m = values[0]!;
    for (let i = 1; i < values.length; i++) if (values[i]! > m) m = values[i]!;
    const v = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) v[i] = f32(values[i]! - m);
    let area = 0;
    for (let i = 0; i < v.length; i++) area = area + 0.01 * Math.exp(v[i]!);
    const logArea = f32(Math.log(area));
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = f32(v[i]! - logArea);
    return out;
}
/** The prior `normalize (logBeta 40 1 <$> samplePositions)`. */
const PRIOR: Float32Array = normalizeHistogram(Float32Array.from(SAMPLE_POSITIONS, (x) => f32(39 * Math.log(x) + 0 * Math.log(1 - x))));

/** `percentile' l` (`percentile 0.5 prior l`); `null` = no history (`mempty`). */
export function performanceEstimate(l: Likelihood | null | undefined): number {
    const lk = l ?? emptyLikelihood();
    const sum = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) sum[i] = f32(PRIOR[i]! + lk[i]!);
    const post = normalizeHistogram(sum);
    let acc = 0;
    for (let i = 0; i < SAMPLES; i++) { if (acc > 0.5) return SAMPLE_POSITIONS[i]!; acc = acc + Math.exp(post[i]!); }
    return 1;
}

// ---------------------------------------------------------------- ranking and member rewards

export interface RankParams { a0: Q; nOpt: number; rPot: bigint; totalStake: bigint }
export interface RankPool { id: string; stake: bigint; ownerStake: bigint; pledge: bigint; cost: bigint; margin: Q }

/** `maxPool' a0 nOpt r σ pR` (Coin, floored). */
export function maxPool(a0: Q, nOpt: number, r: bigint, sigma: Q, pR: Q): bigint {
    const z0: Q = [1n, BigInt(nOpt)];
    const s1 = qmin(sigma, z0), p1 = qmin(pR, z0);
    const factor1 = qdiv([r, 1n], qadd([1n, 1n], a0));
    const factor4 = qdiv(qsub(z0, s1), z0);
    const factor3 = qdiv(qsub(s1, qmul(p1, factor4)), z0);
    const factor2 = qadd(s1, qmul(qmul(p1, a0), factor3));
    return qfloor(qmul(factor1, factor2));
}

/** `calcStakePoolDesirability` (Double). */
export function desirability(p: RankParams, pool: RankPool, perf: number): number {
    const z0: Q = [1n, BigInt(Math.max(1, p.nOpt))];
    const s: Q = [pool.pledge, p.totalStake > 1n ? p.totalStake : 1n];
    const inner = qmul([p.rPot, 1n], qadd(z0, qmul(qmin(s, z0), p.a0)));
    const fTilde = (perf * rationalToDouble(inner[0], inner[1])) / rationalToDouble(p.a0[1] + p.a0[0], p.a0[1]);
    const cost = rationalToDouble(pool.cost, 1n), margin = rationalToDouble(pool.margin[0], pool.margin[1]);
    return fTilde <= cost ? 0 : (fTilde - cost) * (1 - margin);
}

/** `getTopRankedPools`: the nOpt most desirable pools (stable sort, descending; ties keep pool-id order). */
export function topRankedPools(p: RankParams, pools: ReadonlyArray<RankPool & { perf: number }>): Set<string> {
    const ranked = [...pools].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((x) => ({ id: x.id, d: desirability(p, x, x.perf) }));
    ranked.sort((a, b) => (a.d === b.d ? 0 : a.d > b.d ? -1 : 1)); // Array.prototype.sort is stable
    return new Set(ranked.slice(0, Math.max(0, p.nOpt)).map((x) => x.id));
}

/** `calcNonMyopicMemberReward` for one pool and member share `t`. */
export function nonMyopicMemberReward(p: RankParams, pool: RankPool, perf: number, t: Q, top: ReadonlySet<string>): bigint {
    const z0: Q = [1n, BigInt(Math.max(1, p.nOpt))];
    const s = share(pool.pledge, p.totalStake), sigma = share(pool.stake, p.totalStake);
    const nm = top.has(pool.id) ? qmax(qadd(sigma, t), z0) : qadd(s, t);
    const f = maxPool(p.a0, p.nOpt, p.rPot, nm, s);
    const fHat = BigInt(Math.floor(perf * rationalToDouble(f, 1n)));
    if (fHat <= pool.cost) return 0n;
    // ⌊(f̂ − c)·(1 − m)·t / nm⌋
    return qfloor(qdiv(qmul(qmul([fHat - pool.cost, 1n], qsub([1n, 1n], pool.margin)), t), nm));
}

// ---------------------------------------------------------------- storage encoding

/** `esNonMyopic` of an epoch: the likelihoods and `rewardPotNM` the reward update applied at its start left. */
export interface NonMyopicState { epoch: number; rewardPot: bigint; likelihoods: Map<string, Likelihood> }
/** u64 rewardPot ‖ u32 pools ‖ pools × (28-byte pool id ‖ 100 × f32), big-endian, pools ascending. */
export function encodeNonMyopic(nm: { rewardPot: bigint; likelihoods: ReadonlyMap<string, Likelihood> }): Uint8Array {
    const ids = [...nm.likelihoods.keys()].sort();
    const out = new Uint8Array(12 + ids.length * (28 + 4 * SAMPLES));
    const dv = new DataView(out.buffer);
    dv.setBigUint64(0, nm.rewardPot, false);
    dv.setUint32(8, ids.length, false);
    let p = 12;
    for (const id of ids) {
        out.set(Buffer.from(id, "hex"), p); p += 28;
        const l = nm.likelihoods.get(id)!;
        for (let i = 0; i < SAMPLES; i++) { dv.setFloat32(p, l[i]!, false); p += 4; }
    }
    return out;
}
export function decodeNonMyopic(epoch: number, b: Uint8Array): NonMyopicState {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const rewardPot = dv.getBigUint64(0, false), n = dv.getUint32(8, false);
    const likelihoods = new Map<string, Likelihood>();
    let p = 12;
    for (let k = 0; k < n; k++) {
        const id = Buffer.from(b.subarray(p, p + 28)).toString("hex"); p += 28;
        const l = new Float32Array(SAMPLES);
        for (let i = 0; i < SAMPLES; i++) { l[i] = dv.getFloat32(p, false); p += 4; }
        likelihoods.set(id, l);
    }
    return { epoch, rewardPot, likelihoods };
}
