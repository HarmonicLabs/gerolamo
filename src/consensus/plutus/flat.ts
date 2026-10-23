/**
 * Flat decoder for on-chain UPLC programs (plutus-core `Flat` instances, de Bruijn indices),
 * straight into the evaluator's program representation. Unlike @harmoniclabs/uplc's decoder it
 * keeps `force` nodes around builtins (a builtin must receive exactly its forces, in the machine),
 * reads bits with Number arithmetic, and checks the builtin set and the language version against
 * the ledger language and protocol version (PlutusLedgerApi.Common.Versions), and from van Rossem
 * (protocol 11) the decoder's bounds (`maxBoundsByPV`: constant types of size at most 32, `constr`
 * with at most 1024 fields). Semantics are plutus-core 1.63.0.0's, the version inside
 * cardano-node 11.0.1.
 *
 * Representation (round two of the node-diversity-conformance `uplc-turbo` work): a program is a
 * `Code` — two parallel typed arrays with one slot per term node, numbered in pre-order (a kind
 * and one operand), plus side tables for constants and for `constr` / `case` child lists — rather
 * than a tree of objects. A 7 KB validator has ~7 800 nodes; built as objects they were most of
 * the garbage a validation produces (and the garbage decides how often the collector's pauses
 * land inside an evaluation), while the typed arrays are two allocations whatever the size. The
 * machine (cek.ts) walks node indices; `Program.term` builds the object form (`Term`) on demand
 * for tools and tests.
 *
 * Speed: the term loop keeps the bit cursor (a 32-bit accumulator refilled a byte at a time) in
 * locals, so a term tag, a builtin tag or a one-byte de Bruijn index is one shift-and-mask with
 * no call; naturals stay Numbers up to 2^53; builtin availability is a byte mask; the common
 * constant types are a table lookup; bytestrings are one `slice` (one copy: constants never alias
 * the script bytes); strings take an ASCII fast path. Reading past the end of the input is a
 * `FlatError` (the input is never padded, so a truncated program is rejected, never read as zeros).
 */
import { decodeData, type Data } from "./data";
import { ConstT, FALSE, T, TRUE, UNIT, type ConstType, VArray, VCon, mkListFromArray, VPair } from "./values";
import { MAX_KEY_LEN, QUANTITY_MAX, QUANTITY_MIN, ValueError, buildValueStrict } from "./multiasset";

export const enum TK { Var = 0, Delay = 1, Lam = 2, Apply = 3, Const = 4, Force = 5, Error = 6, Builtin = 7, Constr = 8, Case = 9 }
/** Node kind 10 (`Code` only, never in an object term): an application whose function is not the next node (`applyData`); `A` indexes `xapps`. */
export const TK_APPLY_X = 10;

/**
 * The object form of a term: what the text parser (uplcText.ts) produces and what `Program.term`
 * materialises; the machine evaluates `Code`, compiling an object term first (`compileTerm`).
 * Leaves without identity of their own are shared (`unit` / `bool` constants are the `UNIT`,
 * `TRUE`, `FALSE` values of values.ts), so a node must never be annotated in place.
 */
export type Term =
    | { k: TK.Var; i: number }
    | { k: TK.Delay; b: Term }
    | { k: TK.Lam; b: Term }
    | { k: TK.Apply; f: Term; a: Term }
    | { k: TK.Const; v: VCon }
    | { k: TK.Force; b: Term }
    | { k: TK.Error }
    | { k: TK.Builtin; fn: number }
    | { k: TK.Constr; tag: number; fields: Term[] }
    | { k: TK.Case; s: Term; bs: Term[] };

/** A `constr` node's tag (a Word64: a Number, or beyond 2^53 the exact bigint typed as number) and field nodes. */
export interface ConstrNode { tag: number; fields: number[] }

/**
 * A program's nodes: `K[t]` is the kind (`TK`, or `TK_APPLY_X`) of node `t`, `A[t]` its operand:
 *
 *  - var: `A` = de Bruijn index (an index of 2^31 or more — never bound by any environment — is
 *    stored as `-1 - j` with the exact value in `bigVars[j]`; the machine treats it as unbound);
 *  - delay / lam / force: the body is node `t + 1` (pre-order), no operand;
 *  - apply: the function is node `t + 1`, `A` = the argument node (after the function's subtree);
 *  - apply-x (`TK_APPLY_X`): `A` indexes `xapps`, which holds the function and argument nodes —
 *    the applications `applyData` wraps a decoded program in (the program's root is not adjacent);
 *  - const: `A` indexes `consts`;
 *  - builtin: `A` = flat builtin tag;
 *  - constr: `A` indexes `ctrs` (tag and field nodes);
 *  - case: the scrutinee is node `t + 1`, `A` indexes `cases` (branch nodes).
 *
 * `n` nodes are in use (the arrays may be longer). Immutable once built: a decoded program is
 * cached and shared between evaluations; `applyData` copies.
 */
