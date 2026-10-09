/**
 * Flat decoder for on-chain UPLC programs (plutus-core `Flat` instances, de Bruijn indices),
 * straight into the evaluator's terms. Unlike @harmoniclabs/uplc's decoder it keeps `force`
 * nodes around builtins (a builtin must receive exactly its forces, in the machine), reads
 * bits with Number arithmetic, and checks the builtin set and the language version against
 * the ledger language and protocol version (PlutusLedgerApi.Common.Versions), and from van Rossem
 * (protocol 11) the decoder's bounds (`maxBoundsByPV`: constant types of size at most 32, `constr`
 * with at most 1024 fields). Semantics are plutus-core 1.63.0.0's, the version inside
 * cardano-node 11.0.1.
 */
import { decodeData, type Data } from "./data";
import { ConstT, T, type ConstType, VArray, VCon, mkListFromArray, VPair } from "./values";
import { MAX_KEY_LEN, QUANTITY_MAX, QUANTITY_MIN, ValueError, buildValueStrict } from "./multiasset";

export const enum TK { Var = 0, Delay = 1, Lam = 2, Apply = 3, Const = 4, Force = 5, Error = 6, Builtin = 7, Constr = 8, Case = 9 }
export type Term =
    | { k: TK.Var; i: number }
    | { k: TK.Delay; b: Term }
    | { k: TK.Lam; b: Term }
    | { k: TK.Apply; f: Term; a: Term }
    | { k: TK.Const; v: VCon }
    | { k: TK.Force; b: Term }
    | { k: TK.Error }
    | { k: TK.Builtin; fn: number; cached: any }
    | { k: TK.Constr; tag: number; fields: Term[] }
    | { k: TK.Case; s: Term; bs: Term[] };

export interface Program { version: [number, number, number]; term: Term }

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

/**
 * `deserialiseOnly`: what plutus-ledger-api `deserialiseScript` checks (phase 1, the ledger's
 * `isValidPlutusScript`) and nothing that `mkTermToEvaluate` checks at evaluation: any Plutus Core
 * version decodes (`constr` / `case` need the program's version ≥ 1.1.0, as in the UPLC flat
 * decoder), the version's availability for the language and de Bruijn index 0 (scope) are not
 * checked. Default: the evaluator's full set.
 */
