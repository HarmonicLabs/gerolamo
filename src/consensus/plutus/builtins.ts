/**
 * Builtin functions for the evaluator (cek.ts).
 *
 * The frequent builtins (integers, bytestrings, strings, control, pairs, lists, data, hashes)
 * are implemented here on the evaluator's own values, charging exactly what plutus-machine's
 * patched BnCEK charges (argument sizes as `ExMemoryUsage`; sizes are only computed for cost
 * functions that are not constant). The rarely used ones (signatures, BLS12-381, bitwise,
 * integer/bytestring conversion) are delegated to BnCEK, converting the arguments to its
 * constants and back, so their semantics stay the verified ones. Batch 6 (arrays, expModInteger, the
 * BLS12-381 multi-scalar multiplications, the Value builtins of multiasset.ts) is native, and so
 * are the protocol-11 argument bounds of variants D/E (`BuiltinCtx.bounded`), which plutus-machine
 * predates. Semantics: plutus-core 1.63.0.0 (cardano-node 11.0.1); conformance.test.ts runs its suite.
 *
 * Costs are charged before the builtin's denotation runs, as in plutus-core: a builtin whose
 * cost exceeds the remaining budget never runs (this bounds the quadratic BigInt arithmetic).
 *
 * Arguments are positional (`a0 … a5`): a partial application is one `VBuiltin` holding them,
 * saturation calls the implementation directly, no array is built per application.
 */
import { settings } from "../../config/settings";
import { BnCEK } from "@harmoniclabs/plutus-machine/dist/BnCEK/BnCEK.js";
import { CEKConst } from "@harmoniclabs/plutus-machine/dist/CEKValue/CEKConst.js";
import { CEKError } from "@harmoniclabs/plutus-machine/dist/CEKValue/CEKError.js";
import { costModelV3ToBuiltinCosts, legacyIntegerCosts } from "@harmoniclabs/plutus-machine/dist/Machine/BuiltinCosts/BuiltinCosts.js";
import { defaultV3Costs } from "@harmoniclabs/cardano-costmodels-ts";
import { ByteString } from "@harmoniclabs/bytestring";
import { Pair } from "@harmoniclabs/pair";
import { DataB, DataConstr, DataI, DataList, DataMap, DataPair } from "@harmoniclabs/plutus-data";
import { sha256 } from "@noble/hashes/sha2";
import { sha3_256, keccak_256 } from "@noble/hashes/sha3";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { BlsG1, BlsG2, bls12_381_G1_add, bls12_381_G1_scalarMul, bls12_381_G2_add, bls12_381_G2_scalarMul, isBlsG1, isBlsG2 } from "@harmoniclabs/crypto";
import {
    DBytes, DConstr, DInt, DK, DList, DMap, DPair, type Data,
    bytesEq, bytesSize, dataEq, dataSize, encodeData, fromLibData, intSize as intSizeExact,
} from "./data";
import {
    ConstT, EMPTY_LIST, FALSE, LArr, LCons, T, TRUE, T_LIST_DATA, T_LIST_PAIR_DATA, T_PAIR_DATA, T_PAIR_INT_LIST_DATA, UNIT,
    VArray, VBuiltin, VCon, VPair, listHead, listIsEmpty, listTail, listToArray, mkListFromArray,
    type ConstType, type List, type Value,
} from "./values";
import { clampNum, variantBoundsBytes, variantBoundsIntegers, variantTextByBytes, type BuiltinCost, type CostTable } from "./costs";
import { blake2b_224, blake2b_256 } from "./blake2b";
import {
    VValue, ValueError, dataNodeCount, insertCoin, lookupCoin, scaleValue, unValueData, unionValue, valueContains, valueData, valueMaxDepth,
} from "./multiasset";

export class EvalFailure extends Error {}
/** An evaluator limitation (a builtin this evaluator does not implement): no verdict, never a script failure. */
export class EvalUnsupported extends Error {}
export class BudgetExceeded extends Error { constructor(readonly cpu: number, readonly mem: number) { super("execution budget exceeded"); } }
const fail = (msg: string): never => { throw new EvalFailure(msg); };

/** BigInt cost lookup for the builtins delegated to plutus-machine (same named parameters). */
function bigLookup(costs: CostTable): (tag: number) => any {
    const anyCosts = costs as any;
    if (anyCosts._big) return anyCosts._big;
    const v3: Record<string, number> = { ...(defaultV3Costs as any) };
    for (const [k, v] of costs.named) if (k in v3) v3[k] = clampNum(v);
    let lookup: (tag: number) => any = costModelV3ToBuiltinCosts(v3 as any);
    if (costs.lang < 3) { const legacy: Record<string, number> = {}; for (const [k, v] of costs.named) legacy[k] = clampNum(v); lookup = legacyIntegerCosts(legacy, lookup); }
    Object.defineProperty(anyCosts, "_big", { value: lookup, enumerable: false });
    return lookup;
}

/**
 * The machine's budget counters and semantics flags, shared with the builtins. The machine keeps
 * `cpu` / `mem` in locals while it steps and writes them here around a builtin call; `spend`
 * charges and fails when the budget is exceeded (before the builtin runs).
 */
export class BuiltinCtx {
    cpu = 0;
    mem = 0;
    maxCpu = 0;
    maxMem = 0;
    /** Plutus V1/V2 semantics variant (consByteString wraps the byte). */
    readonly legacy: boolean;
    /** Variants D/E (protocol 11): appendString / equalsString / encodeUtf8 cost their text by UTF-8 byte length `quot` 4 (`TextCostedByByteLength`). */
    readonly textByBytes: boolean;
    /**
     * Variants D/E (protocol 11, plutus-core `ensurable`): the integer arguments of the arithmetic
     * builtins must lie in [−2^262143, 2^262143 − 1] (`CInteger`), the bytestring arguments of the
     * bytestring/hash/bitwise builtins be at most 65536 bytes (`CByteString`), constrData's tag a
     * Word64, shift/rotate amounts an Int, writeBits' input at most 4096 bytes and the BLS12-381
     * scalars at most 4096 bits; an argument outside is an evaluation failure.
     */
    readonly bounded: boolean;
    /**
     * `ensurableInteger`: the `CInteger` bound of the arithmetic builtins and consByteString,
     * variants D/E only. Variants F/G (protocol 12) keep every other bound of `bounded` but not
     * this one (bug 434).
     */
    readonly boundedInt: boolean;
    private bn: BnCEK | null = null;
    constructor(readonly costs: CostTable, readonly logs: string[] | null) {
        this.legacy = costs.lang < 3;
        this.textByBytes = variantTextByBytes(costs.variant);
        this.bounded = variantBoundsBytes(costs.variant);
        this.boundedInt = variantBoundsIntegers(costs.variant);
    }
    spend(c: number, m: number): void {
        const cpu = (this.cpu += c), mem = (this.mem += m);
        if (cpu > this.maxCpu || mem > this.maxMem) throw new BudgetExceeded(cpu, mem);
    }
    /** plutus-machine's BigInt cost lookup, for the delegated builtins. */
    get bnCek(): BnCEK { return (this.bn ??= newBnCek(this, bigLookup(this.costs))); }
}