export class Code {
    constructor(
        readonly K: Uint8Array, readonly A: Int32Array, readonly n: number,
        readonly consts: readonly VCon[], readonly ctrs: readonly ConstrNode[], readonly cases: ReadonlyArray<readonly number[]>, readonly bigVars: readonly number[],
        readonly xapps: ReadonlyArray<{ readonly f: number; readonly a: number }> = [],
    ) {}
}

/** A decoded (or compiled) program: `code` with its `root` node; `term` is the object form, built on first use. */
export class Program {
    private objectTerm: Term | null = null;
    constructor(readonly version: [number, number, number], readonly code: Code, readonly root: number) {}
    /** The program as an object term (tools, tests, `termEq`); the machine never needs it. */
    get term(): Term { return (this.objectTerm ??= materialise(this.code, this.root)); }
}

/** Builtins by protocol version per ledger language (batches of Versions.hs; flat tags). */
const BATCH1 = range(0, 50), BATCH2 = [51], BATCH3 = [52, 53], BATCH4A = range(54, 72), BATCH4B = [73, 74], BATCH5 = range(75, 86);
/**
 * Batch 6 (van Rossem, protocol 11; plutus-ledger-api 1.63 `batch6`): expModInteger, dropList,
 * lengthOfArray, listToArray, indexArray, the BLS12-381 multi-scalar multiplications (92, 93) and
 * the Value builtins insertCoin … scaleValue (94–100). Flat tags 101+ do not exist in 1.63.
 */
const BATCH6 = range(87, 100);
function range(a: number, b: number): number[] { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; }
const INTRODUCED: Record<1 | 2 | 3 | 4, Array<[number, number[]]>> = {
    1: [[5, BATCH1], [11, [...BATCH2, ...BATCH3, ...BATCH4A, ...BATCH4B, ...BATCH5, ...BATCH6]]],
    2: [[7, [...BATCH1, ...BATCH2]], [8, BATCH3], [10, BATCH4B], [11, [...BATCH4A, ...BATCH5, ...BATCH6]]],
    3: [[9, [...BATCH1, ...BATCH2, ...BATCH3, ...BATCH4A, ...BATCH4B]], [10, BATCH5], [11, BATCH6]],
    // Plutus V4 (Dijkstra, protocol 12): batches 1..6 at once (bug 433)
    4: [[12, [...BATCH1, ...BATCH2, ...BATCH3, ...BATCH4A, ...BATCH4B, ...BATCH5, ...BATCH6]]],
};
const availCache = new Map<string, Set<number>>();
export function builtinsAvailable(lang: 1 | 2 | 3 | 4, pv: number): Set<number> {
    const key = `${lang}:${pv}`;
    let s = availCache.get(key);
    if (!s) { s = new Set(); for (const [p, tags] of INTRODUCED[lang]) if (p <= pv) for (const t of tags) s.add(t); availCache.set(key, s); }
    return s;
}
/** Plutus Core 1.1.0 (constr/case): V3 and V4 always; V1/V2 from van Rossem (PV 11). */
export function plc110Available(lang: 1 | 2 | 3 | 4, pv: number): boolean { return lang >= 3 || pv >= 11; }
/** Plutus Core 1.2.0: every language from Dijkstra (PV 12; `plcVersionsIntroducedIn`). */
export function plc120Available(lang: 1 | 2 | 3 | 4, pv: number): boolean { void lang; return pv >= 12; }
/** `maxBoundsByPV` (PlutusLedgerApi.Common.Versions): from van Rossem a constant's type has size ≤ 32, a `constr` ≤ 1024 fields. */
export const MAX_CONST_TYPE_SIZE = 32, MAX_CONSTR_FIELDS = 1024;
/** `defaultUniSize`: 1 per type constructor, + 1 per application (list a = |a| + 2, pair a b = |a| + |b| + 3). */
export function constTypeSize(t: ConstType): number {
    switch (t.tag) {
        case 5: case 12: return constTypeSize(t.a!) + 2;
        case 6: return constTypeSize(t.a!) + constTypeSize(t.b!) + 3;
    }
    return 1;
}

export class FlatError extends Error {}

const UNIT_CON = UNIT, TRUE_CON = TRUE, FALSE_CON = FALSE;

/** Type tags that are a complete type by themselves (everything but 7, the application). */
const SIMPLE_TYPE: Array<ConstType | undefined> = [];
SIMPLE_TYPE[0] = T.int; SIMPLE_TYPE[1] = T.bytes; SIMPLE_TYPE[2] = T.string; SIMPLE_TYPE[3] = T.unit; SIMPLE_TYPE[4] = T.bool; SIMPLE_TYPE[8] = T.data;
// BLS12-381 types decode (an empty list of points is a valid constant); a value of one does not
SIMPLE_TYPE[9] = T.g1; SIMPLE_TYPE[10] = T.g2; SIMPLE_TYPE[11] = T.ml; SIMPLE_TYPE[13] = T.value;

