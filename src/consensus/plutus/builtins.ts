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
 */
import { BnCEK } from "@harmoniclabs/plutus-machine/dist/BnCEK/BnCEK.js";
import { CEKConst } from "@harmoniclabs/plutus-machine/dist/CEKValue/CEKConst.js";
import { CEKError } from "@harmoniclabs/plutus-machine/dist/CEKValue/CEKError.js";
import { ByteString } from "@harmoniclabs/bytestring";
import { Pair } from "@harmoniclabs/pair";
import { DataB, DataConstr, DataI, DataList, DataMap, DataPair } from "@harmoniclabs/plutus-data";
import { sha256 } from "@noble/hashes/sha2";
import { sha3_256, keccak_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { BlsG1, BlsG2, bls12_381_G1_add, bls12_381_G1_scalarMul, bls12_381_G2_add, bls12_381_G2_scalarMul, isBlsG1, isBlsG2 } from "@harmoniclabs/crypto";
import {
    DBytes, DConstr, DInt, DK, DList, DMap, DPair, type Data,
    bytesEq, bytesSize, dataEq, dataSize, encodeData, fromLibData, intSize,
} from "./data";
import {
    ConstT, EMPTY_LIST, FALSE, LArr, LCons, T, TRUE, T_LIST_DATA, T_LIST_PAIR_DATA, T_PAIR_DATA, T_PAIR_INT_LIST_DATA, UNIT,
    VArray, VBuiltin, VCon, VPair, listHead, listIsEmpty, listTail, listToArray, mkListFromArray,
    type ConstType, type List, type Value,
} from "./values";
import type { BuiltinCost, CostTable } from "./costs";
import {
    VValue, ValueError, dataNodeCount, insertCoin, lookupCoin, scaleValue, unValueData, unionValue, valueContains, valueData, valueMaxDepth,
} from "./multiasset";

export class EvalFailure extends Error {}
/** An evaluator limitation (a builtin this evaluator does not implement): no verdict, never a script failure. */
export class EvalUnsupported extends Error {}
const fail = (msg: string): never => { throw new EvalFailure(msg); };

export interface BuiltinCtx {
    spend(cpu: number, mem: number): void;
    costs: CostTable;
    /** Plutus V1/V2 semantics variant (consByteString wraps the byte). */
    legacy: boolean;
    /** Variants D/E (protocol 11): appendString / equalsString / encodeUtf8 cost their text by UTF-8 byte length `quot` 4 (`TextCostedByByteLength`). */
    textByBytes: boolean;
    /**
     * Variants D/E (protocol 11, plutus-core `ensurable`): the integer arguments of the arithmetic
     * builtins must lie in [−2^262143, 2^262143 − 1] (`CInteger`), the bytestring arguments of the
     * bytestring/hash/bitwise builtins be at most 65536 bytes (`CByteString`), constrData's tag a
     * Word64, shift/rotate amounts an Int, writeBits' input at most 4096 bytes and the BLS12-381
     * scalars at most 4096 bits; an argument outside is an evaluation failure.
     */
    bounded: boolean;
    logs: string[] | null;
    /** plutus-machine's BigInt cost lookup, for the delegated builtins. */
    bnCek: BnCEK | null;
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

// ── argument access ──
function con(v: Value, t: ConstType, name: string): any {
    if (!(v instanceof VCon) || v.type !== t) fail(`${name}: argument is not ${t.key}`);
    return (v as VCon).v;
}
const int = (v: Value, n: string): bigint => con(v, T.int, n);
const bytes = (v: Value, n: string): Uint8Array => con(v, T.bytes, n);
const str = (v: Value, n: string): string => con(v, T.string, n);
const data = (v: Value, n: string): Data => con(v, T.data, n);
function list(v: Value, n: string): { l: List; t: ConstType } {
    if (!(v instanceof VCon) || v.type.tag !== 5) fail(`${n}: argument is not a list`);
    return { l: (v as VCon).v, t: (v as VCon).type };
}
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

function charge1(ctx: BuiltinCtx, c: BuiltinCost, x: () => number) {
    const cc = c.cpu.c, mc = c.mem.c;
    if (cc !== null && mc !== null) return ctx.spend(cc, mc);
    const sx = x();
    ctx.spend(cc ?? c.cpu.at(sx, 0, 0), mc ?? c.mem.at(sx, 0, 0));
}
function charge2(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number) {
    const cc = c.cpu.c, mc = c.mem.c;
    if (cc !== null && mc !== null) return ctx.spend(cc, mc);
    const sx = x(), sy = y();
    ctx.spend(cc ?? c.cpu.at(sx, sy, 0), mc ?? c.mem.at(sx, sy, 0));
}
function charge3(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number, z: () => number) {
    const cc = c.cpu.c, mc = c.mem.c;
    if (cc !== null && mc !== null) return ctx.spend(cc, mc);
    const sx = x(), sy = y(), sz = z();
    ctx.spend(cc ?? c.cpu.at(sx, sy, sz), mc ?? c.mem.at(sx, sy, sz));
}
function charge4(ctx: BuiltinCtx, c: BuiltinCost, x: () => number, y: () => number, z: () => number, u: () => number) {
    const cc = c.cpu.c, mc = c.mem.c;
    if (cc !== null && mc !== null) return ctx.spend(cc, mc);
    const sx = x(), sy = y(), sz = z(), su = u();
    ctx.spend(cc ?? c.cpu.at(sx, sy, sz, su), mc ?? c.mem.at(sx, sy, sz, su));
}
const one = () => 1;
// ── protocol-11 argument bounds (BuiltinCtx.bounded; PlutusCore.Default.Universe.Cardano) ──
const CINT_MAX = (1n << 262143n) - 1n, CINT_MIN = -(1n << 262143n), CBS_MAX = 65536;
/** A `CInteger` argument (variants D/E). */
function cint(ctx: BuiltinCtx, n: bigint, name: string): bigint { if (ctx.bounded && (n > CINT_MAX || n < CINT_MIN)) fail(`${name}: Integer out of bounds`); return n; }
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

type Impl = (ctx: BuiltinCtx, c: BuiltinCost, a: Value[]) => Value;
const IMPL: Array<Impl | undefined> = [];
function intOp(tag: number, name: string, op: (x: bigint, y: bigint) => bigint, divLike = false) {
    IMPL[tag] = (ctx, c, a) => {
        const x = cint(ctx, int(a[0]!, name), name), y = cint(ctx, int(a[1]!, name), name);
        charge2(ctx, c, () => intSize(x), () => intSize(y));
        if (divLike && y === 0n) fail(`${name}: division by zero`);
        return vInt(op(x, y));
    };
}
intOp(0, "addInteger", (x, y) => x + y);
intOp(1, "subtractInteger", (x, y) => x - y);
intOp(2, "multiplyInteger", (x, y) => x * y);
intOp(3, "divideInteger", hsDiv, true);
intOp(4, "quotientInteger", hsQuot, true);
intOp(5, "remainderInteger", (x, y) => x % y, true);
intOp(6, "modInteger", hsMod, true);
function intCmp(tag: number, name: string, op: (x: bigint, y: bigint) => boolean, bounded = true) {
    IMPL[tag] = (ctx, c, a) => {
        let x = int(a[0]!, name), y = int(a[1]!, name);
        if (bounded) { x = cint(ctx, x, name); y = cint(ctx, y, name); }
        charge2(ctx, c, () => intSize(x), () => intSize(y)); return vBool(op(x, y));
    };
}
intCmp(7, "equalsInteger", (x, y) => x === y, false); // plain Integer in every variant
intCmp(8, "lessThanInteger", (x, y) => x < y);
intCmp(9, "lessThanEqualsInteger", (x, y) => x <= y);
IMPL[10] = (ctx, c, a) => { const x = cbs(ctx, bytes(a[0]!, "appendByteString"), "appendByteString"), y = cbs(ctx, bytes(a[1]!, "appendByteString"), "appendByteString"); charge2(ctx, c, () => bytesSize(x), () => bytesSize(y)); return vBytes(concat(x, y)); };
IMPL[11] = (ctx, c, a) => {
    // D: CInteger (reduced mod 256); E: Word8; both: CByteString
    const n = cint(ctx, int(a[0]!, "consByteString"), "consByteString"), b = cbs(ctx, bytes(a[1]!, "consByteString"), "consByteString");
    charge2(ctx, c, () => intSize(n), () => bytesSize(b));
    let byte: bigint;
    if (ctx.legacy) byte = ((n % 256n) + 256n) % 256n;
    else { if (n < 0n || n > 255n) fail("consByteString: byte out of range"); byte = n; }
    const o = new Uint8Array(b.length + 1); o[0] = Number(byte); o.set(b, 1);
    return vBytes(o);
};
IMPL[12] = (ctx, c, a) => {
    const s = int(a[0]!, "sliceByteString"), n = int(a[1]!, "sliceByteString"), b = cbs(ctx, bytes(a[2]!, "sliceByteString"), "sliceByteString");
    charge3(ctx, c, () => intSize(s), () => intSize(n), () => bytesSize(b));
    if (s < INT64_MIN || s > INT64_MAX || n < INT64_MIN || n > INT64_MAX) fail("sliceByteString: argument outside Int");
    const len = BigInt(b.length);
    const i = s < 0n ? 0n : s > len ? len : s;
    const e = i + (n < 0n ? 0n : n);
    const j = e > len ? len : e;
    return vBytes(b.subarray(Number(i), Number(j)));
};
IMPL[13] = (ctx, c, a) => { const b = bytes(a[0]!, "lengthOfByteString"); charge1(ctx, c, () => bytesSize(b)); return vInt(BigInt(b.length)); };
IMPL[14] = (ctx, c, a) => {
    const b = cbs(ctx, bytes(a[0]!, "indexByteString"), "indexByteString"), i = int(a[1]!, "indexByteString");
    charge2(ctx, c, () => bytesSize(b), () => intSize(i));
    if (i < 0n || i >= BigInt(b.length)) fail("indexByteString: index out of range");
    return vInt(BigInt(b[Number(i)]!));
};
IMPL[15] = (ctx, c, a) => { const x = cbs(ctx, bytes(a[0]!, "equalsByteString"), "equalsByteString"), y = cbs(ctx, bytes(a[1]!, "equalsByteString"), "equalsByteString"); charge2(ctx, c, () => bytesSize(x), () => bytesSize(y)); return vBool(bytesEq(x, y)); };
IMPL[16] = (ctx, c, a) => { const x = cbs(ctx, bytes(a[0]!, "lessThanByteString"), "lessThanByteString"), y = cbs(ctx, bytes(a[1]!, "lessThanByteString"), "lessThanByteString"); charge2(ctx, c, () => bytesSize(x), () => bytesSize(y)); return vBool(compareBytes(x, y) < 0); };
IMPL[17] = (ctx, c, a) => { const x = cbs(ctx, bytes(a[0]!, "lessThanEqualsByteString"), "lessThanEqualsByteString"), y = cbs(ctx, bytes(a[1]!, "lessThanEqualsByteString"), "lessThanEqualsByteString"); charge2(ctx, c, () => bytesSize(x), () => bytesSize(y)); return vBool(compareBytes(x, y) <= 0); };
function hash(tag: number, name: string, f: (b: Uint8Array) => Uint8Array) {
    // every hash takes a CByteString in variants D/E
    IMPL[tag] = (ctx, c, a) => { const b = cbs(ctx, bytes(a[0]!, name), name); charge1(ctx, c, () => bytesSize(b)); return vBytes(f(b)); };
}
hash(18, "sha2_256", (b) => sha256(b));
hash(19, "sha3_256", (b) => sha3_256(b));
hash(20, "blake2b_256", (b) => blake2b(b, { dkLen: 32 }));
hash(71, "keccak_256", (b) => keccak_256(b));
hash(72, "blake2b_224", (b) => blake2b(b, { dkLen: 28 }));
IMPL[22] = (ctx, c, a) => { const x = str(a[0]!, "appendString"), y = str(a[1]!, "appendString"); charge2(ctx, c, () => textSize(ctx, x), () => textSize(ctx, y)); return new VCon(T.string, x + y); };
IMPL[23] = (ctx, c, a) => { const x = str(a[0]!, "equalsString"), y = str(a[1]!, "equalsString"); charge2(ctx, c, () => textSize(ctx, x), () => textSize(ctx, y)); return vBool(x === y); };
IMPL[24] = (ctx, c, a) => { const x = str(a[0]!, "encodeUtf8"); charge1(ctx, c, () => textSize(ctx, x)); return vBytes(utf8enc.encode(x)); };
IMPL[25] = (ctx, c, a) => {
    const b = cbs(ctx, bytes(a[0]!, "decodeUtf8"), "decodeUtf8");
    charge1(ctx, c, () => bytesSize(b));
    let s = ""; try { s = utf8.decode(b); } catch { fail("decodeUtf8: invalid UTF-8"); }
    return new VCon(T.string, s);
};
IMPL[26] = (ctx, c, a) => { const b = con(a[0]!, T.bool, "ifThenElse"); charge3(ctx, c, one, one, one); return b ? a[1]! : a[2]!; };
IMPL[27] = (ctx, c, a) => { con(a[0]!, T.unit, "chooseUnit"); charge2(ctx, c, one, one); return a[1]!; };
IMPL[28] = (ctx, c, a) => { const s = str(a[0]!, "trace"); charge2(ctx, c, () => strSize(s), one); if (ctx.logs && ctx.logs.length < 64) ctx.logs.push(s); return a[1]!; };
function pairArg(v: Value, n: string): VCon { if (!(v instanceof VCon) || v.type.tag !== 6) fail(`${n}: argument is not a pair`); return v as VCon; }
IMPL[29] = (ctx, c, a) => { const p = pairArg(a[0]!, "fstPair"); charge1(ctx, c, () => valueSize(p.type, p.v)); return new VCon(p.type.a!, p.v.fst); };
IMPL[30] = (ctx, c, a) => { const p = pairArg(a[0]!, "sndPair"); charge1(ctx, c, () => valueSize(p.type, p.v)); return new VCon(p.type.b!, p.v.snd); };
IMPL[31] = (ctx, c, a) => { const { l, t } = list(a[0]!, "chooseList"); charge3(ctx, c, () => valueSize(t, l), one, one); return listIsEmpty(l) ? a[1]! : a[2]!; };
IMPL[32] = (ctx, c, a) => {
    const x = a[0]!, { l, t } = list(a[1]!, "mkCons");
    if (!(x instanceof VCon) || x.type !== t.a) fail("mkCons: element type differs from the list's");
    charge2(ctx, c, () => valueSize((x as VCon).type, (x as VCon).v), () => valueSize(t, l));
    return new VCon(t, new LCons((x as VCon).v, l));
};
IMPL[33] = (ctx, c, a) => { const { l, t } = list(a[0]!, "headList"); charge1(ctx, c, () => valueSize(t, l)); if (listIsEmpty(l)) fail("headList: empty list"); return new VCon(t.a!, listHead(l)); };
IMPL[34] = (ctx, c, a) => { const { l, t } = list(a[0]!, "tailList"); charge1(ctx, c, () => valueSize(t, l)); if (listIsEmpty(l)) fail("tailList: empty list"); return new VCon(t, listTail(l)); };
IMPL[35] = (ctx, c, a) => { const { l, t } = list(a[0]!, "nullList"); charge1(ctx, c, () => valueSize(t, l)); return vBool(listIsEmpty(l)); };
IMPL[36] = (ctx, c, a) => {
    const d = data(a[0]!, "chooseData");
    charge1(ctx, c, () => dataSize(d));
    switch (d.k) { case DK.Constr: return a[1]!; case DK.Map: return a[2]!; case DK.List: return a[3]!; case DK.Int: return a[4]!; default: return a[5]!; }
};
IMPL[37] = (ctx, c, a) => {
    const i = int(a[0]!, "constrData");
    const v = a[1]!;
    // variants D/E: the tag is a Word64
    if (ctx.bounded && (i < 0n || i >= 1n << 64n)) fail("constrData: tag outside Word64");
    if (!(v instanceof VCon) || v.type !== T_LIST_DATA) fail("constrData: fields are not a list of data");
    const fields = listToArray((v as VCon).v) as Data[];
    charge2(ctx, c, () => intSize(i), () => fields.reduce((s, f) => s + dataSize(f), 0));
    return vData(new DConstr(i, fields));
};
IMPL[38] = (ctx, c, a) => {
    const v = a[0]!;
    if (!(v instanceof VCon) || v.type !== T_LIST_PAIR_DATA) fail("mapData: not a list of data pairs");
    const es = listToArray((v as VCon).v) as VPair[];
    charge1(ctx, c, () => valueSize((v as VCon).type, (v as VCon).v));
    return vData(new DMap(es.map((p) => p instanceof DPair ? p : new DPair(p.fst, p.snd))));
};
IMPL[39] = (ctx, c, a) => {
    const v = a[0]!;
    if (!(v instanceof VCon) || v.type !== T_LIST_DATA) fail("listData: not a list of data");
    charge1(ctx, c, () => valueSize((v as VCon).type, (v as VCon).v));
    return vData(new DList(listToArray((v as VCon).v)));
};
IMPL[40] = (ctx, c, a) => { const i = int(a[0]!, "iData"); charge1(ctx, c, () => intSize(i)); return vData(new DInt(i)); };
IMPL[41] = (ctx, c, a) => { const b = bytes(a[0]!, "bData"); charge1(ctx, c, () => bytesSize(b)); return vData(new DBytes(b)); };
IMPL[42] = (ctx, c, a) => {
    const d = data(a[0]!, "unConstrData");
    charge1(ctx, c, () => dataSize(d));
    if (d.k !== DK.Constr) fail("unConstrData: not a constructor");
    return new VCon(T_PAIR_INT_LIST_DATA, new VPair((d as DConstr).tag, mkListFromArray((d as DConstr).fields)));
};
IMPL[43] = (ctx, c, a) => { const d = data(a[0]!, "unMapData"); charge1(ctx, c, () => dataSize(d)); if (d.k !== DK.Map) fail("unMapData: not a map"); return new VCon(T_LIST_PAIR_DATA, mkListFromArray((d as DMap).entries)); };
IMPL[44] = (ctx, c, a) => { const d = data(a[0]!, "unListData"); charge1(ctx, c, () => dataSize(d)); if (d.k !== DK.List) fail("unListData: not a list"); return new VCon(T_LIST_DATA, mkListFromArray((d as DList).items)); };
IMPL[45] = (ctx, c, a) => { const d = data(a[0]!, "unIData"); charge1(ctx, c, () => dataSize(d)); if (d.k !== DK.Int) fail("unIData: not an integer"); return vInt((d as DInt).v); };
IMPL[46] = (ctx, c, a) => { const d = data(a[0]!, "unBData"); charge1(ctx, c, () => dataSize(d)); if (d.k !== DK.Bytes) fail("unBData: not a bytestring"); return vBytes((d as DBytes).v); };
IMPL[47] = (ctx, c, a) => { const x = data(a[0]!, "equalsData"), y = data(a[1]!, "equalsData"); charge2(ctx, c, () => dataSize(x), () => dataSize(y)); return vBool(dataEq(x, y)); };
IMPL[48] = (ctx, c, a) => { const x = data(a[0]!, "mkPairData"), y = data(a[1]!, "mkPairData"); charge2(ctx, c, () => dataSize(x), () => dataSize(y)); return new VCon(T_PAIR_DATA, new DPair(x, y)); };
IMPL[49] = (ctx, c, a) => { con(a[0]!, T.unit, "mkNilData"); charge1(ctx, c, one); return new VCon(T_LIST_DATA, EMPTY_LIST); };
IMPL[50] = (ctx, c, a) => { con(a[0]!, T.unit, "mkNilPairData"); charge1(ctx, c, one); return new VCon(T_LIST_PAIR_DATA, EMPTY_LIST); };
IMPL[51] = (ctx, c, a) => { const d = data(a[0]!, "serialiseData"); charge1(ctx, c, () => dataSize(d)); return vBytes(encodeData(d)); };

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
IMPL[21] = (ctx, c, a) => {
    const pk = bytes(a[0]!, "verifyEd25519Signature"), msg = cbs(ctx, bytes(a[1]!, "verifyEd25519Signature"), "verifyEd25519Signature"), sg = bytes(a[2]!, "verifyEd25519Signature");
    charge3(ctx, c, () => bytesSize(pk), () => bytesSize(msg), () => bytesSize(sg));
    if (pk.length !== 32) fail("verifyEd25519Signature: public key must be 32 bytes");
    if (sg.length !== 64) fail("verifyEd25519Signature: signature must be 64 bytes");
    if (le(sg.subarray(32)) >= ED_L) return FALSE;
    const pkCopy = Uint8Array.from(pk); pkCopy[31]! &= 0x7f;
    if (le(pkCopy) >= ED_P || smallOrder(pk) || smallOrder(sg.subarray(0, 32))) return FALSE;
    let ok = false;
    try { ok = nodeVerify(null, msg, createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: "der", type: "spki" }), sg); } catch { ok = false; }
    return vBool(ok);
};