/** [forces, arguments] per flat builtin tag (0 … 100). */
export const SIGNATURE: Array<[number, number]> = [];
const sig = (tags: number[], forces: number, args: number) => { for (const t of tags) SIGNATURE[t] = [forces, args]; };
sig([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 22, 23, 37, 47, 48, 74, 79, 81, 82, 83], 0, 2);
sig([12, 21, 52, 53, 73, 75, 76, 77, 80], 0, 3);
sig([13, 18, 19, 20, 24, 25, 38, 39, 40, 41, 42, 43, 44, 45, 46, 49, 50, 51, 71, 72, 78, 84, 85, 86], 0, 1);
// BLS12-381 in plutus-core flat-tag order (54 G1_add, 55 neg, 56 scalarMul, 57 equal, 58 compress, 59 uncompress,
// 60 hashToGroup, 61–67 the same for G2, 68 millerLoop, 69 mulMlResult, 70 finalVerify) — not @harmoniclabs/uplc's enum order
sig([54, 56, 57, 60, 61, 63, 64, 67, 68, 69, 70], 0, 2);
sig([55, 58, 59, 62, 65, 66], 0, 1);
sig([26], 1, 3); sig([27, 28], 1, 2); sig([29, 30], 2, 1); sig([31], 2, 3); sig([32], 1, 2); sig([33, 34, 35], 1, 1); sig([36], 1, 6);
// batch 6: expModInteger (3 args), dropList / indexArray (1 force, 2 args), lengthOfArray / listToArray (1 force, 1 arg)
sig([87], 0, 3); sig([88, 91], 1, 2); sig([89, 90], 1, 1);
// multi-scalar multiplications (2 args); Value builtins: insertCoin 4, lookupCoin 3, unionValue / valueContains / scaleValue 2, valueData / unValueData 1
sig([92, 93, 96, 97, 100], 0, 2); sig([94], 0, 4); sig([95], 0, 3); sig([98, 99], 0, 1);
/** Arity per tag as a dense table (−1: no such builtin). */
export const ARITY: Int8Array = new Int8Array(128).fill(-1);
for (let t = 0; t < SIGNATURE.length; t++) if (SIGNATURE[t]) ARITY[t] = SIGNATURE[t]![1];

// ── argument access ──
function con(v: Value, t: ConstType, name: string): any {
    if (!(v instanceof VCon) || (v as VCon).type !== t) fail(`${name}: argument is not ${t.key}`);
    return (v as VCon).v;
}
const int = (v: Value, n: string): bigint => con(v, T.int, n);
const bytes = (v: Value, n: string): Uint8Array => con(v, T.bytes, n);
const str = (v: Value, n: string): string => con(v, T.string, n);
const data = (v: Value, n: string): Data => con(v, T.data, n);
/** A list argument: the constant itself (its `type` is the list type, its `v` the list). */
function listArg(v: Value, n: string): VCon {
    if (!(v instanceof VCon) || (v as VCon).type.tag !== 5) fail(`${n}: argument is not a list`);
    return v as VCon;
}
/**
 * `ExMemoryUsage Integer` (data.ts `intSize`) with a fast path for the common case: an integer whose
 * Number is within ±9.2 × 10^18 is below 2^63 in magnitude (a double rounds to within 1 part in 2^53, and
 * 9.2 × 10^18 × (1 + 2^−52) < 2^63 ≈ 9.223 × 10^18), so it is one word; the two BigInt comparisons of the
 * exact form cost twice this conversion. Everything else is measured exactly.
 */
function intSize(n: bigint): number { const d = Number(n); return d < 9.2e18 && d > -9.2e18 ? 1 : intSizeExact(n); }
function strSize(s: string): number { let n = 0; for (const _ of s) n++; return n; }
const utf8Len = (s: string) => Buffer.byteLength(s, "utf8");
/** Text size of the string builtins: characters, or (variants D/E) UTF-8 bytes `quot` 4. */
const textSize = (ctx: BuiltinCtx, s: string) => (ctx.textByBytes ? Math.floor(utf8Len(s) / 4) : strSize(s));
/**
 * `ExMemoryUsage` of a constant value of type t. A list measures its length and a pair maxBound
 * (plutus-core: `instance ExMemoryUsage [a]` has no element constraint; pairs are only ever
 * arguments of constant-cost builtins); a Value its total number of entries.
 */
function valueSize(t: ConstType, v: any): number {
    switch (t.tag) {
        case 0: return intSize(v);
        case 1: return bytesSize(v);
        case 2: return strSize(v);
        case 3: case 4: return 1;
        case 8: return dataSize(v);
        case 5: return listLength(v);
        case 6: return Number.MAX_SAFE_INTEGER;
        case 9: return 18; case 10: return 36; case 11: return 72;
        case 12: return (v as VArray).arr.length;
        case 13: return (v as VValue).total;
    }
    return 1;
}
function listLength(l: List): number {
    let n = 0, c: List = l;
    while (c instanceof LCons) { n++; c = c.tail; }
    return n + Math.max(0, c.arr.length - c.off);
}

// ── charging: constant costs skip the sizes; the eager forms take sizes the caller computed only when needed ──
function spend1(ctx: BuiltinCtx, c: BuiltinCost, sx: number) { ctx.spend(c.cc >= 0 ? c.cc : c.cpu.at(sx, 0, 0), c.cm >= 0 ? c.cm : c.mem.at(sx, 0, 0)); }
function spend2(ctx: BuiltinCtx, c: BuiltinCost, sx: number, sy: number) { ctx.spend(c.cc >= 0 ? c.cc : c.cpu.at(sx, sy, 0), c.cm >= 0 ? c.cm : c.mem.at(sx, sy, 0)); }
function spend3(ctx: BuiltinCtx, c: BuiltinCost, sx: number, sy: number, sz: number) { ctx.spend(c.cc >= 0 ? c.cc : c.cpu.at(sx, sy, sz), c.cm >= 0 ? c.cm : c.mem.at(sx, sy, sz)); }
function spend4(ctx: BuiltinCtx, c: BuiltinCost, sx: number, sy: number, sz: number, su: number) { ctx.spend(c.cc >= 0 ? c.cc : c.cpu.at(sx, sy, sz, su), c.cm >= 0 ? c.cm : c.mem.at(sx, sy, sz, su)); }
/** Lazy forms for the rarely used builtins (closures are only called when a size is needed). */
function charge1(ctx: BuiltinCtx, c: BuiltinCost, x: () => number) { if (c.k) ctx.spend(c.cc, c.cm); else spend1(ctx, c, x()); }
function charge2(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number) { if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, x(), y()); }
function charge3(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number, z: () => number) { if (c.k) ctx.spend(c.cc, c.cm); else spend3(ctx, c, x(), y(), z()); }
function charge4(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number, z: () => number, u: () => number) { if (c.k) ctx.spend(c.cc, c.cm); else spend4(ctx, c, x(), y(), z(), u()); }
// typed eager forms for the frequent builtins
function chargeInt2(ctx: BuiltinCtx, c: BuiltinCost, x: bigint, y: bigint) { if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, intSize(x), intSize(y)); }
function chargeBytes1(ctx: BuiltinCtx, c: BuiltinCost, x: Uint8Array) { if (c.k) ctx.spend(c.cc, c.cm); else spend1(ctx, c, bytesSize(x)); }
function chargeBytes2(ctx: BuiltinCtx, c: BuiltinCost, x: Uint8Array, y: Uint8Array) { if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, bytesSize(x), bytesSize(y)); }
function chargeData1(ctx: BuiltinCtx, c: BuiltinCost, d: Data) { if (c.k) ctx.spend(c.cc, c.cm); else spend1(ctx, c, dataSize(d)); }
function chargeData2(ctx: BuiltinCtx, c: BuiltinCost, x: Data, y: Data) { if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, dataSize(x), dataSize(y)); }
/** One constant argument of any type (lists measure their length only when the cost varies). */
function chargeCon1(ctx: BuiltinCtx, c: BuiltinCost, v: VCon) { if (c.k) ctx.spend(c.cc, c.cm); else spend1(ctx, c, valueSize(v.type, v.v)); }
const one = () => 1;
// ── protocol-11 argument bounds (BuiltinCtx.bounded; PlutusCore.Default.Universe.Cardano) ──
const CINT_MAX = (1n << 262143n) - 1n, CINT_MIN = -(1n << 262143n), CBS_MAX = 65536;
/** A `CInteger` argument (variants D/E). */
function cint(ctx: BuiltinCtx, n: bigint, name: string): bigint { if (ctx.boundedInt && (n > CINT_MAX || n < CINT_MIN)) fail(`${name}: Integer out of bounds`); return n; }
/** A `CByteString` argument (variants D/E). */
function cbs(ctx: BuiltinCtx, b: Uint8Array, name: string): Uint8Array { if (ctx.bounded && b.length > CBS_MAX) fail(`${name}: ByteString overflow`); return b; }
const vInt = (n: bigint) => new VCon(T.int, n);
const vBytes = (b: Uint8Array) => new VCon(T.bytes, b);
const vBool = (b: boolean) => (b ? TRUE : FALSE);
const vData = (d: Data) => new VCon(T.data, d);
const INT64_MIN = -(1n << 63n), INT64_MAX = (1n << 63n) - 1n;
function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function hsQuot(a: bigint, b: bigint) { return a / b; }
function hsDiv(a: bigint, b: bigint) { const q = a / b; return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q; }
function hsMod(a: bigint, b: bigint) { const r = a % b; return r !== 0n && ((r < 0n) !== (b < 0n)) ? r + b : r; }
const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8enc = new TextEncoder();