/** `(1 << n) - 1` for n = 0..24. */
const MASK = new Int32Array(25); for (let n = 0; n <= 24; n++) MASK[n] = (1 << n) - 1;
/** 2^(7k) for k = 0..7: the weight of the k-th 7-bit group of a natural (group 6 ends below 2^49). */
const POW7 = [1, 128, 16384, 2097152, 268435456, 34359738368, 4398046511104, 562949953421312];
/** Zigzag-decoded integers for one-byte naturals (−64 … 63); bigints compare by value, so sharing is invisible. */
const SMALL_INT: bigint[] = []; for (let z = 0; z < 128; z++) SMALL_INT[z] = (z & 1) === 0 ? BigInt(z >>> 1) : -BigInt((z >>> 1) + 1);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), TWO64 = 1n << 64n;
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
/** UTF-8 to string, rejecting malformed input; ASCII (every on-chain string constant of note) without the decoder call. */
function utf8(b: Uint8Array): string {
    const n = b.length;
    if (n <= 64) {
        let ascii = true;
        for (let i = 0; i < n; i++) if (b[i]! > 127) { ascii = false; break; }
        if (ascii) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]!); return s; }
    }
    try { return utf8Strict.decode(b); } catch { throw new FlatError("flat: invalid utf-8 string constant"); }
}

const OUT_OF_INPUT = "flat: out of input";
/**
 * Header tables by term tag, for the term loop's branch-free common path: `TAKE` bits consumed
 * (0: the tag always takes the switch), `SHIFTS` / `OPMASK` the operand inside the 16 peeked
 * bits (var: the 8 bits after the tag, builtin: 7), `KIDS` children. A var whose
 * index has more than one byte (bit 11 set) also takes the switch.
 */