// secp256k1 (libsecp256k1 semantics): malformed keys, messages or signatures are evaluation
// failures; a well-formed signature that does not verify (including a high-S ECDSA one) is False.
const SECP_N = secp256k1.CURVE.n;
IMPL[52] = (ctx, c, a) => {
    const pk = bytes(a[0]!, "verifyEcdsaSecp256k1Signature"), msg = bytes(a[1]!, "verifyEcdsaSecp256k1Signature"), sg = bytes(a[2]!, "verifyEcdsaSecp256k1Signature");
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
};
IMPL[53] = (ctx, c, a) => {
    const pk = bytes(a[0]!, "verifySchnorrSecp256k1Signature"), msg = cbs(ctx, bytes(a[1]!, "verifySchnorrSecp256k1Signature"), "verifySchnorrSecp256k1Signature"), sg = bytes(a[2]!, "verifySchnorrSecp256k1Signature");
    charge3(ctx, c, () => bytesSize(pk), () => bytesSize(msg), () => bytesSize(sg));
    if (pk.length !== 32) fail("verifySchnorrSecp256k1Signature: public key must be 32 bytes");
    if (sg.length !== 64) fail("verifySchnorrSecp256k1Signature: signature must be 64 bytes");
    try { schnorr.utils.lift_x(BigInt("0x" + Buffer.from(pk).toString("hex"))); } catch { fail("verifySchnorrSecp256k1Signature: invalid public key"); }
    let ok = false;
    try { ok = schnorr.verify(sg, msg, pk); } catch { ok = false; }
    return vBool(ok);
};

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
IMPL[73] = (ctx, c, a) => {
    const be = con(a[0]!, T.bool, "integerToByteString"), w = int(a[1]!, "integerToByteString"), n = int(a[2]!, "integerToByteString");
    const ww = literalWords(w, "integerToByteString");
    charge3(ctx, c, one, () => ww, () => intSize(n));
    if (n < 0n) fail("integerToByteString: negative input");
    let bytes = toBE(n);
    if (w === 0n && BigInt(bytes.length) > MAX_OUT) fail("integerToByteString: result too long");
    const width = Number(w);
    if (width > 0 && bytes.length > width) fail("integerToByteString: width too small");
    if (width > bytes.length) { const o = new Uint8Array(width); o.set(bytes, width - bytes.length); bytes = o; }
    return vBytes(be ? bytes : bytes.slice().reverse());
};
IMPL[74] = (ctx, c, a) => {
    const be = con(a[0]!, T.bool, "byteStringToInteger"), b = cbs(ctx, bytes(a[1]!, "byteStringToInteger"), "byteStringToInteger");
    charge2(ctx, c, one, () => bytesSize(b));
    return vInt(fromBE(be ? b : b.slice().reverse()));
};
function bitwise(tag: number, name: string, op: (x: number, y: number) => number, padByte: number) {
    IMPL[tag] = (ctx, c, a) => {
        const pad = con(a[0]!, T.bool, name), x = cbs(ctx, bytes(a[1]!, name), name), y = cbs(ctx, bytes(a[2]!, name), name);
        charge3(ctx, c, one, () => bytesSize(x), () => bytesSize(y));
        const n = pad ? Math.max(x.length, y.length) : Math.min(x.length, y.length);
        const o = new Uint8Array(n);
        for (let i = 0; i < n; i++) o[i] = op(i < x.length ? x[i]! : padByte, i < y.length ? y[i]! : padByte) & 0xff;
        return vBytes(o);
    };
}
bitwise(75, "andByteString", (p, q) => p & q, 0xff);
bitwise(76, "orByteString", (p, q) => p | q, 0x00);
bitwise(77, "xorByteString", (p, q) => p ^ q, 0x00);
IMPL[78] = (ctx, c, a) => { const b = cbs(ctx, bytes(a[0]!, "complementByteString"), "complementByteString"); charge1(ctx, c, () => bytesSize(b)); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i]! ^ 0xff; return vBytes(o); };
IMPL[79] = (ctx, c, a) => {
    const b = cbs(ctx, bytes(a[0]!, "readBit"), "readBit"), i = int(a[1]!, "readBit");
    charge2(ctx, c, () => bytesSize(b), () => intSize(i));
    if (i < 0n || i >= BigInt(b.length * 8)) fail("readBit: index out of bounds");
    const k = Number(i);
    return vBool(((b[b.length - 1 - (k >> 3)]! >> (k & 7)) & 1) === 1);
};
IMPL[80] = (ctx, c, a) => {
    const b = bytes(a[0]!, "writeBits"), { l } = list(a[1]!, "writeBits"), set = con(a[2]!, T.bool, "writeBits");
    if ((a[1] as VCon).type !== ConstT.list(T.int)) fail("writeBits: indices are not a list of integers");
    const idx = listToArray(l) as bigint[];
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
};
IMPL[81] = (ctx, c, a) => {
    const n = int(a[0]!, "replicateByte"), x = int(a[1]!, "replicateByte");
    const nw = literalWords(n, "replicateByte");
    charge2(ctx, c, () => nw, () => intSize(x));
    if (x < 0n || x > 255n) fail("replicateByte: byte out of range");
    return vBytes(new Uint8Array(Number(n)).fill(Number(x)));
};
const absLiteral = (n: bigint) => { const m = n < 0n ? -n : n; return m > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(m); };
/** Variants D/E take the shift / rotation amount as an Int (sized 1) instead of `IntegerCostedLiterally`. */
function shiftAmount(ctx: BuiltinCtx, n: bigint, name: string): number {
    if (!ctx.bounded) return absLiteral(n);
    if (n < INT64_MIN || n > INT64_MAX) fail(`${name}: amount outside Int`);
    return 1;
}
IMPL[82] = (ctx, c, a) => {
    const b = bytes(a[0]!, "shiftByteString"), n = int(a[1]!, "shiftByteString");
    const sn = shiftAmount(ctx, n, "shiftByteString");
    charge2(ctx, c, () => bytesSize(b), () => sn);
    const bits = BigInt(b.length * 8);
    if ((n < 0n ? -n : n) >= bits) return vBytes(new Uint8Array(b.length));
    const v = fromBE(b), mask = (1n << bits) - 1n;
    const r = n >= 0n ? (v << n) & mask : v >> -n;
    const out = toBE(r), o = new Uint8Array(b.length); o.set(out, b.length - out.length);
    return vBytes(o);
};
IMPL[83] = (ctx, c, a) => {
    const b = bytes(a[0]!, "rotateByteString"), n = int(a[1]!, "rotateByteString");
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
};
IMPL[84] = (ctx, c, a) => { const b = cbs(ctx, bytes(a[0]!, "countSetBits"), "countSetBits"); charge1(ctx, c, () => bytesSize(b)); let n = 0; for (const x of b) { let y = x; while (y) { n += y & 1; y >>= 1; } } return vInt(BigInt(n)); };
IMPL[85] = (ctx, c, a) => {
    const b = cbs(ctx, bytes(a[0]!, "findFirstSetBit"), "findFirstSetBit");
    charge1(ctx, c, () => bytesSize(b));
    for (let j = b.length - 1, base = 0; j >= 0; j--, base += 8) { const x = b[j]!; if (x) return vInt(BigInt(base + (31 - Math.clz32(x & -x)))); }
    return vInt(-1n);
};
hash(86, "ripemd_160", (b) => ripemd160(b));