/** A saturated builtin: its arguments positional (only the first `arity` are passed). */
type Impl = (ctx: BuiltinCtx, c: BuiltinCost, a0: Value, a1: Value, a2: Value, a3: Value, a4: Value, a5: Value) => Value;
const IMPL: Array<Impl | undefined> = [];
const def = (tag: number, f: (ctx: BuiltinCtx, c: BuiltinCost, ...a: any[]) => Value) => { IMPL[tag] = f as Impl; };
function intOp(tag: number, name: string, op: (x: bigint, y: bigint) => bigint, divLike = false) {
    def(tag, (ctx, c, a0: Value, a1: Value) => {
        const x = cint(ctx, int(a0, name), name), y = cint(ctx, int(a1, name), name);
        chargeInt2(ctx, c, x, y);
        if (divLike && y === 0n) fail(`${name}: division by zero`);
        return vInt(op(x, y));
    });
}
intOp(0, "addInteger", (x, y) => x + y);
intOp(1, "subtractInteger", (x, y) => x - y);
intOp(2, "multiplyInteger", (x, y) => x * y);
intOp(3, "divideInteger", hsDiv, true);
intOp(4, "quotientInteger", hsQuot, true);
intOp(5, "remainderInteger", (x, y) => x % y, true);
intOp(6, "modInteger", hsMod, true);
function intCmp(tag: number, name: string, op: (x: bigint, y: bigint) => boolean, bounded = true) {
    def(tag, (ctx, c, a0: Value, a1: Value) => {
        let x = int(a0, name), y = int(a1, name);
        if (bounded) { x = cint(ctx, x, name); y = cint(ctx, y, name); }
        chargeInt2(ctx, c, x, y); return vBool(op(x, y));
    });
}
intCmp(7, "equalsInteger", (x, y) => x === y, false); // plain Integer in every variant
intCmp(8, "lessThanInteger", (x, y) => x < y);
intCmp(9, "lessThanEqualsInteger", (x, y) => x <= y);
def(10, (ctx, c, a0, a1) => { const x = cbs(ctx, bytes(a0, "appendByteString"), "appendByteString"), y = cbs(ctx, bytes(a1, "appendByteString"), "appendByteString"); chargeBytes2(ctx, c, x, y); return vBytes(concat(x, y)); });
def(11, (ctx, c, a0, a1) => {
    // D: CInteger (reduced mod 256); E: Word8; both: CByteString
    const n = cint(ctx, int(a0, "consByteString"), "consByteString"), b = cbs(ctx, bytes(a1, "consByteString"), "consByteString");
    if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, intSize(n), bytesSize(b));
    let byte: bigint;
    if (ctx.legacy) byte = ((n % 256n) + 256n) % 256n;
    else { if (n < 0n || n > 255n) fail("consByteString: byte out of range"); byte = n; }
    const o = new Uint8Array(b.length + 1); o[0] = Number(byte); o.set(b, 1);
    return vBytes(o);
});
def(12, (ctx, c, a0, a1, a2) => {
    const s = int(a0, "sliceByteString"), n = int(a1, "sliceByteString"), b = cbs(ctx, bytes(a2, "sliceByteString"), "sliceByteString");
    if (c.k) ctx.spend(c.cc, c.cm); else spend3(ctx, c, intSize(s), intSize(n), bytesSize(b));
    if (s < INT64_MIN || s > INT64_MAX || n < INT64_MIN || n > INT64_MAX) fail("sliceByteString: argument outside Int");
    const len = BigInt(b.length);
    const i = s < 0n ? 0n : s > len ? len : s;
    const e = i + (n < 0n ? 0n : n);
    const j = e > len ? len : e;
    return vBytes(b.subarray(Number(i), Number(j)));
});
def(13, (ctx, c, a0) => { const b = bytes(a0, "lengthOfByteString"); chargeBytes1(ctx, c, b); return vInt(BigInt(b.length)); });
def(14, (ctx, c, a0, a1) => {
    const b = cbs(ctx, bytes(a0, "indexByteString"), "indexByteString"), i = int(a1, "indexByteString");
    if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, bytesSize(b), intSize(i));
    if (i < 0n || i >= BigInt(b.length)) fail("indexByteString: index out of range");
    return vInt(BigInt(b[Number(i)]!));
});
def(15, (ctx, c, a0, a1) => { const x = cbs(ctx, bytes(a0, "equalsByteString"), "equalsByteString"), y = cbs(ctx, bytes(a1, "equalsByteString"), "equalsByteString"); chargeBytes2(ctx, c, x, y); return vBool(bytesEq(x, y)); });
def(16, (ctx, c, a0, a1) => { const x = cbs(ctx, bytes(a0, "lessThanByteString"), "lessThanByteString"), y = cbs(ctx, bytes(a1, "lessThanByteString"), "lessThanByteString"); chargeBytes2(ctx, c, x, y); return vBool(compareBytes(x, y) < 0); });
def(17, (ctx, c, a0, a1) => { const x = cbs(ctx, bytes(a0, "lessThanEqualsByteString"), "lessThanEqualsByteString"), y = cbs(ctx, bytes(a1, "lessThanEqualsByteString"), "lessThanEqualsByteString"); chargeBytes2(ctx, c, x, y); return vBool(compareBytes(x, y) <= 0); });
function hash(tag: number, name: string, f: (b: Uint8Array) => Uint8Array) {
    // every hash takes a CByteString in variants D/E
    def(tag, (ctx, c, a0: Value) => { const b = cbs(ctx, bytes(a0, name), name); chargeBytes1(ctx, c, b); return vBytes(f(b)); });
}
hash(18, "sha2_256", (b) => sha256(b));
hash(19, "sha3_256", (b) => sha3_256(b));
// blake2b_256 is the hash on-chain scripts call (tens of times per evaluation, on 32–64 bytes): the one-shot
// implementation of blake2b.ts, through its own definition so the call is monomorphic
def(20, (ctx, c, a0) => { const b = cbs(ctx, bytes(a0, "blake2b_256"), "blake2b_256"); chargeBytes1(ctx, c, b); return vBytes(blake2b_256(b)); });
hash(71, "keccak_256", (b) => keccak_256(b));
hash(72, "blake2b_224", (b) => blake2b_224(b));
def(22, (ctx, c, a0, a1) => { const x = str(a0, "appendString"), y = str(a1, "appendString"); charge2(ctx, c, () => textSize(ctx, x), () => textSize(ctx, y)); return new VCon(T.string, x + y); });
def(23, (ctx, c, a0, a1) => { const x = str(a0, "equalsString"), y = str(a1, "equalsString"); charge2(ctx, c, () => textSize(ctx, x), () => textSize(ctx, y)); return vBool(x === y); });
def(24, (ctx, c, a0) => { const x = str(a0, "encodeUtf8"); charge1(ctx, c, () => textSize(ctx, x)); return vBytes(utf8enc.encode(x)); });
def(25, (ctx, c, a0) => {
    const b = cbs(ctx, bytes(a0, "decodeUtf8"), "decodeUtf8");
    chargeBytes1(ctx, c, b);
    let s = ""; try { s = utf8.decode(b); } catch { fail("decodeUtf8: invalid UTF-8"); }
    return new VCon(T.string, s);
});
def(26, (ctx, c, a0, a1, a2) => { const b = con(a0, T.bool, "ifThenElse"); if (c.k) ctx.spend(c.cc, c.cm); else spend3(ctx, c, 1, 1, 1); return b ? a1 : a2; });
def(27, (ctx, c, a0, a1) => { con(a0, T.unit, "chooseUnit"); if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, 1, 1); return a1; });
def(28, (ctx, c, a0, a1) => { const s = str(a0, "trace"); if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, strSize(s), 1); if (ctx.logs && ctx.logs.length < 64) ctx.logs.push(s); return a1; });
function pairArg(v: Value, n: string): VCon { if (!(v instanceof VCon) || (v as VCon).type.tag !== 6) fail(`${n}: argument is not a pair`); return v as VCon; }
def(29, (ctx, c, a0) => { const p = pairArg(a0, "fstPair"); chargeCon1(ctx, c, p); return new VCon(p.type.a!, p.v.fst); });
def(30, (ctx, c, a0) => { const p = pairArg(a0, "sndPair"); chargeCon1(ctx, c, p); return new VCon(p.type.b!, p.v.snd); });
def(31, (ctx, c, a0, a1, a2) => { const l = listArg(a0, "chooseList"); if (c.k) ctx.spend(c.cc, c.cm); else spend3(ctx, c, valueSize(l.type, l.v), 1, 1); return listIsEmpty(l.v) ? a1 : a2; });
def(32, (ctx, c, a0, a1) => {
    const x = a0, l = listArg(a1, "mkCons");
    if (!(x instanceof VCon) || (x as VCon).type !== l.type.a) fail("mkCons: element type differs from the list's");
    if (c.k) ctx.spend(c.cc, c.cm); else spend2(ctx, c, valueSize((x as VCon).type, (x as VCon).v), valueSize(l.type, l.v));
    return new VCon(l.type, new LCons((x as VCon).v, l.v));
});
def(33, (ctx, c, a0) => { const l = listArg(a0, "headList"); chargeCon1(ctx, c, l); if (listIsEmpty(l.v)) fail("headList: empty list"); return new VCon(l.type.a!, listHead(l.v)); });
def(34, (ctx, c, a0) => { const l = listArg(a0, "tailList"); chargeCon1(ctx, c, l); if (listIsEmpty(l.v)) fail("tailList: empty list"); return new VCon(l.type, listTail(l.v)); });
def(35, (ctx, c, a0) => { const l = listArg(a0, "nullList"); chargeCon1(ctx, c, l); return vBool(listIsEmpty(l.v)); });
def(36, (ctx, c, a0, a1, a2, a3, a4, a5) => {
    const d = data(a0, "chooseData");
    chargeData1(ctx, c, d);
    switch (d.k) { case DK.Constr: return a1; case DK.Map: return a2; case DK.List: return a3; case DK.Int: return a4; default: return a5; }
});
def(37, (ctx, c, a0, a1) => {
    const i = int(a0, "constrData");
    const v = a1;
    // variants D/E: the tag is a Word64
    if (ctx.bounded && (i < 0n || i >= 1n << 64n)) fail("constrData: tag outside Word64");
    if (!(v instanceof VCon) || (v as VCon).type !== T_LIST_DATA) fail("constrData: fields are not a list of data");
    const fields = listToArray((v as VCon).v) as Data[];
    charge2(ctx, c, () => intSize(i), () => fields.reduce((s, f) => s + dataSize(f), 0));
    return vData(new DConstr(i, fields));
});
def(38, (ctx, c, a0) => {
    const v = a0;
    if (!(v instanceof VCon) || (v as VCon).type !== T_LIST_PAIR_DATA) fail("mapData: not a list of data pairs");
    const es = listToArray((v as VCon).v) as VPair[];
    chargeCon1(ctx, c, v as VCon);
    return vData(new DMap(es.map((p) => p instanceof DPair ? p : new DPair(p.fst, p.snd))));
});
def(39, (ctx, c, a0) => {
    const v = a0;
    if (!(v instanceof VCon) || (v as VCon).type !== T_LIST_DATA) fail("listData: not a list of data");
    chargeCon1(ctx, c, v as VCon);
    return vData(new DList(listToArray((v as VCon).v)));
});
def(40, (ctx, c, a0) => { const i = int(a0, "iData"); if (c.k) ctx.spend(c.cc, c.cm); else spend1(ctx, c, intSize(i)); return vData(new DInt(i)); });
def(41, (ctx, c, a0) => { const b = bytes(a0, "bData"); chargeBytes1(ctx, c, b); return vData(new DBytes(b)); });
def(42, (ctx, c, a0) => {
    const d = data(a0, "unConstrData");
    chargeData1(ctx, c, d);
    if (d.k !== DK.Constr) fail("unConstrData: not a constructor");
    return new VCon(T_PAIR_INT_LIST_DATA, new VPair((d as DConstr).tag, mkListFromArray((d as DConstr).fields)));
});
def(43, (ctx, c, a0) => { const d = data(a0, "unMapData"); chargeData1(ctx, c, d); if (d.k !== DK.Map) fail("unMapData: not a map"); return new VCon(T_LIST_PAIR_DATA, mkListFromArray((d as DMap).entries)); });
def(44, (ctx, c, a0) => { const d = data(a0, "unListData"); chargeData1(ctx, c, d); if (d.k !== DK.List) fail("unListData: not a list"); return new VCon(T_LIST_DATA, mkListFromArray((d as DList).items)); });
def(45, (ctx, c, a0) => { const d = data(a0, "unIData"); chargeData1(ctx, c, d); if (d.k !== DK.Int) fail("unIData: not an integer"); return vInt((d as DInt).v); });
def(46, (ctx, c, a0) => { const d = data(a0, "unBData"); chargeData1(ctx, c, d); if (d.k !== DK.Bytes) fail("unBData: not a bytestring"); return vBytes((d as DBytes).v); });
def(47, (ctx, c, a0, a1) => { const x = data(a0, "equalsData"), y = data(a1, "equalsData"); chargeData2(ctx, c, x, y); return vBool(dataEq(x, y)); });
def(48, (ctx, c, a0, a1) => { const x = data(a0, "mkPairData"), y = data(a1, "mkPairData"); chargeData2(ctx, c, x, y); return new VCon(T_PAIR_DATA, new DPair(x, y)); });
def(49, (ctx, c, a0) => { con(a0, T.unit, "mkNilData"); charge1(ctx, c, one); return new VCon(T_LIST_DATA, EMPTY_LIST); });
def(50, (ctx, c, a0) => { con(a0, T.unit, "mkNilPairData"); charge1(ctx, c, one); return new VCon(T_LIST_PAIR_DATA, EMPTY_LIST); });
def(51, (ctx, c, a0) => { const d = data(a0, "serialiseData"); chargeData1(ctx, c, d); return vBytes(encodeData(d)); });