const TAKE = new Int8Array([12, 4, 4, 4, 0, 4, 4, 11, 0, 0, 0, 0, 0, 0, 0, 0]);
const SHIFTS = new Int8Array([4, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
const OPMASK = new Int32Array([255, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0]);
const KIDS = new Int8Array([0, 1, 1, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** The structure stack (nodes waiting for a child list to end, and the `pending` value that ends it); decoding is synchronous, so one pair serves every call. */
let SCRATCH_P = new Int32Array(4096), SCRATCH_T = new Int32Array(4096);
/**
 * Per (language, protocol, deserialiseOnly): `check[tag << 8 | operand]` is 1 for the headers the
 * common path rejects — de Bruijn index 0 (unless deserialiseOnly) and a builtin tag the
 * language does not have at that protocol version (`builtinsAvailable`).
 */
const checkCache = new Map<string, Uint8Array>();
function headerCheck(lang: 1 | 2 | 3 | 4, pv: number, deserialiseOnly: boolean): Uint8Array {
    const key = `${lang}:${pv}:${deserialiseOnly ? 1 : 0}`;
    let m = checkCache.get(key);
    if (!m) {
        m = new Uint8Array(4096);
        m[0] = deserialiseOnly ? 0 : 1;
        for (let t = 0; t < 128; t++) m[(TK.Builtin << 8) | t] = 1;
        for (const t of builtinsAvailable(lang, pv)) m[(TK.Builtin << 8) | t] = 0;
        checkCache.set(key, m);
    }
    return m;
}


class FlatReader {
    /** Next byte to load into the accumulator (may run past `len`: those are counted, never read). */
    i = 0;
    /** The low `nbits` bits of `acc` are the unread bits, most significant first (nbits ≤ 32). */
    acc = 0;
    nbits = 0;
    readonly len: number;
    /** Scratch for a compound constant type's tag list (reused; no allocation per constant). */
    private tags: number[] = [];
    private tp = 0;
    constructor(readonly b: Uint8Array, readonly lang: 1 | 2 | 3 | 4, readonly pv: number, readonly deserialiseOnly: boolean) {
        this.len = b.length;
    }
    /** Bits consumed so far. */
    get bitPos(): number { return this.i * 8 - this.nbits; }

    /** Load bytes until more than 24 bits are buffered (zeros past the end: `consume` rejects reading them). */
    private refill(): void {
        let acc = this.acc, i = this.i, nb = this.nbits;
        const b = this.b, len = this.len;
        do { acc = (acc << 8) | (i < len ? b[i]! : 0); i++; nb += 8; } while (nb <= 24);
        this.acc = acc; this.i = i; this.nbits = nb;
    }
    /** The next `n` bits (1 ≤ n ≤ 24) as an unsigned Number. */
    bits(n: number): number {
        if (this.nbits < n) this.refill();
        const nb = this.nbits - n;
        this.nbits = nb;
        if (this.i > this.len && this.i * 8 - nb > this.len * 8) throw new FlatError(OUT_OF_INPUT);
        return (this.acc >>> nb) & MASK[n]!;
    }
    /** The next 16 bits without consuming them (zeros past the end of the input). */
    peek16(): number {
        if (this.nbits < 16) this.refill();
        return (this.acc >>> (this.nbits - 16)) & 0xffff;
    }
    /** Consume `n` of the peeked bits. */
    consume(n: number): void {
        const nb = this.nbits - n;
        this.nbits = nb;
        if (this.i > this.len && this.i * 8 - nb > this.len * 8) throw new FlatError(OUT_OF_INPUT);
    }
    /** A natural number: 7-bit groups, least significant first, the high bit continues. */
    natural(): number | bigint {
        let w = this.bits(8);
        if (w < 128) return w;
        let n = w & 127, k = 1, big: bigint | null = null;
        for (;;) {
            w = this.bits(8);
            const chunk = w & 127;
            if (big === null && k <= 6) n += chunk * POW7[k]!;
            else { if (big === null) big = BigInt(n); big |= BigInt(chunk) << BigInt(7 * k); }
            k++;
            if ((w & 128) === 0) break;
        }
        return big === null ? n : big;
    }
    smallNat(): number { const n = this.natural(); if (typeof n !== "number") throw new FlatError("flat: natural too large"); return n; }
    /** A zigzag integer (`Flat Integer`). */
    integer(): bigint {
        const z = this.natural();
        if (typeof z === "number") {
            if (z < 128) return SMALL_INT[z]!;
            const half = Math.floor(z / 2);
            return z - half * 2 === 0 ? BigInt(half) : -BigInt(half) - 1n;
        }
        return (z & 1n) === 0n ? z >> 1n : -((z >> 1n) + 1n);
    }
    /**
     * Pre-aligning filler: zero bits then a one bit, ending on a byte boundary (any number of
     * zeros, as `dFiller`); a one bit anywhere else in the run is a misaligned filler.
     */
    filler(): void {
        const k = 8 - ((this.i * 8 - this.nbits) & 7); // bits to the boundary, 1..8
        let v = this.bits(k);
        while (v === 0) v = this.bits(8);
        if (v !== 1) throw new FlatError("flat: misaligned filler");
    }
    /** Byte index of the next unread byte, dropping the (byte-aligned) accumulator. Requires `bitPos % 8 === 0`. */
    private alignedIndex(): number {
        const idx = this.i - (this.nbits >>> 3);
        this.acc = 0; this.nbits = 0;
        return idx;
    }
    /** `Flat ByteString`: filler, then blocks of ≤ 255 bytes (one-byte length prefix), a zero-length block ends it. */
    byteString(): Uint8Array {
        this.filler();
        const b = this.b, len = this.len;
        let p = this.alignedIndex();
        if (p >= len) throw new FlatError(OUT_OF_INPUT);
        const n0 = b[p]!;
        if (n0 === 0) { this.i = p + 1; return new Uint8Array(0); }
        if (p + 1 + n0 >= len) throw new FlatError("flat: bytestring out of input");
        if (b[p + 1 + n0] === 0) { // one block: the common case (TypedArray slice: a copy, even of a Buffer)
            this.i = p + 2 + n0;
            return Uint8Array.prototype.slice.call(b, p + 1, p + 1 + n0);
        }
        // several blocks: measure, then copy once
        let total = 0, q = p;
        for (;;) {
            if (q >= len) throw new FlatError(OUT_OF_INPUT);
            const n = b[q]!;
            if (n === 0) { q++; break; }
            if (q + 1 + n > len) throw new FlatError("flat: bytestring out of input");
            total += n; q += 1 + n;
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (;;) {
            const n = b[p]!;
            if (n === 0) break;
            out.set(b.subarray(p + 1, p + 1 + n), o); o += n; p += 1 + n;
        }
        this.i = q;
        return out;
    }

    /** A constant's type: a list of 4-bit tags (`1 tttt … 0`), one tag for the common types. */
    type(): ConstType {
        const v = this.peek16();
        if ((v & 0x8400) === 0x8000) { // `1 tttt 0`: a single tag
            const s = SIMPLE_TYPE[(v >>> 11) & 15];
            if (s !== undefined) { this.consume(6); return s; }
        }
        if (this.bits(1) === 0) throw new FlatError("flat: empty constant type");
        const t = this.bits(4);
        if (this.bits(1) === 0) {
            const s = SIMPLE_TYPE[t];
            if (s !== undefined) return s;
            if (t === 7) throw new FlatError("flat: unsupported type application undefined");
            throw new FlatError(`flat: unsupported constant type tag ${t}`);
        }
        const tags = this.tags;
        tags.length = 0;
        tags.push(t);
        do tags.push(this.bits(4)); while (this.bits(1) === 1);
        this.tp = 0;
        const ty = this.parseType();
        if (this.tp !== tags.length) throw new FlatError("flat: trailing type tags");
        return ty;
    }
    private parseType(): ConstType {
        const tags = this.tags;
        const t = tags[this.tp++];
        if (t === 7) {
            const f = tags[this.tp++];
            if (f === 5) return ConstT.list(this.parseType());
            // arrays are not gated on the language version (plutus-core's flat decoder only knows the universe)
            if (f === 12) return ConstT.array(this.parseType());
            if (f === 7) { if (tags[this.tp++] !== 6) throw new FlatError("flat: bad type application"); const a = this.parseType(); return ConstT.pair(a, this.parseType()); }
            throw new FlatError(`flat: unsupported type application ${f}`);
        }
        const s = t === undefined ? undefined : SIMPLE_TYPE[t];
        if (s === undefined) throw new FlatError(`flat: unsupported constant type tag ${t}`);
        return s;
    }
    value(t: ConstType): any {
        switch (t.tag) {
            case 0: return this.integer();
            case 1: return this.byteString();
            case 2: return utf8(this.byteString());
            case 3: return null;
            case 4: return this.bits(1) === 1;
            case 8: { const b = this.byteString(); try { return decodeData(b) as Data; } catch (e) { throw new FlatError(`flat: bad data constant: ${(e as Error).message}`); } }
            case 5: { const a = t.a!, out: any[] = []; while (this.bits(1) === 1) out.push(this.value(a)); return mkListFromArray(out); }
            case 12: { const a = t.a!, out: any[] = []; while (this.bits(1) === 1) out.push(this.value(a)); return new VArray(out); }
            case 6: { const a = this.value(t.a!); return new VPair(a, this.value(t.b!)); }
            case 9: case 10: case 11: throw new FlatError("flat: BLS12-381 values cannot be flat-decoded");
            case 13: {
                // `Flat Value`: [(K, [(K, Quantity)])] through `buildValueWith` (keys ≤ 32 bytes, 128-bit quantities)
                const outer: Array<readonly [Uint8Array, Array<readonly [Uint8Array, bigint]>]> = [];
                while (this.bits(1) === 1) {
                    const c = this.valueKey(), inner: Array<readonly [Uint8Array, bigint]> = [];
                    while (this.bits(1) === 1) {
                        const k = this.valueKey(), q = this.integer();
                        if (q < QUANTITY_MIN || q > QUANTITY_MAX) throw new FlatError("flat: Value quantity out of signed 128-bit bounds");
                        inner.push([k, q]);
                    }
                    outer.push([c, inner]);
                }
                try { return buildValueStrict(outer, "Value Flat decoder"); } catch (e) { if (e instanceof ValueError) throw new FlatError(`flat: ${e.message}`); throw e; }
            }
        }
        throw new FlatError("flat: unsupported constant");
    }
    private valueKey(): Uint8Array { const b = this.byteString(); if (b.length > MAX_KEY_LEN) throw new FlatError("flat: invalid Value key"); return b; }
    /** A constant node's value (after its 4-bit header): the type, the value, the protocol-11 type-size bound. */
    constant(bounded: boolean): VCon {
        const ty = this.type();
        if (ty === T.unit) return UNIT_CON;
        if (ty === T.bool) return this.bits(1) === 1 ? TRUE_CON : FALSE_CON;
        const c = new VCon(ty, this.value(ty));
        if (bounded && ty.a !== undefined && constTypeSize(ty) > MAX_CONST_TYPE_SIZE) throw new FlatError(`flat: constant of type size ${constTypeSize(ty)} not available at protocol ${this.pv}`);
        return c;
    }
    /** A `constr` tag: a Word64 — a Number, or beyond 2^52 the exact bigint (it can only select no branch, but it is the result's tag). */
    constrTag(): number {
        const n = this.natural();
        if (typeof n === "bigint" && n >= TWO64) throw new FlatError("flat: constr tag too large");
        return (typeof n === "bigint" && n <= MAX_SAFE ? Number(n) : n) as number;
    }

    /** The node arrays (`Code`), grown by `term` when the estimate was short. */
    K = new Uint8Array(0); A = new Int32Array(0);

    /**
     * The term, decoded in pre-order into `K` / `A`. The common headers — a variable with
     * a one-byte index, a builtin, delay / lam / apply / force / error — are handled without a
     * branch on the tag: tables give the bits to consume, the operand's position and the number
     * of children, and a per-(language, protocol) table rejects de Bruijn index 0 and the
     * unavailable builtins; the decoder's cost was branch mispredictions on an unpredictable tag
     * stream, not the work per node. Constants, long indexes, `constr` and `case` take a switch.
     *
     * Structure: `pending` counts the child slots not yet started; a stack holds the nodes
     * waiting for a child list to end — an `apply` for its argument node (the node after its
     * function's subtree, stored in `A`), a `constr` / `case` for the continuation bit after each
     * item — each with the `pending` value at which its current child's subtree is complete
     * (strictly decreasing up the stack, so one compare per node tests the innermost). Bits are
     * read in exactly the order of the grammar, every consumption is checked against the end of
     * the input, and the bit cursor lives in locals for the whole loop (`this` is synchronised
     * around the rare reads). Returns the node count; the root is 0.
     */
    term(consts: VCon[], ctrs: ConstrNode[], cases: number[][], bigVars: number[], v110: boolean, check: Uint8Array, bounded: boolean): number {
        const b = this.b, len = this.len, limit = len * 8;
        let acc = this.acc, nbits = this.nbits, i = this.i;
        let K = this.K, A = this.A, cap = K.length;
        if (SCRATCH_P.length < cap + 1) { SCRATCH_P = new Int32Array(cap + 1); SCRATCH_T = new Int32Array(cap + 1); }
        let parents = SCRATCH_P, targets = SCRATCH_T;
        targets[0] = 0; // the root's end: no slot left
        let sp = 0, n = 0, pending = 1;
        for (;;) {
            if (nbits < 16) { do { acc = (acc << 8) | (i < len ? b[i]! : 0); i++; nbits += 8; } while (nbits <= 24); }
            const v = (acc >>> (nbits - 16)) & 0xffff;
            const tag = v >>> 12;
            if (n === cap) {
                cap <<= 1;
                const K2 = new Uint8Array(cap), A2 = new Int32Array(cap);
                K2.set(K); A2.set(A); K = this.K = K2; A = this.A = A2;
                if (parents.length < cap + 1) { const P2 = new Int32Array(cap + 1), T2 = new Int32Array(cap + 1); P2.set(parents); T2.set(targets); parents = SCRATCH_P = P2; targets = SCRATCH_T = T2; }
                continue;
            }
            const node = n++;
            K[node] = tag;
            const take = TAKE[tag]!;
            if (take !== 0 && (v & 0xf800) !== 0x0800) {
                nbits -= take;
                if (i * 8 - nbits > limit) throw new FlatError(OUT_OF_INPUT); // before judging bits that are not there
                const op = (v >>> SHIFTS[tag]!) & OPMASK[tag]!;
                if (check[(tag << 8) | op] !== 0) this.rejectHeader(tag, op);
                A[node] = op; // an apply's operand (its argument node) is set when its function's subtree ends
                pending += KIDS[tag]! - 1;
                if (tag === TK.Apply) { sp++; parents[sp] = node; targets[sp] = pending - 1; }
            } else {
                switch (tag) {
                    case TK.Var: { // an index of two bytes or more
                        nbits -= 4;
                        this.acc = acc; this.nbits = nbits; this.i = i;
                        let idx = this.smallNat();
                        acc = this.acc; nbits = this.nbits; i = this.i;
                        if (idx === 0 && !this.deserialiseOnly) throw new FlatError("flat: de Bruijn index 0");
                        if (idx > 0x7fffffff) { bigVars.push(idx); idx = -bigVars.length; }
                        A[node] = idx;
                        pending--;
                        break;
                    }
                    case TK.Const: {
                        nbits -= 4;
                        this.acc = acc; this.nbits = nbits; this.i = i;
                        consts.push(this.constant(bounded));
                        acc = this.acc; nbits = this.nbits; i = this.i;
                        A[node] = consts.length - 1;
                        pending--;
                        break;
                    }
                    case TK.Constr: {
                        nbits -= 4;
                        if (!v110) throw new FlatError("flat: constr needs Plutus Core 1.1.0");
                        this.acc = acc; this.nbits = nbits; this.i = i;
                        const ct: ConstrNode = { tag: this.constrTag(), fields: [] };
                        const more = this.bits(1) === 1; // a first field follows
                        acc = this.acc; nbits = this.nbits; i = this.i;
                        ctrs.push(ct);
                        A[node] = ctrs.length - 1;
                        pending--;
                        if (more) { ct.fields.push(node + 1); sp++; parents[sp] = node; targets[sp] = pending; pending++; }
                        break;
                    }
                    case TK.Case: {
                        nbits -= 4;
                        if (!v110) throw new FlatError("flat: case needs Plutus Core 1.1.0");
                        cases.push([]);
                        A[node] = cases.length - 1;
                        // the scrutinee is the next node (one slot, replacing this node's); branches follow continuation bits
                        sp++; parents[sp] = node; targets[sp] = pending - 1;
                        break;
                    }
                    default: throw new FlatError(`flat: unknown term tag ${tag}`);
                }
                if (i * 8 - nbits > limit) throw new FlatError(OUT_OF_INPUT);
            }
            // child lists that end here
            while (pending === targets[sp]) {
                if (sp === 0) { this.acc = acc; this.nbits = nbits; this.i = i; return n; }
                const p = parents[sp]!, pk = K[p];
                if (pk === TK.Apply) { A[p] = n; sp--; continue; }
                // constr / case: the list continuation bit after each item
                if (nbits < 1) { do { acc = (acc << 8) | (i < len ? b[i]! : 0); i++; nbits += 8; } while (nbits <= 24); }
                nbits--;
                if (i * 8 - nbits > limit) throw new FlatError(OUT_OF_INPUT);
                const cont = ((acc >>> nbits) & 1) === 1;
                if (pk === TK.Constr) {
                    const fields = ctrs[A[p]!]!.fields;
                    if (cont) { fields.push(n); pending++; break; }
                    if (bounded && fields.length > MAX_CONSTR_FIELDS) throw new FlatError(`flat: constr with ${fields.length} fields not available at protocol ${this.pv}`);
                } else if (cont) { cases[A[p]!]!.push(n); pending++; break; }
                sp--;
            }
        }
    }
    private rejectHeader(tag: number, op: number): never {
        if (tag === TK.Var) throw new FlatError("flat: de Bruijn index 0");
        throw new FlatError(`flat: builtin ${op} not available in Plutus V${this.lang} at protocol ${this.pv}`);
    }
}

/**
 * `deserialiseOnly`: what plutus-ledger-api `deserialiseScript` checks (phase 1, the ledger's
 * `isValidPlutusScript`) and nothing that `mkTermToEvaluate` checks at evaluation: any Plutus Core
 * version decodes (`constr` / `case` need the program's version ≥ 1.1.0, as in the UPLC flat
 * decoder), the version's availability for the language and de Bruijn index 0 (scope) are not
 * checked. Default: the evaluator's full set.
 */
export function decodeProgram(bytes: Uint8Array, lang: 1 | 2 | 3 | 4, pv: number, opts: { deserialiseOnly?: boolean } = {}): Program {
    const r = new FlatReader(bytes, lang, pv, opts.deserialiseOnly === true);
    const version: [number, number, number] = [r.smallNat(), r.smallNat(), r.smallNat()];
    let v110: boolean;
    if (opts.deserialiseOnly) v110 = version[0] > 1 || (version[0] === 1 && version[1] >= 1);
    else {
        const vkey = version.join(".");
        if (vkey !== "1.0.0" && vkey !== "1.1.0" && !(vkey === "1.2.0" && plc120Available(lang, pv))) throw new FlatError(`flat: unsupported Plutus Core version ${vkey}`);
        if (vkey === "1.1.0" && !plc110Available(lang, pv)) throw new FlatError(`flat: Plutus Core 1.1.0 not available in Plutus V${lang} at protocol ${pv}`);
        v110 = vkey === "1.1.0" || vkey === "1.2.0";
    }
    // nodes are about as many as bytes in compiled scripts (one node per 4 to 12 bits); `term` grows the arrays when a program has more
    const cap = bytes.length + (bytes.length >>> 2) + 16;
    r.K = new Uint8Array(cap); r.A = new Int32Array(cap);
    const consts: VCon[] = [], ctrs: ConstrNode[] = [], cases: number[][] = [], bigVars: number[] = [];
    const n = r.term(consts, ctrs, cases, bigVars, v110, headerCheck(lang, pv, r.deserialiseOnly), pv >= 11);
    r.filler();
    if (r.bitPos !== bytes.length * 8) throw new FlatError("flat: trailing bytes after program");
    return new Program(version, new Code(r.K, r.A, n, consts, ctrs, cases, bigVars), 0);
}

/** The first child of a node with children. */
function firstChild(c: Code, t: number): number {
    const k = c.K[t]!;
    if (k === TK_APPLY_X) return c.xapps[c.A[t]!]!.f;
    if (k === TK.Constr) return c.ctrs[c.A[t]!]!.fields[0]!;
    return t + 1;
}

/** The object term rooted at `root` (iterative: a 200 000-deep program must not overflow the stack). */
export function materialise(c: Code, root: number): Term {
    const K = c.K, A = c.A;
    const parents: Term[] = [], nodes: number[] = [], pos: number[] = [];
    let sp = 0, t = root;
    for (;;) {
        const k = K[t]!;
        let node: Term, leaf = true;
        switch (k) {
            case TK.Var: { const i = A[t]!; node = { k: TK.Var, i: i < 0 ? c.bigVars[-1 - i]! : i }; break; }
            case TK.Delay: node = { k: TK.Delay, b: null as unknown as Term }; leaf = false; break;
            case TK.Lam: node = { k: TK.Lam, b: null as unknown as Term }; leaf = false; break;
            case TK.Force: node = { k: TK.Force, b: null as unknown as Term }; leaf = false; break;
            case TK.Apply: case TK_APPLY_X: node = { k: TK.Apply, f: null as unknown as Term, a: null as unknown as Term }; leaf = false; break;
            case TK.Const: node = { k: TK.Const, v: c.consts[A[t]!]! }; break;
            case TK.Error: node = { k: TK.Error }; break;
            case TK.Builtin: node = { k: TK.Builtin, fn: A[t]! }; break;
            case TK.Constr: { const ct = c.ctrs[A[t]!]!; node = { k: TK.Constr, tag: ct.tag, fields: [] }; leaf = ct.fields.length === 0; break; }
            case TK.Case: node = { k: TK.Case, s: null as unknown as Term, bs: [] }; leaf = false; break;
            default: throw new Error(`flat: unknown node kind ${k}`);
        }
        if (!leaf) { parents[sp] = node; nodes[sp] = t; pos[sp] = 0; sp++; t = firstChild(c, t); continue; }
        let child: Term = node;
        for (;;) {
            if (sp === 0) return child;
            const p = parents[sp - 1]!, pn = nodes[sp - 1]!, i = pos[sp - 1]!;
            let next = -1;
            switch (p.k) {
                case TK.Delay: case TK.Lam: case TK.Force: p.b = child; break;
                case TK.Apply: if (i === 0) { p.f = child; next = K[pn] === TK_APPLY_X ? c.xapps[A[pn]!]!.a : A[pn]!; } else p.a = child; break;
                case TK.Constr: { p.fields.push(child); const fs = c.ctrs[A[pn]!]!.fields; if (i + 1 < fs.length) next = fs[i + 1]!; break; }
                case TK.Case: { if (i === 0) p.s = child; else p.bs.push(child); const bs = c.cases[A[pn]!]!; if (i < bs.length) next = bs[i]!; break; }
            }
            pos[sp - 1] = i + 1;
            if (next >= 0) { t = next; break; }
            sp--; child = p;
        }
    }
}

/** Growable `Code` under construction (compiled object terms, `applyData`). */
class CodeBuilder {
    K: Uint8Array; A: Int32Array;
    n = 0;
    readonly consts: VCon[] = []; readonly ctrs: ConstrNode[] = []; readonly cases: number[][] = []; readonly bigVars: number[] = [];
    constructor(cap: number) { this.K = new Uint8Array(cap); this.A = new Int32Array(cap); }
    alloc(k: number): number {
        if (this.n === this.K.length) {
            const cap = this.K.length * 2;
            const K = new Uint8Array(cap), A = new Int32Array(cap);
            K.set(this.K); A.set(this.A);
            this.K = K; this.A = A;
        }
        const t = this.n++;
        this.K[t] = k;
        return t;
    }
    /** Emit `t` and its subtree (pre-order: a body always lands at its parent's index + 1). */
    emit(t: Term): number {
        const node = this.alloc(t.k);
        switch (t.k) {
            case TK.Var: { let i = t.i; if (i > 0x7fffffff) { this.bigVars.push(i); i = -this.bigVars.length; } this.A[node] = i; break; }
            case TK.Delay: case TK.Lam: case TK.Force: this.emit(t.b); break;
            case TK.Apply: { this.emit(t.f); const a = this.emit(t.a); this.A[node] = a; break; } // the function lands at node + 1
            case TK.Const: this.A[node] = this.consts.push(t.v) - 1; break;
            case TK.Error: break;
            case TK.Builtin: this.A[node] = t.fn; break;
            case TK.Constr: { const ct: ConstrNode = { tag: t.tag, fields: [] }; this.A[node] = this.ctrs.push(ct) - 1; for (const f of t.fields) ct.fields.push(this.emit(f)); break; }
            case TK.Case: { const bs: number[] = []; this.A[node] = this.cases.push(bs) - 1; this.emit(t.s); for (const b of t.bs) bs.push(this.emit(b)); break; }
        }
        return node;
    }
    finish(): Code { return new Code(this.K, this.A, this.n, this.consts, this.ctrs, this.cases, this.bigVars); }
}

/** An object term as a program (the text parser's output; tests). Recursive: as deep as the parser goes. */
export function compileTerm(t: Term, version: [number, number, number] = [1, 0, 0]): Program {
    const cb = new CodeBuilder(64);
    const root = cb.emit(t);
    return new Program(version, cb.finish(), root);
}

/**
 * `[... [[p d1] d2] ...]`: the program applied to Data constants (the datum, redeemer and script
 * context of phase 2). A copy: the decoded program is cached and shared, the result is per redeemer.
 */
export function applyData(p: Program, args: readonly Data[]): Program {
    const c = p.code, k = args.length;
    const cap = c.n + 2 * k;
    const K = new Uint8Array(cap), A = new Int32Array(cap);
    K.set(c.K.subarray(0, c.n)); A.set(c.A.subarray(0, c.n));
    const consts = c.consts.slice(), xapps = c.xapps.slice();
    let root = p.root, n = c.n;
    for (const d of args) {
        const con = n++, app = n++;
        K[con] = TK.Const; A[con] = consts.push(new VCon(T.data, d)) - 1;
        K[app] = TK_APPLY_X; A[app] = xapps.push({ f: root, a: con }) - 1;
        root = app;
    }
    return new Program(p.version, new Code(K, A, n, consts, c.ctrs, c.cases, c.bigVars, xapps), root);
}