// ── batch 6 (van Rossem) ──
const EXPMOD_BOUND = 1n << 8191n;
function modInverse(a: bigint, m: bigint): bigint | null {
    let [r0, r1, t0, t1] = [m, ((a % m) + m) % m, 0n, 1n];
    while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; }
    return r0 === 1n ? ((t0 % m) + m) % m : null;
}
IMPL[87] = (ctx, c, a) => {
    const b = int(a[0]!, "expModInteger"), e = int(a[1]!, "expModInteger"), m = int(a[2]!, "expModInteger");
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
};
IMPL[88] = (ctx, c, a) => {
    const n = int(a[0]!, "dropList"), { l, t } = list(a[1]!, "dropList");
    charge2(ctx, c, () => absLiteral(n), () => valueSize(t, l));
    let cur: List = l;
    if (n > 0n) for (let i = 0n; i < n && !listIsEmpty(cur); i++) cur = listTail(cur);
    return new VCon(t, cur);
};
function arrayArg(v: Value, n: string): VCon { if (!(v instanceof VCon) || v.type.tag !== 12) fail(`${n}: argument is not an array`); return v as VCon; }
IMPL[89] = (ctx, c, a) => { const v = arrayArg(a[0]!, "lengthOfArray"); charge1(ctx, c, () => (v.v as VArray).arr.length); return vInt(BigInt((v.v as VArray).arr.length)); };
IMPL[90] = (ctx, c, a) => { const { l, t } = list(a[0]!, "listToArray"); charge1(ctx, c, () => valueSize(t, l)); return new VCon(ConstT.array(t.a!), new VArray(listToArray(l).slice())); };
IMPL[91] = (ctx, c, a) => {
    const v = arrayArg(a[0]!, "indexArray"), i = int(a[1]!, "indexArray");
    charge2(ctx, c, () => (v.v as VArray).arr.length, () => intSize(i));
    if (i < INT64_MIN || i > INT64_MAX) fail("indexArray: index outside Int");
    const arr = (v.v as VArray).arr;
    if (i < 0n || i >= BigInt(arr.length)) fail("indexArray: index out of bounds");
    return new VCon(v.type.a!, arr[Number(i)]);
};