// Ed25519 as cardano-crypto-class verifies it (libsodium `crypto_sign_verify_detached`): the
// key must be 32 and the signature 64 bytes (else an evaluation failure); S must be canonical,
// the key canonical and neither the key nor R of small order (libsodium's blacklist, compared
// with the sign bit cleared); then the cofactorless equation, which OpenSSL checks natively.
const SMALL_ORDER = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((h) => new Uint8Array(Buffer.from(h, "hex")));
function smallOrder(p: Uint8Array): boolean {
    for (const b of SMALL_ORDER) { let d = 0; for (let j = 0; j < 31; j++) d |= p[j]! ^ b[j]!; d |= (p[31]! & 0x7f) ^ b[31]!; if (d === 0) return true; }
    return false;
}
const ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const ED_P = (1n << 255n) - 19n;
const le = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!); return v; };
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
def(21, (ctx, c, a0, a1, a2) => {
    const pk = bytes(a0, "verifyEd25519Signature"), msg = cbs(ctx, bytes(a1, "verifyEd25519Signature"), "verifyEd25519Signature"), sg = bytes(a2, "verifyEd25519Signature");
    charge3(ctx, c, () => bytesSize(pk), () => bytesSize(msg), () => bytesSize(sg));
    if (pk.length !== 32) fail("verifyEd25519Signature: public key must be 32 bytes");
    if (sg.length !== 64) fail("verifyEd25519Signature: signature must be 64 bytes");
    if (le(sg.subarray(32)) >= ED_L) return FALSE;
    const pkCopy = Uint8Array.from(pk); pkCopy[31]! &= 0x7f;
    if (le(pkCopy) >= ED_P || smallOrder(pk) || smallOrder(sg.subarray(0, 32))) return FALSE;
    let ok = false;
    try { ok = nodeVerify(null, msg, createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: "der", type: "spki" }), sg); } catch { ok = false; }
    return vBool(ok);
});

