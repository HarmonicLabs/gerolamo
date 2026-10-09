/**
 * Textual UPLC (plutus-core's concrete syntax, `PlutusCore.Parser`) to the evaluator's terms, and
 * evaluation results back to comparable terms — for the official conformance suite
 * (plutus-conformance/test-cases, scripts/plutus-conformance.ts) and the builtin unit tests.
 * Not on the validation path: scripts arrive flat-encoded (flat.ts).
 *
 * Covers what the suite uses: `(program v t)`, lam / delay / force / builtin / con / error /
 * constr / case, `[f a b …]` applications, `-- …` comments, Haskell string escapes, and the
 * constants of every type including data, BLS12-381 points (`0x…`), arrays and values.
 */
import { bls12_381_G1_uncompress, bls12_381_G2_uncompress } from "@harmoniclabs/crypto";
import { DBytes, DConstr, DInt, DList, DMap, DPair, dataEq, encodeData as encodeDataBytes, type Data } from "./data";
import { TK, type Term } from "./flat";
import { BUILTIN_NAMES } from "./costs";
import { SIGNATURE } from "./builtins";
import { valueEq, valueFromList, type VValue } from "./multiasset";
import { ConstT, Env, T, VArray, VBuiltin, VCon, VConstr, VDelay, VLam, VPair, listToArray, mkListFromArray, type ConstType, type Value } from "./values";

export class UplcParseError extends Error {}
/** A program with a free variable: plutus-conformance's evaluator reports an evaluation failure. */
export class FreeVariableError extends Error {}