// BLS12-381 multi-scalar multiplication: Σ sᵢ·Pᵢ over the zipped lists (the longer list's tail is
// ignored), every scalar — zipped or not — within [−2^4095, 2^4095 − 1] (`msmScalarOutOfBounds`);
// the empty sum is the identity. Costed on the lists' lengths.
const MSM_BOUND = 1n << 4095n;
function msm(tag: number, name: string, pointType: ConstType, isPoint: (p: any) => boolean, mul: (n: bigint, p: any) => any, add: (a: any, b: any) => any, zero: any) {
    IMPL[tag] = (ctx, c, a) => {
        const s = a[0]!, p = a[1]!;
        if (!(s instanceof VCon) || s.type !== ConstT.list(T.int)) fail(`${name}: scalars are not a list of integers`);
        if (!(p instanceof VCon) || p.type !== ConstT.list(pointType)) fail(`${name}: points are not a list of ${pointType.key}`);
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
    };
}
msm(92, "bls12_381_G1_multiScalarMul", T.g1, isBlsG1, bls12_381_G1_scalarMul, bls12_381_G1_add, BlsG1.ZERO);
msm(93, "bls12_381_G2_multiScalarMul", T.g2, isBlsG2, bls12_381_G2_scalarMul, bls12_381_G2_add, BlsG2.ZERO);