// secp256k1 (libsecp256k1 semantics): malformed keys, messages or signatures are evaluation
// failures; a well-formed signature that does not verify (including a high-S ECDSA one) is False.
const SECP_N = secp256k1.CURVE.n;
def(52, (ctx, c, a0, a1, a2) => {
    const pk = bytes(a0, "verifyEcdsaSecp256k1Signature"), msg = bytes(a1, "verifyEcdsaSecp256k1Signature"), sg = bytes(a2, "verifyEcdsaSecp256k1Signature");
    charge3(ctx, c, () => bytesSize(pk), () => bytesSize(msg), () => bytesSize(sg));
    if (pk.length !== 33) fail("verifyEcdsaSecp256k1Signature: public key must be 33 bytes");
    if (msg.length !== 32) fail("verifyEcdsaSecp256k1Signature: message hash must be 32 bytes");
    if (sg.length !== 64) fail("verifyEcdsaSecp256k1Signature: signature must be 64 bytes");
    try { secp256k1.ProjectivePoint.fromHex(pk); } catch { fail("verifyEcdsaSecp256k1Signature: invalid public key"); }
    const r = BigInt("0x" + Buffer.from(sg.subarray(0, 32)).toString("hex")), s = BigInt("0x" + Buffer.from(sg.subarray(32)).toString("hex"));
    if (r >= SECP_N || s >= SECP_N) fail("verifyEcdsaSecp256k1Signature: signature overflow");
    if (r === 0n || s === 0n) return FALSE;
    let ok = false;
    try { ok = secp256k1.verify(sg, msg, pk, { lowS: true, prehash: false, format: "compact" } as any); } catch { ok = false; }
    return vBool(ok);
});
def(53, (ctx, c, a0, a1, a2) => {
    const pk = bytes(a0, "verifySchnorrSecp256k1Signature"), msg = cbs(ctx, bytes(a1, "verifySchnorrSecp256k1Signature"), "verifySchnorrSecp256k1Signature"), sg = bytes(a2, "verifySchnorrSecp256k1Signature");
    charge3(ctx, c, () => bytesSize(pk), () => bytesSize(msg), () => bytesSize(sg));
    if (pk.length !== 32) fail("verifySchnorrSecp256k1Signature: public key must be 32 bytes");
    if (sg.length !== 64) fail("verifySchnorrSecp256k1Signature: signature must be 64 bytes");
    try { schnorr.utils.lift_x(BigInt("0x" + Buffer.from(pk).toString("hex"))); } catch { fail("verifySchnorrSecp256k1Signature: invalid public key"); }
    let ok = false;
    try { ok = schnorr.verify(sg, msg, pk); } catch { ok = false; }
    return vBool(ok);
});

// ── conversions and bitwise builtins (CIP-121 / CIP-122 / CIP-123), costed as the reference ──
const MAX_OUT = 8192n;
/** `IntegerCostedLiterally` width/size argument of integerToByteString / replicateByte (as words). */
function literalWords(n: bigint, name: string): number {
    if (n < 0n) fail(`${name}: negative size`);
    if (n > MAX_OUT) fail(`${name}: size above ${MAX_OUT}`);
    return n === 0n ? 0 : Math.floor((Number(n) - 1) / 8) + 1;
}
const toBE = (n: bigint): Uint8Array => { if (n === 0n) return new Uint8Array(0); let h = n.toString(16); if (h.length % 2) h = "0" + h; return new Uint8Array(Buffer.from(h, "hex")); };
const fromBE = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt("0x" + Buffer.from(b).toString("hex")));
def(73, (ctx, c, a0, a1, a2) => {
    const be = con(a0, T.bool, "integerToByteString"), w = int(a1, "integerToByteString"), n = int(a2, "integerToByteString");
    const ww = literalWords(w, "integerToByteString");
    charge3(ctx, c, one, () => ww, () => intSize(n));
    if (n < 0n) fail("integerToByteString: negative input");
    let bytes = toBE(n);
    if (w === 0n && BigInt(bytes.length) > MAX_OUT) fail("integerToByteString: result too long");
    const width = Number(w);
    if (width > 0 && bytes.length > width) fail("integerToByteString: width too small");
    if (width > bytes.length) { const o = new Uint8Array(width); o.set(bytes, width - bytes.length); bytes = o; }
    return vBytes(be ? bytes : bytes.slice().reverse());
});
def(74, (ctx, c, a0, a1) => {
    const be = con(a0, T.bool, "byteStringToInteger"), b = cbs(ctx, bytes(a1, "byteStringToInteger"), "byteStringToInteger");
    charge2(ctx, c, one, () => bytesSize(b));
    return vInt(fromBE(be ? b : b.slice().reverse()));
});
function bitwise(tag: number, name: string, op: (x: number, y: number) => number, padByte: number) {
    def(tag, (ctx, c, a0: Value, a1: Value, a2: Value) => {
        const pad = con(a0, T.bool, name), x = cbs(ctx, bytes(a1, name), name), y = cbs(ctx, bytes(a2, name), name);
        charge3(ctx, c, one, () => bytesSize(x), () => bytesSize(y));
        const n = pad ? Math.max(x.length, y.length) : Math.min(x.length, y.length);
        const o = new Uint8Array(n);
        for (let i = 0; i < n; i++) o[i] = op(i < x.length ? x[i]! : padByte, i < y.length ? y[i]! : padByte) & 0xff;
        return vBytes(o);
    });
}
bitwise(75, "andByteString", (p, q) => p & q, 0xff);
bitwise(76, "orByteString", (p, q) => p | q, 0x00);
bitwise(77, "xorByteString", (p, q) => p ^ q, 0x00);
def(78, (ctx, c, a0) => { const b = cbs(ctx, bytes(a0, "complementByteString"), "complementByteString"); chargeBytes1(ctx, c, b); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i]! ^ 0xff; return vBytes(o); });
def(79, (ctx, c, a0, a1) => {
    const b = cbs(ctx, bytes(a0, "readBit"), "readBit"), i = int(a1, "readBit");
    charge2(ctx, c, () => bytesSize(b), () => intSize(i));
    if (i < 0n || i >= BigInt(b.length * 8)) fail("readBit: index out of bounds");
    const k = Number(i);
    return vBool(((b[b.length - 1 - (k >> 3)]! >> (k & 7)) & 1) === 1);
});
def(80, (ctx, c, a0, a1, a2) => {
    const b = bytes(a0, "writeBits"), l = listArg(a1, "writeBits"), set = con(a2, T.bool, "writeBits");
    if (l.type !== ConstT.list(T.int)) fail("writeBits: indices are not a list of integers");
    const idx = listToArray(l.v) as bigint[];
    charge3(ctx, c, () => bytesSize(b), () => idx.length, one);
    // variants D/E: `maximumInputLength`
    if (ctx.bounded && b.length > 4096) fail("writeBits: input too long (maximum is 4096 bytes)");
    const o = b.slice();
    for (const i of idx) {
        if (i < 0n || i >= BigInt(o.length * 8)) fail("writeBits: index out of bounds");
        const k = Number(i), j = o.length - 1 - (k >> 3), m = 1 << (k & 7);
        o[j] = set ? o[j]! | m : o[j]! & ~m;
    }
    return vBytes(o);
});
def(81, (ctx, c, a0, a1) => {
    const n = int(a0, "replicateByte"), x = int(a1, "replicateByte");
    const nw = literalWords(n, "replicateByte");
    charge2(ctx, c, () => nw, () => intSize(x));
    if (x < 0n || x > 255n) fail("replicateByte: byte out of range");
    return vBytes(new Uint8Array(Number(n)).fill(Number(x)));
});
const absLiteral = (n: bigint) => { const m = n < 0n ? -n : n; return m > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(m); };
/** Variants D/E take the shift / rotation amount as an Int (sized 1) instead of `IntegerCostedLiterally`. */
function shiftAmount(ctx: BuiltinCtx, n: bigint, name: string): number {
    if (!ctx.bounded) return absLiteral(n);
    if (n < INT64_MIN || n > INT64_MAX) fail(`${name}: amount outside Int`);
    return 1;
}
def(82, (ctx, c, a0, a1) => {
    const b = bytes(a0, "shiftByteString"), n = int(a1, "shiftByteString");
    const sn = shiftAmount(ctx, n, "shiftByteString");
    charge2(ctx, c, () => bytesSize(b), () => sn);
    const bits = BigInt(b.length * 8);
    if ((n < 0n ? -n : n) >= bits) return vBytes(new Uint8Array(b.length));
    const v = fromBE(b), mask = (1n << bits) - 1n;
    const r = n >= 0n ? (v << n) & mask : v >> -n;
    const out = toBE(r), o = new Uint8Array(b.length); o.set(out, b.length - out.length);
    return vBytes(o);
});
def(83, (ctx, c, a0, a1) => {
    const b = bytes(a0, "rotateByteString"), n = int(a1, "rotateByteString");
    const sn = shiftAmount(ctx, n, "rotateByteString");
    charge2(ctx, c, () => bytesSize(b), () => sn);
    if (b.length === 0) return vBytes(b);
    const bits = BigInt(b.length * 8);
    const k = ((n % bits) + bits) % bits;
    if (k === 0n) return vBytes(b);
    const v = fromBE(b), mask = (1n << bits) - 1n;
    const r = ((v << k) | (v >> (bits - k))) & mask;
    const out = toBE(r), o = new Uint8Array(b.length); o.set(out, b.length - out.length);
    return vBytes(o);
});
def(84, (ctx, c, a0) => { const b = cbs(ctx, bytes(a0, "countSetBits"), "countSetBits"); chargeBytes1(ctx, c, b); let n = 0; for (const x of b) { let y = x; while (y) { n += y & 1; y >>= 1; } } return vInt(BigInt(n)); });
def(85, (ctx, c, a0) => {
    const b = cbs(ctx, bytes(a0, "findFirstSetBit"), "findFirstSetBit");
    chargeBytes1(ctx, c, b);
    for (let j = b.length - 1, base = 0; j >= 0; j--, base += 8) { const x = b[j]!; if (x) return vInt(BigInt(base + (31 - Math.clz32(x & -x)))); }
    return vInt(-1n);
});
hash(86, "ripemd_160", (b) => ripemd160(b));