export function decodeProgram(bytes: Uint8Array, lang: 1 | 2 | 3 | 4, pv: number, opts: { deserialiseOnly?: boolean } = {}): Program {
    let pos = 0; // bit position
    let v110 = false;
    const avail = builtinsAvailable(lang, pv);
    const bounded = pv >= 11;
    const bit = (): number => { const b = (bytes[pos >> 3]! >> (7 - (pos & 7))) & 1; pos++; return b; };
    const bits = (n: number): number => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            if ((pos >> 3) >= bytes.length) throw new FlatError("flat: out of input");
            v = (v << 1) | bit();
        }
        return v;
    };
    const byte = (): number => {
        if ((pos & 7) === 0) { if ((pos >> 3) >= bytes.length) throw new FlatError("flat: out of input"); const b = bytes[pos >> 3]!; pos += 8; return b; }
        return bits(8);
    };
    const natural = (): bigint | number => {
        let n = 0, shift = 0, big: bigint | null = null;
        for (;;) {
            const w = byte();
            const chunk = w & 127;
            if (big === null && shift <= 45) n += chunk * 2 ** shift;
            else { if (big === null) big = BigInt(n); big |= BigInt(chunk) << BigInt(shift); }
            shift += 7;
            if ((w & 128) === 0) break;
        }
        return big === null ? n : big;
    };
    const smallNat = (): number => { const n = natural(); if (typeof n !== "number") throw new FlatError("flat: natural too large"); return n; };
    const integer = (): bigint => {
        const z = natural();
        const b = typeof z === "number" ? BigInt(z) : z;
        return (b & 1n) === 0n ? b >> 1n : -((b >> 1n) + 1n);
    };
    const filler = () => { while (bit() === 0) { /* padding */ } if ((pos & 7) !== 0) throw new FlatError("flat: misaligned filler"); };
    const byteString = (): Uint8Array => {
        filler();
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const len = bytes[pos >> 3]!; pos += 8;
            if (len === 0) break;
            const start = pos >> 3;
            if (start + len > bytes.length) throw new FlatError("flat: bytestring out of input");
            parts.push(bytes.subarray(start, start + len)); total += len; pos += len * 8;
        }
        const out = new Uint8Array(total);
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    const list = <X>(item: () => X): X[] => { const out: X[] = []; while (bit() === 1) out.push(item()); return out; };
    const typeTags = (): number[] => list(() => bits(4));
    const parseType = (tags: number[], i: { p: number }): ConstType => {
        const t = tags[i.p++];
        switch (t) {
            case 0: return T.int; case 1: return T.bytes; case 2: return T.string; case 3: return T.unit; case 4: return T.bool; case 8: return T.data;
            // BLS12-381 types decode (an empty list of points is a valid constant); a value of one does not
            case 9: return T.g1; case 10: return T.g2; case 11: return T.ml; case 13: return T.value;
            case 7: {
                const f = tags[i.p++];
                if (f === 5) return ConstT.list(parseType(tags, i));
                // arrays are not gated on the language version (plutus-core's flat decoder only knows the universe)
                if (f === 12) return ConstT.array(parseType(tags, i));
                if (f === 7) { if (tags[i.p++] !== 6) throw new FlatError("flat: bad type application"); const a = parseType(tags, i); return ConstT.pair(a, parseType(tags, i)); }
                throw new FlatError(`flat: unsupported type application ${f}`);
            }
        }
        throw new FlatError(`flat: unsupported constant type tag ${t}`);
    };
    const value = (t: ConstType): any => {
        switch (t.tag) {
            case 0: return integer();
            case 1: return byteString();
            case 2: {
                const b = byteString();
                try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { throw new FlatError("flat: invalid utf-8 string constant"); }
            }
            case 3: return null;
            case 4: return bit() === 1;
            case 8: { const b = byteString(); try { return decodeData(b) as Data; } catch (e) { throw new FlatError(`flat: bad data constant: ${(e as Error).message}`); } }
            case 5: return mkListFromArray(list(() => value(t.a!)));
            case 12: return new VArray(list(() => value(t.a!)));
            case 6: { const a = value(t.a!); return new VPair(a, value(t.b!)); }
            case 9: case 10: case 11: throw new FlatError("flat: BLS12-381 values cannot be flat-decoded");
            case 13: {
                // `Flat Value`: [(K, [(K, Quantity)])] through `buildValueWith` (keys ≤ 32 bytes, 128-bit quantities)
                const key = (): Uint8Array => { const b = byteString(); if (b.length > MAX_KEY_LEN) throw new FlatError("flat: invalid Value key"); return b; };
                const outer = list(() => { const c = key(); return [c, list(() => { const k = key(); const q = integer(); if (q < QUANTITY_MIN || q > QUANTITY_MAX) throw new FlatError("flat: Value quantity out of signed 128-bit bounds"); return [k, q] as const; })] as const; });
                try { return buildValueStrict(outer, "Value Flat decoder"); } catch (e) { if (e instanceof ValueError) throw new FlatError(`flat: ${e.message}`); throw e; }
            }
        }
        throw new FlatError("flat: unsupported constant");
    };
    const term = (): Term => {
        const tag = bits(4);
        switch (tag) {
            case TK.Var: { const i = smallNat(); if (i === 0 && !opts.deserialiseOnly) throw new FlatError("flat: de Bruijn index 0"); return { k: TK.Var, i }; }
            case TK.Delay: return { k: TK.Delay, b: term() };
            case TK.Lam: return { k: TK.Lam, b: term() };
            case TK.Apply: { const f = term(); return { k: TK.Apply, f, a: term() }; }
            case TK.Const: {
                const tags = typeTags(); const i = { p: 0 }; const ty = parseType(tags, i);
                if (i.p !== tags.length) throw new FlatError("flat: trailing type tags");
                const v = new VCon(ty, value(ty));
                if (bounded && constTypeSize(ty) > MAX_CONST_TYPE_SIZE) throw new FlatError(`flat: constant of type size ${constTypeSize(ty)} not available at protocol ${pv}`);
                return { k: TK.Const, v };
            }
            case TK.Force: return { k: TK.Force, b: term() };
            case TK.Error: return { k: TK.Error };
            case TK.Builtin: { const fn = bits(7); if (!avail.has(fn)) throw new FlatError(`flat: builtin ${fn} not available in Plutus V${lang} at protocol ${pv}`); return { k: TK.Builtin, fn, cached: null }; }
            case TK.Constr: {
                if (!v110) throw new FlatError("flat: constr needs Plutus Core 1.1.0");
                // a Word64 tag: a Number, or beyond 2^52 the exact bigint (it can only select no branch, but it is the result's tag)
                const n = natural(); if (typeof n === "bigint" && n >= 1n << 64n) throw new FlatError("flat: constr tag too large");
                const t = (typeof n === "bigint" && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n) as number;
                const fields = list(term);
                if (bounded && fields.length > MAX_CONSTR_FIELDS) throw new FlatError(`flat: constr with ${fields.length} fields not available at protocol ${pv}`);
                return { k: TK.Constr, tag: t, fields };
            }
            case TK.Case: { if (!v110) throw new FlatError("flat: case needs Plutus Core 1.1.0"); const s = term(); return { k: TK.Case, s, bs: list(term) }; }
        }
        throw new FlatError(`flat: unknown term tag ${tag}`);
    };
    const version: [number, number, number] = [smallNat(), smallNat(), smallNat()];
    const vkey = version.join(".");
    if (opts.deserialiseOnly) v110 = version[0] > 1 || (version[0] === 1 && version[1] >= 1);
    else {
        if (vkey !== "1.0.0" && vkey !== "1.1.0" && !(vkey === "1.2.0" && plc120Available(lang, pv))) throw new FlatError(`flat: unsupported Plutus Core version ${vkey}`);
        if (vkey === "1.1.0" && !plc110Available(lang, pv)) throw new FlatError(`flat: Plutus Core 1.1.0 not available in Plutus V${lang} at protocol ${pv}`);
        v110 = vkey === "1.1.0" || vkey === "1.2.0";
    }
    const t = term();
    filler();
    if ((pos >> 3) !== bytes.length) throw new FlatError("flat: trailing bytes after program");
    return { version, term: t };
}