// ── Value builtins (multiasset.ts; costed on ValueMaxDepth, ValueTotalSize, DataNodeCount) ──
const vValue = (v: VValue) => new VCon(T.value, v);
const valueArg = (v: Value, n: string): VValue => con(v, T.value, n);
/** A Value operation's own failure (bounds, ordering, negative amounts) is an evaluation failure. */
function vop<X>(f: () => X): X { try { return f(); } catch (e) { if (e instanceof ValueError) fail(e.message); throw e; } }
IMPL[94] = (ctx, c, a) => {
    const cur = bytes(a[0]!, "insertCoin"), tok = bytes(a[1]!, "insertCoin"), amt = int(a[2]!, "insertCoin"), v = valueArg(a[3]!, "insertCoin");
    charge4(ctx, c, () => bytesSize(cur), () => bytesSize(tok), () => intSize(amt), () => valueMaxDepth(v));
    return vValue(vop(() => insertCoin(cur, tok, amt, v)));
};
IMPL[95] = (ctx, c, a) => {
    const cur = bytes(a[0]!, "lookupCoin"), tok = bytes(a[1]!, "lookupCoin"), v = valueArg(a[2]!, "lookupCoin");
    charge3(ctx, c, () => bytesSize(cur), () => bytesSize(tok), () => valueMaxDepth(v));
    return vInt(lookupCoin(cur, tok, v));
};
IMPL[96] = (ctx, c, a) => {
    const x = valueArg(a[0]!, "unionValue"), y = valueArg(a[1]!, "unionValue");
    charge2(ctx, c, () => x.total, () => y.total);
    return vValue(vop(() => unionValue(x, y)));
};
IMPL[97] = (ctx, c, a) => {
    const x = valueArg(a[0]!, "valueContains"), y = valueArg(a[1]!, "valueContains");
    charge2(ctx, c, () => x.total, () => y.total);
    return vBool(vop(() => valueContains(x, y)));
};
IMPL[98] = (ctx, c, a) => { const v = valueArg(a[0]!, "valueData"); charge1(ctx, c, () => v.total); return vData(vop(() => valueData(v))); };
IMPL[99] = (ctx, c, a) => { const d = data(a[0]!, "unValueData"); charge1(ctx, c, () => dataNodeCount(d)); return vValue(vop(() => unValueData(d))); };
IMPL[100] = (ctx, c, a) => {
    const k = int(a[0]!, "scaleValue"), v = valueArg(a[1]!, "scaleValue");
    charge2(ctx, c, () => intSize(k), () => v.total);
    return vValue(vop(() => scaleValue(k, v)));
};

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