// ── batch 6 (van Rossem) ──
const EXPMOD_BOUND = 1n << 8191n;
function modInverse(a: bigint, m: bigint): bigint | null {
    let [r0, r1, t0, t1] = [m, ((a % m) + m) % m, 0n, 1n];
    while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; }
    return r0 === 1n ? ((t0 % m) + m) % m : null;
}
def(87, (ctx, c, a0, a1, a2) => {
    const b = int(a0, "expModInteger"), e = int(a1, "expModInteger"), m = int(a2, "expModInteger");
    charge3(ctx, c, () => intSize(b), () => intSize(e), () => intSize(m));
    if (m < 0n) fail("expModInteger: negative modulus");
    if (m === 0n || m >= EXPMOD_BOUND) fail("expModInteger: invalid modulus");
    if (m === 1n) return vInt(0n);
    if (b === 0n && e < 0n) fail("expModInteger: 0 is not invertible");
    // `oob x = x > 2^8191 − 1 || x < −2^8191` (PlutusCore.Crypto.ExpMod)
    if (b >= EXPMOD_BOUND || b < -EXPMOD_BOUND || e >= EXPMOD_BOUND || e < -EXPMOD_BOUND) fail("expModInteger: out of bounds");
    let base = ((b % m) + m) % m, exp = e;
    if (exp < 0n) { const inv = modInverse(base, m); if (inv === null) fail("expModInteger: base is not invertible"); base = inv!; exp = -exp; }
    let r = 1n;
    while (exp > 0n) { if (exp & 1n) r = (r * base) % m; base = (base * base) % m; exp >>= 1n; }
    return vInt(r);
});
def(88, (ctx, c, a0, a1) => {
    const n = int(a0, "dropList"), l = listArg(a1, "dropList");
    charge2(ctx, c, () => absLiteral(n), () => valueSize(l.type, l.v));
    let cur: List = l.v;
    if (n > 0n) for (let i = 0n; i < n && !listIsEmpty(cur); i++) cur = listTail(cur);
    return new VCon(l.type, cur);
});
function arrayArg(v: Value, n: string): VCon { if (!(v instanceof VCon) || (v as VCon).type.tag !== 12) fail(`${n}: argument is not an array`); return v as VCon; }
def(89, (ctx, c, a0) => { const v = arrayArg(a0, "lengthOfArray"); charge1(ctx, c, () => (v.v as VArray).arr.length); return vInt(BigInt((v.v as VArray).arr.length)); });
def(90, (ctx, c, a0) => { const l = listArg(a0, "listToArray"); charge1(ctx, c, () => valueSize(l.type, l.v)); return new VCon(ConstT.array(l.type.a!), new VArray(listToArray(l.v).slice())); });
def(91, (ctx, c, a0, a1) => {
    const v = arrayArg(a0, "indexArray"), i = int(a1, "indexArray");
    charge2(ctx, c, () => (v.v as VArray).arr.length, () => intSize(i));
    if (i < INT64_MIN || i > INT64_MAX) fail("indexArray: index outside Int");
    const arr = (v.v as VArray).arr;
    if (i < 0n || i >= BigInt(arr.length)) fail("indexArray: index out of bounds");
    return new VCon(v.type.a!, arr[Number(i)]);
});

// BLS12-381 multi-scalar multiplication: Σ sᵢ·Pᵢ over the zipped lists (the longer list's tail is
// ignored), every scalar — zipped or not — within [−2^4095, 2^4095 − 1] (`msmScalarOutOfBounds`);
// the empty sum is the identity. Costed on the lists' lengths.
const MSM_BOUND = 1n << 4095n;
function msm(tag: number, name: string, pointType: ConstType, isPoint: (p: any) => boolean, mul: (n: bigint, p: any) => any, add: (a: any, b: any) => any, zero: any) {
    def(tag, (ctx, c, a0: Value, a1: Value) => {
        const s = a0, p = a1;
        if (!(s instanceof VCon) || (s as VCon).type !== ConstT.list(T.int)) fail(`${name}: scalars are not a list of integers`);
        if (!(p instanceof VCon) || (p as VCon).type !== ConstT.list(pointType)) fail(`${name}: points are not a list of ${pointType.key}`);
        const ss = listToArray((s as VCon).v) as bigint[], ps = listToArray((p as VCon).v);
        charge2(ctx, c, () => ss.length, () => ps.length);
        for (const k of ss) if (k >= MSM_BOUND || k < -MSM_BOUND) fail(`${name}: scalar exceeds the 512-byte bound`);
        let acc = zero;
        const n = Math.min(ss.length, ps.length);
        for (let i = 0; i < n; i++) {
            if (!isPoint(ps[i])) fail(`${name}: not a point`);
            acc = add(acc, mul(ss[i]!, ps[i]));
        }
        return new VCon(pointType, acc);
    });
}
msm(92, "bls12_381_G1_multiScalarMul", T.g1, isBlsG1, bls12_381_G1_scalarMul, bls12_381_G1_add, BlsG1.ZERO);
msm(93, "bls12_381_G2_multiScalarMul", T.g2, isBlsG2, bls12_381_G2_scalarMul, bls12_381_G2_add, BlsG2.ZERO);