const BUILTIN_TAGS = new Map(BUILTIN_NAMES.slice(0, 101).map((n, i) => [n, i]));
const isIdent = (c: string) => /[A-Za-z0-9_']/.test(c);

export function parseProgram(src: string): { version: [number, number, number]; term: Term } {
    let p = 0;
    const err = (m: string): never => { throw new UplcParseError(`${m} at ${p}`); };
    const ws = () => {
        for (;;) {
            while (p < src.length && /\s/.test(src[p]!)) p++;
            if (src.startsWith("--", p)) { while (p < src.length && src[p] !== "\n") p++; continue; }
            if (src.startsWith("{-", p)) { const e = src.indexOf("-}", p + 2); if (e < 0) err("unterminated comment"); p = e + 2; continue; }
            break;
        }
    };
    const sym = (s: string) => { ws(); if (!src.startsWith(s, p)) err(`expected ${s}`); p += s.length; };
    const peek = (s: string) => { ws(); return src.startsWith(s, p); };
    const ident = (): string => {
        ws(); const s = p;
        while (p < src.length && isIdent(src[p]!)) p++;
        if (s === p) err("expected identifier");
        // a printed name carries its unique: `x-0`
        if (src[p] === "-" && /[0-9]/.test(src[p + 1] ?? "")) { p++; while (p < src.length && /[0-9]/.test(src[p]!)) p++; }
        return src.slice(s, p);
    };
    const keyword = (k: string) => { const s = p; const id = ident(); if (id !== k) { p = s; err(`expected ${k}`); } };
    const decimal = (): bigint => {
        ws();
        let s = p, neg = false;
        if (src[p] === "-" || src[p] === "+") { neg = src[p] === "-"; p++; ws(); s = p; }
        while (p < src.length && /[0-9]/.test(src[p]!)) p++;
        if (s === p) err("expected integer");
        const v = BigInt(src.slice(s, p));
        return neg ? -v : v;
    };
    const hexBytes = (prefix: string): Uint8Array => {
        sym(prefix);
        const s = p;
        while (p < src.length && /[0-9a-fA-F]/.test(src[p]!)) p++;
        if ((p - s) % 2) err("odd number of hex digits");
        return new Uint8Array(Buffer.from(src.slice(s, p), "hex"));
    };
    const ASCII = ["NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "HT", "LF", "VT", "FF", "CR", "SO", "SI", "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US", "SP"];
    const stringLit = (): string => {
        sym("\"");
        let out = "";
        for (;;) {
            if (p >= src.length) err("unterminated string");
            const c = src[p++]!;
            if (c === "\"") break;
            if (c !== "\\") { out += c; continue; }
            const e = src[p]!;
            const simple: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "\"": "\"", "'": "'", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
            if (e in simple) { out += simple[e]; p++; continue; }
            if (e === "&") { p++; continue; }
            const num = (re: RegExp, base: number) => { const s = p; while (p < src.length && re.test(src[p]!)) p++; if (s === p) err("bad escape"); const n = parseInt(src.slice(s, p), base); if (n > 0x10ffff) err("escape out of range"); out += String.fromCodePoint(n >= 0xd800 && n <= 0xdfff ? 0xfffd : n); };
            if (/[0-9]/.test(e)) { num(/[0-9]/, 10); continue; }
            if (e === "x") { p++; num(/[0-9a-fA-F]/, 16); continue; }
            if (e === "o") { p++; num(/[0-7]/, 8); continue; }
            if (e === "^") { const k = src.charCodeAt(p + 1); p += 2; out += String.fromCharCode(k - 64); continue; }
            if (src.startsWith("DEL", p)) { p += 3; out += "\x7f"; continue; }
            // longest ASCII control name first (SOH before SO)
            const name = [...ASCII].sort((x, y) => y.length - x.length).find((n) => src.startsWith(n, p));
            if (name) { p += name.length; out += String.fromCharCode(name === "SP" ? 32 : ASCII.indexOf(name)); continue; }
            err("bad escape");
        }
        return out;
    };
    const type = (): ConstType => {
        if (peek("(")) {
            sym("(");
            const k = ident();
            let t: ConstType;
            if (k === "list") t = ConstT.list(type());
            else if (k === "array") t = ConstT.array(type());
            else if (k === "pair") { const a = type(); t = ConstT.pair(a, type()); }
            else return err(`unknown type operator ${k}`);
            sym(")");
            return t;
        }
        const k = ident();
        const atoms: Record<string, ConstType> = {
            integer: T.int, bytestring: T.bytes, string: T.string, unit: T.unit, bool: T.bool, data: T.data, value: T.value,
            bls12_381_G1_element: T.g1, bls12_381_G2_element: T.g2, bls12_381_mlresult: T.ml,
        };
        return atoms[k] ?? err(`unknown type ${k}`);
    };
    const listOf = <X>(item: () => X): X[] => {
        sym("[");
        const out: X[] = [];
        if (peek("]")) { sym("]"); return out; }
        for (;;) { out.push(item()); if (peek(",")) { sym(","); continue; } sym("]"); return out; }
    };
    const pairOf = <A, B>(a: () => A, b: () => B): [A, B] => { sym("("); const x = a(); sym(","); const y = b(); sym(")"); return [x, y]; };
    const dataNoParens = (): Data => {
        const k = ident();
        switch (k) {
            case "Constr": { const tag = decimal(); return new DConstr(tag, listOf(dataNoParens)); }
            case "Map": return new DMap(listOf(() => { const [a, b] = pairOf(dataNoParens, dataNoParens); return new DPair(a, b); }));
            case "List": return new DList(listOf(dataNoParens));
            case "I": return new DInt(decimal());
            case "B": return new DBytes(hexBytes("#"));
        }
        return err(`unknown data constructor ${k}`);
    };
    const constant = (t: ConstType, parens: boolean): any => {
        switch (t.tag) {
            case 0: return decimal();
            case 1: return hexBytes("#");
            case 2: return stringLit();
            case 3: sym("("); sym(")"); return null;
            case 4: { const k = ident(); if (k === "True") return true; if (k === "False") return false; return err("expected bool"); }
            case 5: return mkListFromArray(listOf(() => constant(t.a!, false)));
            case 12: return new VArray(listOf(() => constant(t.a!, false)));
            case 6: { const [a, b] = pairOf(() => constant(t.a!, false), () => constant(t.b!, false)); return new VPair(a, b); }
            case 8: { if (!parens) return dataNoParens(); sym("("); const d = dataNoParens(); sym(")"); return d; }
            case 9: case 10: {
                const b = hexBytes("0x");
                try { return t.tag === 9 ? bls12_381_G1_uncompress(b) : bls12_381_G2_uncompress(b); } catch { return err("bad BLS12-381 point"); }
            }
            case 11: return err("bls12_381_mlresult constants are not supported");
            case 13: {
                const xs = listOf(() => pairOf(() => hexBytes("#"), () => listOf(() => pairOf(() => hexBytes("#"), decimal))));
                try { return valueFromList(xs); } catch (e) { return err((e as Error).message); }
            }
        }
        return err("unsupported constant type");
    };
    let v110 = false;
    let freeVar = false;
    const term = (scope: string[]): Term => {
        if (peek("[")) {
            sym("[");
            let f = term(scope);
            let n = 0;
            while (!peek("]")) { f = { k: TK.Apply, f, a: term(scope) }; n++; }
            sym("]");
            if (n === 0) err("application without arguments");
            return f;
        }
        if (peek("(")) {
            sym("(");
            const k = ident();
            let t: Term;
            switch (k) {
                case "lam": { const x = ident(); t = { k: TK.Lam, b: term([x, ...scope]) }; break; }
                case "delay": t = { k: TK.Delay, b: term(scope) }; break;
                case "force": t = { k: TK.Force, b: term(scope) }; break;
                case "error": t = { k: TK.Error }; break;
                case "builtin": { const n = ident(); const fn = BUILTIN_TAGS.get(n); if (fn === undefined) err(`unknown builtin ${n}`); t = { k: TK.Builtin, fn: fn!, cached: null }; break; }
                case "con": { const ty = type(); t = { k: TK.Const, v: new VCon(ty, constant(ty, true)) }; break; }
                case "constr": {
                    if (!v110) err("constr needs 1.1.0");
                    const tag = decimal(); if (tag < 0n || tag >= 1n << 64n) err("constr tag out of Word64");
                    const fields: Term[] = []; while (!peek(")")) fields.push(term(scope));
                    t = { k: TK.Constr, tag: (tag <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(tag) : tag) as number, fields }; break;
                }
                case "case": {
                    if (!v110) err("case needs 1.1.0");
                    const s = term(scope); const bs: Term[] = []; while (!peek(")")) bs.push(term(scope));
                    t = { k: TK.Case, s, bs }; break;
                }
                default: return err(`unknown term ${k}`);
            }
            sym(")");
            return t;
        }
        const x = ident();
        const i = scope.indexOf(x);
        if (i < 0) { freeVar = true; return { k: TK.Error }; }
        return { k: TK.Var, i: i + 1 };
    };
    sym("("); keyword("program");
    ws();
    const vs = p; while (p < src.length && /[0-9.]/.test(src[p]!)) p++;
    const parts = src.slice(vs, p).split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) err("bad version");
    const version = parts as [number, number, number];
    v110 = version[0] === 1 && version[1] >= 1;
    // 1.2.0 (plutus master, Dijkstra) adds no term form; whether a ledger language may use it is the flat decoder's call
    if (version[0] !== 1 || version[1] > 2 || version[2] !== 0) err("unsupported version");
    const t = term([]);
    sym(")"); ws();
    if (p !== src.length) err("trailing input");
    if (freeVar) throw new FreeVariableError("free variable");
    return { version, term: t };
}

/** `dischargeCekValue`: a result value as a closed term (environments substituted). */
export function discharge(v: Value): Term {
    if (v instanceof VCon) return { k: TK.Const, v };
    if (v instanceof VDelay) return { k: TK.Delay, b: dischargeTerm(v.body, v.env, 0) };
    if (v instanceof VLam) return { k: TK.Lam, b: dischargeTerm(v.body, v.env, 1) };
    if (v instanceof VConstr) return { k: TK.Constr, tag: v.tag, fields: v.fields.map(discharge) };
    if (v instanceof VBuiltin) {
        let t: Term = { k: TK.Builtin, fn: v.fn, cached: null };
        for (let i = SIGNATURE[v.fn]![0] - v.forces; i > 0; i--) t = { k: TK.Force, b: t };
        for (const a of v.args) t = { k: TK.Apply, f: t, a: discharge(a) };
        return t;
    }
    throw new Error("unknown value");
}
function dischargeTerm(t: Term, env: Env | null, depth: number): Term {
    switch (t.k) {
        case TK.Var: {
            if (t.i <= depth) return t;
            let e = env, i = t.i - depth;
            while (--i > 0 && e) e = e.next;
            return e ? discharge(e.v) : t;
        }
        case TK.Lam: return { k: TK.Lam, b: dischargeTerm(t.b, env, depth + 1) };
        case TK.Delay: return { k: TK.Delay, b: dischargeTerm(t.b, env, depth) };
        case TK.Force: return { k: TK.Force, b: dischargeTerm(t.b, env, depth) };
        case TK.Apply: return { k: TK.Apply, f: dischargeTerm(t.f, env, depth), a: dischargeTerm(t.a, env, depth) };
        case TK.Constr: return { k: TK.Constr, tag: t.tag, fields: t.fields.map((f) => dischargeTerm(f, env, depth)) };
        case TK.Case: return { k: TK.Case, s: dischargeTerm(t.s, env, depth), bs: t.bs.map((b) => dischargeTerm(b, env, depth)) };
        default: return t;
    }
}

function constEq(t: ConstType, a: any, b: any): boolean {
    switch (t.tag) {
        case 0: case 2: case 3: case 4: return a === b;
        case 1: return Buffer.from(a).equals(Buffer.from(b));
        case 8: return dataEq(a, b);
        case 5: { const x = listToArray(a), y = listToArray(b); return x.length === y.length && x.every((e, i) => constEq(t.a!, e, y[i])); }
        case 12: { const x = (a as VArray).arr, y = (b as VArray).arr; return x.length === y.length && x.every((e, i) => constEq(t.a!, e, y[i])); }
        case 6: return constEq(t.a!, a.fst, b.fst) && constEq(t.b!, a.snd, b.snd);
        case 9: case 10: return a.equals(b);
        case 13: return valueEq(a as VValue, b as VValue);
    }
    return false;
}
/** Structural equality of de Bruijn terms (α-equivalence of the named ones). */
export function termEq(a: Term, b: Term): boolean {
    if (a.k !== b.k) return false;
    switch (a.k) {
        case TK.Var: return a.i === (b as typeof a).i;
        case TK.Lam: case TK.Delay: case TK.Force: return termEq(a.b, (b as typeof a).b);
        case TK.Apply: return termEq(a.f, (b as typeof a).f) && termEq(a.a, (b as typeof a).a);
        case TK.Error: return true;
        case TK.Builtin: return a.fn === (b as typeof a).fn;
        case TK.Const: { const x = a.v, y = (b as typeof a).v; return x.type === y.type && constEq(x.type, x.v, y.v); }
        case TK.Constr: { const y = b as typeof a; return a.tag === y.tag && a.fields.length === y.fields.length && a.fields.every((f, i) => termEq(f, y.fields[i]!)); }
        case TK.Case: { const y = b as typeof a; return termEq(a.s, y.s) && a.bs.length === y.bs.length && a.bs.every((f, i) => termEq(f, y.bs[i]!)); }
    }
}

/** `({cpu: N | mem: M})` of a `.budget.expected` file, or null for "evaluation failure". */
export function parseBudget(src: string): { cpu: number; mem: number } | null {
    const m = /cpu:\s*(\d+)\s*\|\s*mem:\s*(\d+)/.exec(src);
    return m ? { cpu: Number(m[1]), mem: Number(m[2]) } : null;
}

// ── flat encoding (tests: scripts the way they arrive on chain; the inverse of flat.ts) ──
class BitWriter {
    private bytes: number[] = []; private cur = 0; private n = 0;
    bit(b: number) { this.cur = (this.cur << 1) | (b & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
    bits(v: number, w: number) { for (let i = w - 1; i >= 0; i--) this.bit((v >> i) & 1); }
    natural(v: bigint) { do { const chunk = Number(v & 127n); v >>= 7n; this.bits(v > 0n ? chunk | 128 : chunk, 8); } while (v > 0n); }
    integer(v: bigint) { this.natural(v >= 0n ? v << 1n : ((-v - 1n) << 1n) | 1n); }
    filler() { while (this.n !== 7) this.bit(0); this.bit(1); }
    byteString(b: Uint8Array) {
        this.filler();
        for (let o = 0; o < b.length; o += 255) { const c = b.subarray(o, o + 255); this.bytes.push(c.length, ...c); }
        this.bytes.push(0);
    }
    out(): Uint8Array { return new Uint8Array(this.bytes); }
}
function typeTags(t: ConstType): number[] {
    switch (t.tag) {
        case 5: return [7, 5, ...typeTags(t.a!)];
        case 12: return [7, 12, ...typeTags(t.a!)];
        case 6: return [7, 7, 6, ...typeTags(t.a!), ...typeTags(t.b!)];
    }
    return [t.tag];
}
function encodeConst(w: BitWriter, t: ConstType, v: any): void {
    switch (t.tag) {
        case 0: return w.integer(v);
        case 1: return w.byteString(v);
        case 2: return w.byteString(new TextEncoder().encode(v));
        case 3: return;
        case 4: return w.bit(v ? 1 : 0);
        case 8: return w.byteString(encodeDataBytes(v));
        case 5: for (const x of listToArray(v)) { w.bit(1); encodeConst(w, t.a!, x); } return w.bit(0);
        case 12: for (const x of (v as VArray).arr) { w.bit(1); encodeConst(w, t.a!, x); } return w.bit(0);
        case 6: encodeConst(w, t.a!, v.fst); return encodeConst(w, t.b!, v.snd);
        case 13:
            for (const [c, ts] of (v as VValue).entries) {
                w.bit(1); w.byteString(c);
                for (const [k, q] of ts) { w.bit(1); w.byteString(k); w.integer(q); }
                w.bit(0);
            }
            return w.bit(0);
    }
    throw new Error(`constants of type ${t.key} have no flat encoding`);
}
function encodeTerm(w: BitWriter, t: Term): void {
    w.bits(t.k, 4);
    switch (t.k) {
        case TK.Var: return w.natural(BigInt(t.i));
        case TK.Lam: case TK.Delay: case TK.Force: return encodeTerm(w, t.b);
        case TK.Apply: encodeTerm(w, t.f); return encodeTerm(w, t.a);
        case TK.Error: return;
        case TK.Builtin: return w.bits(t.fn, 7);
        case TK.Const: { for (const x of typeTags(t.v.type)) { w.bit(1); w.bits(x, 4); } w.bit(0); return encodeConst(w, t.v.type, t.v.v); }
        case TK.Constr: w.natural(BigInt(t.tag)); for (const f of t.fields) { w.bit(1); encodeTerm(w, f); } return w.bit(0);
        case TK.Case: encodeTerm(w, t.s); for (const b of t.bs) { w.bit(1); encodeTerm(w, b); } return w.bit(0);
    }
}
/** A program as flat bytes (what a script's CBOR bytestring holds). */
export function encodeProgramFlat(p: { version: [number, number, number]; term: Term }): Uint8Array {
    const w = new BitWriter();
    for (const n of p.version) w.natural(BigInt(n));
    encodeTerm(w, p.term);
    w.filler();
    return w.out();
}
