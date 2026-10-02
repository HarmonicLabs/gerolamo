/**
 * The built-in `Value` type of Plutus Core (constant type tag 13) and the denotations of its
 * builtins (insertCoin, lookupCoin, unionValue, valueContains, valueData, unValueData,
 * scaleValue), exactly as plutus-core 1.63.0.0 (`PlutusCore.Value`, the version inside
 * cardano-node 11.0.1) defines them:
 *
 * - a map currency → (token → quantity), keys are bytestrings of at most 32 bytes ordered as
 *   bytestrings (lexicographically, a prefix first), quantities signed 128-bit integers;
 * - invariants: no empty inner map and no zero quantity (operations normalise);
 * - cached sizes: total number of entries (`totalSize`, the `ValueTotalSize` cost measure), the
 *   largest inner map (for `ValueMaxDepth`) and the number of negative quantities.
 *
 * Values are immutable: operations copy the outer array and the one inner array they touch.
 */
import { DBytes, DInt, DK, DMap, DPair, type Data } from "./data";

export const MAX_KEY_LEN = 32;
export const QUANTITY_MIN = -(1n << 127n), QUANTITY_MAX = (1n << 127n) - 1n;
/** `valueDataMaxSize`: valueData fails above this many entries. */
export const VALUE_DATA_MAX_SIZE = 40_000;

export type Tokens = ReadonlyArray<readonly [Uint8Array, bigint]>;
export type Entries = ReadonlyArray<readonly [Uint8Array, Tokens]>;

export class VValue {
    constructor(
        /** currency → tokens, both strictly ascending; no empty inner array, no zero quantity. */
        readonly entries: Entries,
        /** Number of (currency, token) entries. */
        readonly total: number,
        /** Size of the largest inner map. */
        readonly maxInner: number,
        /** Number of negative quantities. */
        readonly neg: number,
    ) {}
}
export const EMPTY_VALUE = new VValue([], 0, 0, 0);

/** A failed Value operation (the builtin's `fail`): an evaluation failure. */
export class ValueError extends Error {}
const fail = (msg: string): never => { throw new ValueError(msg); };

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
}
const inBounds = (q: bigint) => q >= QUANTITY_MIN && q <= QUANTITY_MAX;

/** `pack'`: the cached sizes of normalised entries. */
export function mkValue(entries: Entries): VValue {
    if (entries.length === 0) return EMPTY_VALUE;
    let total = 0, maxInner = 0, neg = 0;
    for (const [, ts] of entries) {
        total += ts.length;
        if (ts.length > maxInner) maxInner = ts.length;
        for (const [, q] of ts) if (q < 0n) neg++;
    }
    return new VValue(entries, total, maxInner, neg);
}

/** Binary search: index of `k`, or −(insertion point) − 1. */
function find<T>(arr: ReadonlyArray<readonly [Uint8Array, T]>, k: Uint8Array): number {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1, c = compareBytes(arr[mid]![0], k);
        if (c === 0) return mid;
        if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return -lo - 1;
}

/**
 * `buildValueWith`: the strict constructor of the flat decoder and `unValueData` — currencies
 * and tokens strictly ascending, no empty inner map, no zero quantity. (Key lengths and quantity
 * bounds are the callers' element checks.)
 */
export function buildValueStrict(outer: ReadonlyArray<readonly [Uint8Array, ReadonlyArray<readonly [Uint8Array, bigint]>]>, ctx: string): VValue {
    for (let i = 0; i < outer.length; i++) {
        const [c, ts] = outer[i]!;
        if (i > 0 && compareBytes(outer[i - 1]![0], c) >= 0) fail(`${ctx}: currency symbols not strictly ascending`);
        if (ts.length === 0) fail(`${ctx}: empty inner map`);
        for (let j = 0; j < ts.length; j++) {
            if (j > 0 && compareBytes(ts[j - 1]![0], ts[j]![0]) >= 0) fail(`${ctx}: token names not strictly ascending`);
            if (ts[j]![1] === 0n) fail(`${ctx}: zero quantity`);
        }
    }
    return mkValue(outer);
}

/**
 * `fromList` (the textual syntax's constructor, used by tests): duplicates are summed, the
 * sums checked against the 128-bit bounds, zero quantities and empty inner maps dropped.
 */