// ── Value builtins (multiasset.ts; costed on ValueMaxDepth, ValueTotalSize, DataNodeCount) ──
const vValue = (v: VValue) => new VCon(T.value, v);
const valueArg = (v: Value, n: string): VValue => con(v, T.value, n);
/** A Value operation's own failure (bounds, ordering, negative amounts) is an evaluation failure. */
function vop<X>(f: () => X): X { try { return f(); } catch (e) { if (e instanceof ValueError) fail(e.message); throw e; } }
def(94, (ctx, c, a0, a1, a2, a3) => {
    const cur = bytes(a0, "insertCoin"), tok = bytes(a1, "insertCoin"), amt = int(a2, "insertCoin"), v = valueArg(a3, "insertCoin");
    charge4(ctx, c, () => bytesSize(cur), () => bytesSize(tok), () => intSize(amt), () => valueMaxDepth(v));
    return vValue(vop(() => insertCoin(cur, tok, amt, v)));
});
def(95, (ctx, c, a0, a1, a2) => {
    const cur = bytes(a0, "lookupCoin"), tok = bytes(a1, "lookupCoin"), v = valueArg(a2, "lookupCoin");
    charge3(ctx, c, () => bytesSize(cur), () => bytesSize(tok), () => valueMaxDepth(v));
    return vInt(lookupCoin(cur, tok, v));
});
def(96, (ctx, c, a0, a1) => {
    const x = valueArg(a0, "unionValue"), y = valueArg(a1, "unionValue");
    charge2(ctx, c, () => x.total, () => y.total);
    return vValue(vop(() => unionValue(x, y)));
});
def(97, (ctx, c, a0, a1) => {
    const x = valueArg(a0, "valueContains"), y = valueArg(a1, "valueContains");
    charge2(ctx, c, () => x.total, () => y.total);
    return vBool(vop(() => valueContains(x, y)));
});
def(98, (ctx, c, a0) => { const v = valueArg(a0, "valueData"); charge1(ctx, c, () => v.total); return vData(vop(() => valueData(v))); });
def(99, (ctx, c, a0) => { const d = data(a0, "unValueData"); charge1(ctx, c, () => dataNodeCount(d)); return vValue(vop(() => unValueData(d))); });
def(100, (ctx, c, a0, a1) => {
    const k = int(a0, "scaleValue"), v = valueArg(a1, "scaleValue");
    charge2(ctx, c, () => intSize(k), () => v.total);
    return vValue(vop(() => scaleValue(k, v)));
});

// ── delegation to plutus-machine's BnCEK ──
function toUplcType(t: ConstType): number[] {
    switch (t.tag) {
        case 5: return [7, 5, ...toUplcType(t.a!)];
        case 6: return [7, 7, 6, ...toUplcType(t.a!), ...toUplcType(t.b!)];
        default: return [t.tag];
    }
}
function fromUplcType(arr: number[], i = { p: 0 }): ConstType {
    const tag = arr[i.p++]!;
    if (tag !== 7) return ({ 0: T.int, 1: T.bytes, 2: T.string, 3: T.unit, 4: T.bool, 8: T.data, 9: T.g1, 10: T.g2, 11: T.ml } as any)[tag] ?? fail(`unknown constant type ${tag}`);
    const f = arr[i.p++]!;
    if (f === 5) return ConstT.list(fromUplcType(arr, i));
    i.p++; // 6
    const a = fromUplcType(arr, i);
    return ConstT.pair(a, fromUplcType(arr, i));
}
function toLibData(d: Data): any {
    switch (d.k) {
        case DK.Constr: return new DataConstr(d.tag, d.fields.map(toLibData));
        case DK.Map: return new DataMap(d.entries.map((e) => new DataPair(toLibData(e.fst), toLibData(e.snd))));
        case DK.List: return new DataList(d.items.map(toLibData));
        case DK.Int: return new DataI(d.v);
        case DK.Bytes: return new DataB(new ByteString(d.v));
    }
}
function toUplcValue(t: ConstType, v: any): any {
    switch (t.tag) {
        case 1: return new ByteString(Uint8Array.from(v)); // a copy: the delegate may mutate its buffers
        case 3: return undefined;
        case 8: return toLibData(v);
        case 5: return listToArray(v).map((x) => toUplcValue(t.a!, x));
        case 6: return new Pair(toUplcValue(t.a!, v.fst), toUplcValue(t.b!, v.snd));
        default: return v;
    }
}
function fromUplcValue(t: ConstType, v: any): any {
    switch (t.tag) {
        case 1: return Uint8Array.from(v?._bytes instanceof Uint8Array ? v._bytes : v.toBuffer());
        case 3: return null;
        case 8: return fromLibData(v);
        case 5: return mkListFromArray((v as any[]).map((x) => fromUplcValue(t.a!, x)));
        case 6: return new VPair(fromUplcValue(t.a!, v.fst), fromUplcValue(t.b!, v.snd));
        default: return v;
    }
}
const BN_NAMES: Record<number, string> = {
    21: "verifyEd25519Signature", 52: "verifyEcdsaSecp256k1Signature", 53: "verifySchnorrSecp256k1Signature",
    54: "bls12_381_G1_add", 55: "bls12_381_G1_neg", 56: "bls12_381_G1_scalarMul", 57: "bls12_381_G1_equal", 58: "bls12_381_G1_compress",
    59: "bls12_381_G1_uncompress", 60: "bls12_381_G1_hashToGroup", 61: "bls12_381_G2_add", 62: "bls12_381_G2_neg", 63: "bls12_381_G2_scalarMul",
    64: "bls12_381_G2_equal", 65: "bls12_381_G2_compress", 66: "bls12_381_G2_uncompress", 67: "bls12_381_G2_hashToGroup",
    68: "bls12_381_millerLoop", 69: "bls12_381_mulMlResult", 70: "bls12_381_finalVerify", 73: "integerToByteString", 74: "byteStringToInteger",
    75: "andByteString", 76: "orByteString", 77: "xorByteString", 78: "complementByteString", 79: "readBit", 80: "writeBits",
    81: "replicateByte", 82: "shiftByteString", 83: "rotateByteString", 84: "countSetBits", 85: "findFirstSetBit", 86: "ripemd_160",
};
function delegated(ctx: BuiltinCtx, tag: number, args: Value[]): Value {
    const name = BN_NAMES[tag];
    if (!name || !ctx.bnCek) throw new EvalUnsupported(`builtin ${tag} is not implemented by this evaluator`);
    const cargs = args.map((a) => {
        if (!(a instanceof VCon)) fail(`${name}: argument is not a constant`);
        return new CEKConst(toUplcType((a as VCon).type) as any, toUplcValue((a as VCon).type, (a as VCon).v));
    });
    const out = (ctx.bnCek as any)[name!](...cargs);
    if (out instanceof CEKError || !(out instanceof CEKConst)) fail(`${name}: ${out?.message ?? "failed"}`);
    const t = fromUplcType((out as any).type);
    return new VCon(t, fromUplcValue(t, (out as any).value));
}

export function newBnCek(ctx: BuiltinCtx, lookup: (tag: number) => any): BnCEK {
    const shim = { add: (b: { cpu: bigint | number; mem: bigint | number }) => ctx.spend(Number(b.cpu), Number(b.mem)) };
    return new BnCEK(lookup as any, shim as any, []);
}

