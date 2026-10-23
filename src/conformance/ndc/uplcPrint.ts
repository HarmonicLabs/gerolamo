/**
 * A result term as textual UPLC (plutus-core's concrete syntax), the form the node-diversity-
 * conformance `uplc-conformance` report carries in `evaluation`: the site compares it with the
 * expected text after collapsing whitespace (scripts/build.py `normalize_evaluation`, ported
 * below as `normalizeEvaluation`). The inverse of uplcText.ts `parseProgram`, printing the way
 * the Haskell evaluator (and so the site's expectations) does:
 *
 *   - binders are named by depth, `i-0` outermost, so a de Bruijn term prints deterministically;
 *   - applications are binary, `[f a]`; `(con <type> <value>)`; data in parentheses at the top
 *     of a constant and bare inside lists and pairs; BLS12-381 points as `0x` + compressed hex;
 *   - strings as Haskell literals, except that characters beyond DEL stay as they are
 *     (plutus prints `λ`, `€`, `¬` raw and `\DEL`, `\n`, `\"`, `\\` escaped).
 *
 * Layout (line breaks, indentation) is not reproduced: the comparison ignores it.
 */
import { bls12_381_G1_compress, bls12_381_G2_compress } from "@harmoniclabs/crypto";
import { BUILTIN_NAMES } from "../../consensus/plutus/costs";
import { DConstr, DInt, DList, DMap, type Data } from "../../consensus/plutus/data";
import { TK, type Term } from "../../consensus/plutus/flat";
import type { VValue } from "../../consensus/plutus/multiasset";
import { listToArray, type ConstType, type VArray } from "../../consensus/plutus/values";

const hex = (b: Uint8Array): string => `#${Buffer.from(b).toString("hex")}`;

export function printProgram(version: readonly [number, number, number], term: Term): string {
    return `(program ${version.join(".")} ${printTerm(term, 0)})`;
}

/** `depth`: the number of enclosing lambdas (their names are `i-0` … `i-(depth-1)`). */
export function printTerm(t: Term, depth = 0): string {
    switch (t.k) {
        case TK.Var: return depth - t.i >= 0 ? `i-${depth - t.i}` : `free-${t.i}`;
        case TK.Lam: return `(lam i-${depth} ${printTerm(t.b, depth + 1)})`;
        case TK.Delay: return `(delay ${printTerm(t.b, depth)})`;
        case TK.Force: return `(force ${printTerm(t.b, depth)})`;
        case TK.Apply: return `[${printTerm(t.f, depth)} ${printTerm(t.a, depth)}]`;
        case TK.Error: return "(error)";
        case TK.Builtin: return `(builtin ${BUILTIN_NAMES[t.fn] ?? `builtin#${t.fn}`})`;
        case TK.Const: return `(con ${printType(t.v.type)} ${printConst(t.v.type, t.v.v, true)})`;
        case TK.Constr: return `(constr ${String(t.tag)}${t.fields.map((f) => ` ${printTerm(f, depth)}`).join("")})`;
        case TK.Case: return `(case ${printTerm(t.s, depth)}${t.bs.map((b) => ` ${printTerm(b, depth)}`).join("")})`;
    }
}

export function printType(t: ConstType): string {
    switch (t.tag) {
        case 0: return "integer";
        case 1: return "bytestring";
        case 2: return "string";
        case 3: return "unit";
        case 4: return "bool";
        case 5: return `(list ${printType(t.a!)})`;
        case 6: return `(pair ${printType(t.a!)} ${printType(t.b!)})`;
        case 8: return "data";
        case 9: return "bls12_381_G1_element";
        case 10: return "bls12_381_G2_element";
        case 11: return "bls12_381_mlresult";
        case 12: return `(array ${printType(t.a!)})`;
        case 13: return "value";
    }
    throw new Error(`unknown constant type tag ${t.tag}`);
}

/** `parens`: a data constant at the top of a `con` is parenthesised, inside a list or pair it is bare. */
export function printConst(t: ConstType, v: any, parens: boolean): string {
    switch (t.tag) {
        case 0: return String(v);
        case 1: return hex(v);
        case 2: return quoteString(v);
        case 3: return "()";
        case 4: return v ? "True" : "False";
        case 5: return `[${listToArray(v).map((x) => printConst(t.a!, x, false)).join(", ")}]`;
        case 12: return `[${(v as VArray).arr.map((x) => printConst(t.a!, x, false)).join(", ")}]`;
        case 6: return `(${printConst(t.a!, v.fst, false)}, ${printConst(t.b!, v.snd, false)})`;
        case 8: return parens ? `(${printData(v)})` : printData(v);
        case 9: return `0x${Buffer.from(bls12_381_G1_compress(v)).toString("hex")}`;
        case 10: return `0x${Buffer.from(bls12_381_G2_compress(v)).toString("hex")}`;
        case 11: return "<bls12_381_mlresult>";
        case 13: return `[${(v as VValue).entries.map(([c, ts]) => `(${hex(c)}, [${ts.map(([k, q]) => `(${hex(k)}, ${q})`).join(", ")}])`).join(", ")}]`;
    }
    throw new Error(`unknown constant type tag ${t.tag}`);
}

/** `PlutusCore.Data`'s Show-like form: `Constr 1 [I 1]`, `Map [(k, v)]`, `List [...]`, `I n`, `B #hex`. */
export function printData(d: Data): string {
    if (d instanceof DConstr) return `Constr ${d.tag} [${d.fields.map(printData).join(", ")}]`;
    if (d instanceof DMap) return `Map [${d.entries.map((p) => `(${printData(p.fst)}, ${printData(p.snd)})`).join(", ")}]`;
    if (d instanceof DList) return `List [${d.items.map(printData).join(", ")}]`;
    if (d instanceof DInt) return `I ${d.v}`;
    return `B ${hex(d.v)}`;
}

const ASCII_TAB = ["NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "HT", "LF", "VT", "FF", "CR", "SO", "SI", "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US"];
const SIMPLE: Record<number, string> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r" };

/** A Haskell string literal (`showLitString`) whose characters beyond DEL are left unescaped. */
export function quoteString(s: string): string {
    let out = "\"";
    const cps = [...s];
    for (let i = 0; i < cps.length; i++) {
        const c = cps[i]!, n = c.codePointAt(0)!;
        if (c === "\"") out += "\\\"";
        else if (c === "\\") out += "\\\\";
        else if (n === 0x7f) out += "\\DEL";
        else if (n >= 0x20) out += c;
        else if (n in SIMPLE) out += `\\${SIMPLE[n]}`;
        else out += `\\${ASCII_TAB[n]}${n === 14 && cps[i + 1] === "H" ? "\\&" : ""}`; // `\SO` before an H needs the empty escape
    }
    return `${out}"`;
}

/**
 * scripts/build.py `normalize_evaluation`: tokens (quoted strings whole, brackets, runs of
 * anything else) joined by one space, no space inside brackets or around commas.
 */
export function normalizeEvaluation(s: string): string {
    const tokens = s.match(/"(?:\\.|[^"\\])*"|[()[\],{}]|[^\s()[\],{}]+/gs) ?? [];
    return tokens.join(" ").replace(/([[({])\s+/g, "$1").replace(/\s+([)\]}])/g, "$1").replace(/\s*,\s*/g, ",").trim();
}