export function valueFromList(xs: ReadonlyArray<readonly [Uint8Array, ReadonlyArray<readonly [Uint8Array, bigint]>]>): VValue {
    const m = new Map<string, { c: Uint8Array; ts: Map<string, [Uint8Array, bigint]> }>();
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    for (const [c, ts] of xs) {
        if (c.length > MAX_KEY_LEN) fail("valueFromList: currency symbol longer than 32 bytes");
        let e = m.get(hex(c));
        if (!e) m.set(hex(c), (e = { c, ts: new Map() }));
        for (const [t, q] of ts) {
            if (t.length > MAX_KEY_LEN) fail("valueFromList: token name longer than 32 bytes");
            if (!inBounds(q)) fail("valueFromList: quantity out of bounds");
            const o = e.ts.get(hex(t));
            e.ts.set(hex(t), [t, (o?.[1] ?? 0n) + q]);
        }
    }
    const entries: Array<[Uint8Array, Array<[Uint8Array, bigint]>]> = [];
    for (const { c, ts } of m.values()) {
        const inner = [...ts.values()];
        for (const [, q] of inner) if (!inBounds(q)) fail("valueFromList: quantity out of bounds");
        const nz = inner.filter(([, q]) => q !== 0n).sort((a, b) => compareBytes(a[0], b[0]));
        if (nz.length) entries.push([c, nz]);
    }
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    return mkValue(entries);
}

/** Bit length of a positive size (⌊log2 n⌋ + 1), 0 for 0. */
const bitLen = (n: number) => (n > 0 ? 32 - Math.clz32(n) : 0);
/** `ValueMaxDepth` cost measure: log of the outer size plus log of the largest inner map. */
export function valueMaxDepth(v: VValue): number { return bitLen(v.entries.length) + bitLen(v.maxInner); }

/** `DataNodeCount` cost measure: every node counts 1 (map keys and values each). */
export function dataNodeCount(d: Data): number {
    let n = 1;
    switch (d.k) {
        case DK.Constr: for (const f of d.fields) n += dataNodeCount(f); break;
        case DK.Map: for (const e of d.entries) n += dataNodeCount(e.fst) + dataNodeCount(e.snd); break;
        case DK.List: for (const x of d.items) n += dataNodeCount(x); break;
    }
    return n;
}

/** Largest inner map (after an entry left one: O(currencies), not O(entries)). */
function maxInnerOf(entries: Entries): number { let m = 0; for (const [, ts] of entries) if (ts.length > m) m = ts.length; return m; }

/** `insertCoin`: amount 0 deletes (without checking the keys); else keys ≤ 32 bytes, amount in bounds. */
export function insertCoin(c: Uint8Array, t: Uint8Array, amount: bigint, v: VValue): VValue {
    if (amount === 0n) return deleteCoin(c, t, v);
    if (c.length > MAX_KEY_LEN) fail("insertCoin: invalid currency");
    if (t.length > MAX_KEY_LEN) fail("insertCoin: invalid token");
    if (!inBounds(amount)) fail("insertCoin: quantity out of bounds");
    const outer = v.entries.slice();
    const i = find(outer, c);
    const negNew = amount < 0n ? 1 : 0;
    if (i < 0) { outer.splice(-i - 1, 0, [c, [[t, amount]]]); return new VValue(outer, v.total + 1, Math.max(v.maxInner, 1), v.neg + negNew); }
    const inner = outer[i]![1].slice();
    const j = find(inner, t);
    let total = v.total, neg = v.neg + negNew;
    if (j < 0) { inner.splice(-j - 1, 0, [t, amount]); total++; }
    else { if (inner[j]![1] < 0n) neg--; inner[j] = [t, amount]; }
    outer[i] = [outer[i]![0], inner];
    return new VValue(outer, total, Math.max(v.maxInner, inner.length), neg);
}

export function deleteCoin(c: Uint8Array, t: Uint8Array, v: VValue): VValue {
    const i = find(v.entries, c);
    if (i < 0) return v;
    const ts = v.entries[i]![1], j = find(ts, t);
    if (j < 0) return v;
    const outer = v.entries.slice();
    if (ts.length === 1) outer.splice(i, 1);
    else { const inner = ts.slice(); inner.splice(j, 1); outer[i] = [outer[i]![0], inner]; }
    if (outer.length === 0) return EMPTY_VALUE;
    return new VValue(outer, v.total - 1, ts.length === v.maxInner ? maxInnerOf(outer) : v.maxInner, v.neg - (ts[j]![1] < 0n ? 1 : 0));
}

export function lookupCoin(c: Uint8Array, t: Uint8Array, v: VValue): bigint {
    const i = find(v.entries, c);
    if (i < 0) return 0n;
    const ts = v.entries[i]![1], j = find(ts, t);
    return j < 0 ? 0n : ts[j]![1];
}

