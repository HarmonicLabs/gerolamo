/**
 * Evaluator values and constant types (src/consensus/plutus/cek.ts).
 *
 * Constant types are interned objects with a structural `key`, so type equality is one string
 * compare. Lists are immutable: an array view (`LArr`, O(1) tail over data fields and list
 * items) or a cons cell (`LCons`, O(1) mkCons), never copied by the list builtins.
 */
import type { Data } from "./data";

/** Flat type tags: 0 integer, 1 bytestring, 2 string, 3 unit, 4 bool, 5 list, 6 pair, 8 data, 9 G1, 10 G2, 11 ML result, 12 array, 13 value. */
export interface ConstType { readonly tag: number; readonly a?: ConstType; readonly b?: ConstType; readonly key: string }
const interned = new Map<string, ConstType>();
function mk(tag: number, a?: ConstType, b?: ConstType): ConstType {
    const key = a ? (b ? `(${tag} ${a.key} ${b.key})` : `(${tag} ${a.key})`) : String(tag);
    let t = interned.get(key);
    if (!t) { t = { tag, a, b, key }; interned.set(key, t); }
    return t;
}
export const ConstT = { list: (a: ConstType) => mk(5, a), pair: (a: ConstType, b: ConstType) => mk(6, a, b), array: (a: ConstType) => mk(12, a) };
export const T = {
    int: mk(0), bytes: mk(1), string: mk(2), unit: mk(3), bool: mk(4), data: mk(8), g1: mk(9), g2: mk(10), ml: mk(11), value: mk(13),
} as const;
export const T_LIST_DATA = ConstT.list(T.data);
export const T_PAIR_DATA = ConstT.pair(T.data, T.data);
export const T_LIST_PAIR_DATA = ConstT.list(T_PAIR_DATA);
export const T_PAIR_INT_LIST_DATA = ConstT.pair(T.int, T_LIST_DATA);

export class VPair { constructor(readonly fst: any, readonly snd: any) {} }
/** An immutable array constant (type tag 12): O(1) length and index. */
export class VArray { constructor(readonly arr: readonly any[]) {} }

/** Immutable list: array view or cons cell. */
export class LArr { constructor(readonly arr: readonly any[], readonly off: number) {} }
export class LCons { constructor(readonly head: any, readonly tail: List) {} }
export type List = LArr | LCons;
export const EMPTY_LIST = new LArr([], 0);
export function mkListFromArray(arr: readonly any[]): List { return arr.length === 0 ? EMPTY_LIST : new LArr(arr, 0); }
export function listIsEmpty(l: List): boolean { return l instanceof LArr ? l.off >= l.arr.length : false; }
export function listHead(l: List): any { return l instanceof LArr ? l.arr[l.off] : l.head; }
export function listTail(l: List): List { return l instanceof LArr ? new LArr(l.arr, l.off + 1) : l.tail; }
export function listToArray(l: List): any[] {
    if (l instanceof LArr) return l.off === 0 ? l.arr as any[] : l.arr.slice(l.off);
    const out: any[] = [];
    let c: List = l;
    while (c instanceof LCons) { out.push(c.head); c = c.tail; }
    for (let i = c.off; i < c.arr.length; i++) out.push(c.arr[i]);
    return out;
}

/** A constant: `v` is bigint | Uint8Array | string | null (unit) | boolean | Data | List | VPair | VArray | BLS point | VValue (multiasset.ts). */
export class VCon { constructor(readonly type: ConstType, readonly v: any) {} }
export class VLam { constructor(readonly body: any, readonly env: Env) {} }
export class VDelay { constructor(readonly body: any, readonly env: Env) {} }
export class VConstr { constructor(readonly tag: number, readonly fields: Value[]) {} }
/** A builtin awaiting `forces` more forces, then arguments (all forces precede all arguments). */
export class VBuiltin { constructor(readonly fn: number, readonly forces: number, readonly args: Value[]) {} }
export type Value = VCon | VLam | VDelay | VConstr | VBuiltin;

/** Environment: a linked list, index 1 = innermost binding (de Bruijn). */
export class Env { constructor(readonly v: Value, readonly next: Env | null) {} }

export const UNIT = new VCon(T.unit, null);
export const TRUE = new VCon(T.bool, true);
export const FALSE = new VCon(T.bool, false);
export type { Data };