/** --trace-plutus-builtins: one line per saturated builtin call (align with tools/uplc-ref's UPLC_BUILTIN_TRACE). */
/** --trace-plutus-builtins: one log line per builtin call. */
const builtinTrace = (): boolean => settings().tracePlutusBuiltins;
function show(v: any): string {
    if (!(v instanceof VCon)) return v?.constructor?.name ?? String(v);
    const x = v.v;
    switch (v.type.tag) {
        case 0: return String(x);
        case 1: return "#" + Buffer.from(x).toString("hex").slice(0, settings().tracePlutusBuiltinsFull ? undefined : 64);
        case 2: return JSON.stringify(String(x).slice(0, 40));
        case 4: return String(x);
        case 3: return "()";
        case 5: return `list(${listToArray(x).length})`;
        case 12: return `array(${(x as VArray).arr.length})`;
        case 8: return `data(k${x.k})`;
        default: return v.type.key;
    }
}
/**
 * Variants D/E bounds of delegated builtins (plutus-machine predates them): scalarMul's scalar
 * within 4096 bits (`scalarMulE`), hashToGroup's message a CByteString.
 */
function delegatedBounds(ctx: BuiltinCtx, tag: number, a0: Value) {
    if (!(a0 instanceof VCon)) return;
    if ((tag === 56 || tag === 63) && a0.type === T.int && (a0.v >= MSM_BOUND || a0.v < -MSM_BOUND)) fail(`${BN_NAMES[tag]}: scalar exceeds the 512-byte bound`);
    if ((tag === 60 || tag === 67) && a0.type === T.bytes) cbs(ctx, a0.v, BN_NAMES[tag]!);
}

/** Run a saturated builtin on an argument array (tests, tracing); throws EvalFailure (or the budget error from `spend`). */
export function callBuiltin(ctx: BuiltinCtx, tag: number, args: Value[]): Value {
    const a = args;
    return callSaturated(ctx, tag, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a.length);
}
function callSaturated(ctx: BuiltinCtx, tag: number, a0: Value, a1: Value, a2: Value, a3: Value, a4: Value, a5: Value, n: number): Value {
    if (builtinTrace()) {
        const args = [a0, a1, a2, a3, a4, a5].slice(0, n);
        let out: Value | string;
        try { out = callInner(ctx, tag, a0, a1, a2, a3, a4, a5, n); } catch (e) { out = `ERROR ${(e as Error).message}`; console.error(`BUILTIN ${tag} ${args.map(show).join(", ")} -> ${out}`); throw e; }
        console.error(`BUILTIN ${tag} ${args.map(show).join(", ")} -> ${show(out)}`);
        return out;
    }
    return callInner(ctx, tag, a0, a1, a2, a3, a4, a5, n);
}
function callInner(ctx: BuiltinCtx, tag: number, a0: Value, a1: Value, a2: Value, a3: Value, a4: Value, a5: Value, n: number): Value {
    const costs = ctx.costs.builtins;
    // the frequent builtins through their own call sites (monomorphic, inlinable); the rest via the table
    switch (tag) {
        case 33: return IMPL[33]!(ctx, costs[33] ?? noCost(33), a0, a1, a2, a3, a4, a5);
        case 34: return IMPL[34]!(ctx, costs[34] ?? noCost(34), a0, a1, a2, a3, a4, a5);
        case 26: return IMPL[26]!(ctx, costs[26] ?? noCost(26), a0, a1, a2, a3, a4, a5);
        case 7: return IMPL[7]!(ctx, costs[7] ?? noCost(7), a0, a1, a2, a3, a4, a5);
        case 29: return IMPL[29]!(ctx, costs[29] ?? noCost(29), a0, a1, a2, a3, a4, a5);
        case 30: return IMPL[30]!(ctx, costs[30] ?? noCost(30), a0, a1, a2, a3, a4, a5);
        case 42: return IMPL[42]!(ctx, costs[42] ?? noCost(42), a0, a1, a2, a3, a4, a5);
        case 45: return IMPL[45]!(ctx, costs[45] ?? noCost(45), a0, a1, a2, a3, a4, a5);
        case 46: return IMPL[46]!(ctx, costs[46] ?? noCost(46), a0, a1, a2, a3, a4, a5);
        case 15: return IMPL[15]!(ctx, costs[15] ?? noCost(15), a0, a1, a2, a3, a4, a5);
        case 28: return IMPL[28]!(ctx, costs[28] ?? noCost(28), a0, a1, a2, a3, a4, a5);
        case 31: return IMPL[31]!(ctx, costs[31] ?? noCost(31), a0, a1, a2, a3, a4, a5);
        case 35: return IMPL[35]!(ctx, costs[35] ?? noCost(35), a0, a1, a2, a3, a4, a5);
        case 36: return IMPL[36]!(ctx, costs[36] ?? noCost(36), a0, a1, a2, a3, a4, a5);
        case 44: return IMPL[44]!(ctx, costs[44] ?? noCost(44), a0, a1, a2, a3, a4, a5);
        case 43: return IMPL[43]!(ctx, costs[43] ?? noCost(43), a0, a1, a2, a3, a4, a5);
        case 8: return IMPL[8]!(ctx, costs[8] ?? noCost(8), a0, a1, a2, a3, a4, a5);
        case 9: return IMPL[9]!(ctx, costs[9] ?? noCost(9), a0, a1, a2, a3, a4, a5);
        case 0: return IMPL[0]!(ctx, costs[0] ?? noCost(0), a0, a1, a2, a3, a4, a5);
        case 1: return IMPL[1]!(ctx, costs[1] ?? noCost(1), a0, a1, a2, a3, a4, a5);
    }
    if (ctx.bounded && (tag === 56 || tag === 63 || tag === 60 || tag === 67)) delegatedBounds(ctx, tag, a0);
    const impl = IMPL[tag];
    if (impl !== undefined) return impl(ctx, costs[tag] ?? noCost(tag), a0, a1, a2, a3, a4, a5);
    return delegated(ctx, tag, [a0, a1, a2, a3, a4, a5].slice(0, n));
}
function noCost(tag: number): never { return fail(`builtin ${tag} has no cost model`); }

/** A builtin value (its forces taken) applied to one more argument while more are due (`b.n + 1 < ARITY[b.fn]`). */
export function partialBuiltin(b: VBuiltin, arg: Value): VBuiltin { return new VBuiltin(b.fn, 0, b.n + 1, arg, b); }
/**
 * Apply a builtin value (its forces taken) to one more argument: a partial application when more
 * arguments are due, else the saturated call. The machine checks `forces === 0` first.
 */
export function applyBuiltin(ctx: BuiltinCtx, b: VBuiltin, arg: Value): Value {
    return b.n + 1 < ARITY[b.fn]! ? partialBuiltin(b, arg) : saturateBuiltin(ctx, b, arg);
}
/** The saturating application: `arg` is the last argument; the cost is charged, then the builtin runs. */
export function saturateBuiltin(ctx: BuiltinCtx, b: VBuiltin, arg: Value): Value {
    const fn = b.fn;
    // straight to the dispatch (one call level) unless tracing
    const call = builtinTrace() ? callSaturated : callInner;
    switch (b.n) {
        case 0: return call(ctx, fn, arg, UNIT, UNIT, UNIT, UNIT, UNIT, 1);
        case 1: return call(ctx, fn, b.arg!, arg, UNIT, UNIT, UNIT, UNIT, 2);
        case 2: { const b1 = b.link!; return call(ctx, fn, b1.arg!, b.arg!, arg, UNIT, UNIT, UNIT, 3); }
        case 3: { const b2 = b.link!, b1 = b2.link!; return call(ctx, fn, b1.arg!, b2.arg!, b.arg!, arg, UNIT, UNIT, 4); }
        case 4: { const b3 = b.link!, b2 = b3.link!, b1 = b2.link!; return call(ctx, fn, b1.arg!, b2.arg!, b3.arg!, b.arg!, arg, UNIT, 5); }
        default: { const b4 = b.link!, b3 = b4.link!, b2 = b3.link!, b1 = b2.link!; return call(ctx, fn, b1.arg!, b2.arg!, b3.arg!, b4.arg!, b.arg!, arg, 6); }
    }
}
/** Force a builtin value awaiting forces (the machine checks `forces > 0` and `n === 0`); the result is cached on the value. */
export function forceBuiltin(b: VBuiltin): VBuiltin {
    return (b.link ??= new VBuiltin(b.fn, b.forces - 1, 0, null, null));
}
export { VBuiltin, UNIT };