/** `unionValue`: pointwise sum; a sum outside the 128-bit bounds fails, zero sums disappear. */
export function unionValue(a: VValue, b: VValue): VValue {
    if (a.total === 0) return b;
    if (b.total === 0) return a;
    const out: Array<readonly [Uint8Array, Tokens]> = [];
    const A = a.entries, B = b.entries;
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
        const c = i >= A.length ? 1 : j >= B.length ? -1 : compareBytes(A[i]![0], B[j]![0]);
        if (c < 0) { out.push(A[i++]!); continue; }
        if (c > 0) { out.push(B[j++]!); continue; }
        const x = A[i]![1], y = B[j]![1], inner: Array<readonly [Uint8Array, bigint]> = [];
        let p = 0, q = 0;
        while (p < x.length || q < y.length) {
            const d = p >= x.length ? 1 : q >= y.length ? -1 : compareBytes(x[p]![0], y[q]![0]);
            if (d < 0) { inner.push(x[p++]!); continue; }
            if (d > 0) { inner.push(y[q++]!); continue; }
            const s = x[p]![1] + y[q]![1];
            if (!inBounds(s)) fail("unionValue: quantity is out of the signed 128-bit integer bounds");
            if (s !== 0n) inner.push([x[p]![0], s]);
            p++; q++;
        }
        if (inner.length) out.push([A[i]![0], inner]);
        i++; j++;
    }
    return mkValue(out);
}

/** `valueContains a b`: every entry of b is at most a's; negative amounts in either fail. */
export function valueContains(a: VValue, b: VValue): boolean {
    if (a.neg > 0) fail("valueContains: first value contains negative amounts");
    if (b.neg > 0) fail("valueContains: second value contains negative amounts");
    if (a.total < b.total) return false;
    for (const [c, ts] of b.entries) {
        const i = find(a.entries, c);
        if (i < 0) return false;
        const ats = a.entries[i]!;
        if (ats[1].length < ts.length) return false;
        for (const [t, q] of ts) {
            const j = find(ats[1], t);
            if (j < 0 || ats[1][j]![1] < q) return false;
        }
    }
    return true;
}

/** `valueData`: Map [(B currency, Map [(B token, I quantity)])], ascending; at most 40000 entries. */
export function valueData(v: VValue): Data {
    if (v.total > VALUE_DATA_MAX_SIZE) fail(`valueData: maximum input size (${VALUE_DATA_MAX_SIZE}) exceeded`);
    return new DMap(v.entries.map(([c, ts]) => new DPair(new DBytes(c), new DMap(ts.map(([t, q]) => new DPair(new DBytes(t), new DInt(q)))))));
}

/** `unValueData`: the inverse of valueData, strict (canonical order, no zero, keys ≤ 32 bytes, 128-bit quantities). */
export function unValueData(d: Data): VValue {
    if (d.k !== DK.Map) fail("unValueData: non-Map constructor");
    const key = (x: Data): Uint8Array => {
        if (x.k !== DK.Bytes) fail("unValueData: non-B constructor");
        if ((x as DBytes).v.length > MAX_KEY_LEN) fail("unValueData: invalid key");
        return (x as DBytes).v;
    };
    const outer = (d as DMap).entries.map((e) => {
        const c = key(e.fst);
        const inner = e.snd as Data;
        if (inner.k !== DK.Map) fail("unValueData: non-Map constructor");
        const ts = (inner as DMap).entries.map((p): readonly [Uint8Array, bigint] => {
            const t = key(p.fst), qd = p.snd as Data;
            if (qd.k !== DK.Int) fail("unValueData: non-I constructor");
            if (!inBounds((qd as DInt).v)) fail("unValueData: invalid quantity");
            return [t, (qd as DInt).v];
        });
        return [c, ts] as const;
    });
    return buildValueStrict(outer, "unValueData");
}

/** `scaleValue c v`: every quantity times c (bounds checked); scaling by 0 is the empty value. */
export function scaleValue(c: bigint, v: VValue): VValue {
    if (c === 0n) return EMPTY_VALUE;
    const entries = v.entries.map(([cur, ts]) => [cur, ts.map(([t, q]) => {
        const r = q * c;
        if (!inBounds(r)) fail("scaleValue: quantity out of bounds");
        return [t, r] as const;
    })] as const);
    return new VValue(entries, v.total, v.maxInner, c > 0n ? v.neg : v.total - v.neg);
}

/** Structural equality (tests; plutus-core derives `Eq`). */
export function valueEq(a: VValue, b: VValue): boolean {
    if (a.total !== b.total || a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i++) {
        const [c1, t1] = a.entries[i]!, [c2, t2] = b.entries[i]!;
        if (compareBytes(c1, c2) !== 0 || t1.length !== t2.length) return false;
        for (let j = 0; j < t1.length; j++) if (compareBytes(t1[j]![0], t2[j]![0]) !== 0 || t1[j]![1] !== t2[j]![1]) return false;
    }
    return true;
}
