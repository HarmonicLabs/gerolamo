/**
 * Evaluator values and constant types (src/consensus/plutus/cek.ts).
 *
 * Constant types are interned objects with a structural `key`, so type equality is one string
 * compare. Lists are immutable: an array view (`LArr`, O(1) tail over data fields and list
 * items) or a cons cell (`LCons`, O(1) mkCons), never copied by the list builtins.
 *
 * Constants, constructors and builtins carry a numeric `kind` (`VK`) so the machine dispatches on
 * them with one switch; closures (`VLam`, `VDelay`) do not: they are the bulk of what an evaluation
 * allocates, and with two inline properties they take 32 bytes instead of 48 in JavaScriptCore's
 * size classes, so the machine tests them with `instanceof` (a structure check). A partially
 * applied builtin is a chain of six-field objects, one per argument (no array per application);
 * `args` is a view for the few callers that print or discharge values. Environments carry a skip
 * pointer two bindings back, halving the walk of a de Bruijn lookup.
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

/** Value kinds (`kind` field of the constant, constructor and builtin values; closures have none). */
export const enum VK { Con = 0, Constr = 3, Builtin = 4 }

/** A constant: `v` is bigint | Uint8Array | string | null (unit) | boolean | Data | List | VPair | VArray | BLS point | VValue (multiasset.ts). */
export class VCon { readonly kind: number; constructor(readonly type: ConstType, readonly v: any) { this.kind = 0; } }
/** A closure: `body` is a node of the program being evaluated (flat.ts `Code`). Two properties: 32 bytes. */
export class VLam { constructor(readonly body: number, readonly env: Env | null) {} }
export class VDelay { constructor(readonly body: number, readonly env: Env | null) {} }
export class VConstr { readonly kind: number; constructor(readonly tag: number, readonly fields: Value[]) { this.kind = 3; } }
/**
 * A builtin awaiting `forces` more forces, then arguments (all forces precede all arguments);
 * `n` arguments applied so far. A partial application (n ≥ 1) holds its last argument in `arg`
 * and the application before it in `link` (so the arguments form a chain; a builtin takes at most
 * 6 and the last one is never stored: that application saturates). For an unapplied builtin
 * (n = 0) `link` caches the value one more force yields (such a value is immutable and shared,
 * so the cache is sound). Six fields: the object stays within the inline property storage.
 */
export class VBuiltin {
    readonly kind: number;
    link: VBuiltin | null;
    constructor(readonly fn: number, readonly forces: number, readonly n: number, readonly arg: Value | null, link: VBuiltin | null) { this.link = link; this.kind = 4; }
    /** The applied arguments, in order (a copy). */
    get args(): Value[] {
        const out: Value[] = [];
        for (let b: VBuiltin | null = this; b !== null && b.n > 0; b = b.link) out.push(b.arg!);
        return out.reverse();
    }
}
/** An unapplied builtin value. */
export function mkBuiltin(fn: number, forces: number): VBuiltin { return new VBuiltin(fn, forces, 0, null, null); }
export type Value = VCon | VLam | VDelay | VConstr | VBuiltin;

/**
 * Environment: a linked list, index 1 = innermost binding (de Bruijn). `s2` skips two bindings
 * (the node after `next`), so a lookup of index i walks about i/2 nodes: compiled scripts look up
 * 7–12 bindings deep on average, and the walk is dependent loads.
 */
export class Env {
    readonly s2: Env | null;
    constructor(readonly v: Value, readonly next: Env | null) { this.s2 = next === null ? null : next.next; }
}

export const UNIT = new VCon(T.unit, null);
export const TRUE = new VCon(T.bool, true);
export const FALSE = new VCon(T.bool, false);
export type { Data };