/** Run a saturated builtin; throws EvalFailure (or the budget error from `spend`). */
export function callBuiltin(ctx: BuiltinCtx, tag: number, args: Value[]): Value {
    if (TRACE) {
        let out: Value | string;
        try { out = callBuiltinInner(ctx, tag, args); } catch (e) { out = `ERROR ${(e as Error).message}`; console.error(`BUILTIN ${tag} ${args.map(show).join(", ")} -> ${out}`); throw e; }
        console.error(`BUILTIN ${tag} ${args.map(show).join(", ")} -> ${show(out)}`);
        return out;
    }
    return callBuiltinInner(ctx, tag, args);
}
/** GEROLAMO_PLUTUS_BUILTIN_TRACE=1: one line per saturated builtin call (align with tools/uplc-ref's UPLC_BUILTIN_TRACE). */
const TRACE = process.env.GEROLAMO_PLUTUS_BUILTIN_TRACE === "1";
function show(v: any): string {
    if (!(v instanceof VCon)) return v?.constructor?.name ?? String(v);
    const x = v.v;
    switch (v.type.tag) {
        case 0: return String(x);
        case 1: return "#" + Buffer.from(x).toString("hex").slice(0, process.env.GEROLAMO_PLUTUS_BUILTIN_TRACE_FULL ? undefined : 64);
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
function delegatedBounds(ctx: BuiltinCtx, tag: number, args: Value[]) {
    const a0 = args[0];
    if (!(a0 instanceof VCon)) return;
    if ((tag === 56 || tag === 63) && a0.type === T.int && (a0.v >= MSM_BOUND || a0.v < -MSM_BOUND)) fail(`${BN_NAMES[tag]}: scalar exceeds the 512-byte bound`);
    if ((tag === 60 || tag === 67) && a0.type === T.bytes) cbs(ctx, a0.v, BN_NAMES[tag]!);
}
function callBuiltinInner(ctx: BuiltinCtx, tag: number, args: Value[]): Value {
    if (ctx.bounded && (tag === 56 || tag === 63 || tag === 60 || tag === 67)) delegatedBounds(ctx, tag, args);
    const impl = IMPL[tag];
    if (impl) {
        const c = ctx.costs.builtins[tag];
        if (!c) fail(`builtin ${tag} has no cost model`);
        return impl(ctx, c!, args);
    }
    return delegated(ctx, tag, args);
}
export { VBuiltin, UNIT };
