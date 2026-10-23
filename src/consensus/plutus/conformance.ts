/**
 * One case of plutus' conformance suite (plutus-conformance/test-cases/uplc/evaluation) against
 * this evaluator: the program evaluated as Plutus V3 at protocol 11 (variant E, `case` on builtin
 * values available) with unlimited budget — the suite's `UplcEvaluatorWithCosting` — and the
 * result compared up to α-equivalence, the budget exactly. Used by scripts/plutus-conformance.ts
 * and conformance.test.ts.
 */
import { evaluate } from "./cek";
import { TK, builtinsAvailable, plc110Available, plc120Available, type Term } from "./flat";
import { BUILTIN_NAMES, costTable, type CostTable, type Lang } from "./costs";
import { FreeVariableError, UplcParseError, discharge, parseBudget, parseProgram, termEq, type ParseOptions } from "./uplcText";

/** What a conformance vector run ends in (the `.expected` files' vocabulary). */
export type VectorOutcome = "success" | "evaluation failure" | "out of budget" | "parse error";
export interface VectorRun { outcome: VectorOutcome; term?: Term; cpu: number; mem: number; detail?: string }

/**
 * What the ledger checks before evaluating a script of ledger language `lang` at protocol `pv`
 * (`mkTermToEvaluate` / the flat decoder of flat.ts): the Plutus Core version is one the language
 * may use, and every builtin is available. A text program bypasses the flat decoder, so a vector
 * that runs text under another language or protocol version checks it here. Null when allowed.
 * Both are decode errors in plutus-ledger-api — `PlutusCoreLanguageNotAvailableError` is a
 * `ScriptDecodeError` even though `mkTermToEvaluate` raises it, and the flat decoder's
 * `checkBuiltin` rejects a builtin outside the language's set — which is how flat.ts reports them
 * (`FlatError`) and what a conformance vector expects ("parse/decode error"; bug 553).
 */
export function programUnavailable(version: [number, number, number], term: Term, lang: Lang, pv: number): string | null {
    const v = version.join(".");
    if (v !== "1.0.0" && v !== "1.1.0" && !(v === "1.2.0" && plc120Available(lang, pv))) return `Plutus Core ${v} is not available in Plutus V${lang} at protocol ${pv}`;
    if (v === "1.1.0" && !plc110Available(lang, pv)) return `Plutus Core 1.1.0 is not available in Plutus V${lang} at protocol ${pv}`;
    const avail = builtinsAvailable(lang, pv);
    const stack: Term[] = [term];
    while (stack.length) {
        const t = stack.pop()!;
        switch (t.k) {
            case TK.Builtin: if (!avail.has(t.fn)) return `builtin ${BUILTIN_NAMES[t.fn]} is not available in Plutus V${lang} at protocol ${pv}`; break;
            case TK.Lam: case TK.Delay: case TK.Force: stack.push(t.b); break;
            case TK.Apply: stack.push(t.f, t.a); break;
            case TK.Constr: stack.push(...t.fields); break;
            case TK.Case: stack.push(t.s, ...t.bs); break;
        }
    }
    return null;
}

/**
 * Run one textual vector as Plutus V`lang` at protocol `pv` under `costs`, within `budget`
 * (default: unlimited, the suite's counting mode). Parse errors, free variables (an evaluation
 * failure upstream), unavailable versions / builtins (a decode error, see `programUnavailable`),
 * failures and budget exhaustion are told apart.
 */
export function runTextVector(program: string, costs: CostTable, opts: { lang: Lang; pv: number; budget?: { cpu: number; mem: number } }): VectorRun {
    let parsed;
    try { parsed = parseProgram(program); }
    catch (e) {
        if (e instanceof FreeVariableError) return { outcome: "evaluation failure", cpu: 0, mem: 0, detail: "free variable" };
        if (e instanceof UplcParseError) return { outcome: "parse error", cpu: 0, mem: 0, detail: e.message };
        throw e;
    }
    const why = programUnavailable(parsed.version, parsed.term, opts.lang, opts.pv);
    if (why) return { outcome: "parse error", cpu: 0, mem: 0, detail: why };
    const budget = opts.budget ?? { cpu: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER };
    const r = evaluate(parsed.term, costs, budget, { pv: opts.pv });
    if (r.ok) return { outcome: "success", term: discharge(r.result!, r.code!), cpu: r.cpu, mem: r.mem };
    return { outcome: r.budgetExceeded ? "out of budget" : "evaluation failure", cpu: r.cpu, mem: r.mem, detail: r.error };
}

export interface ConformanceResult { resultOk: boolean; budgetOk: boolean; detail?: string; got?: { cpu: number; mem: number }; skipped?: string }

/**
 * `lang` / `pv` select the ledger language and protocol version (default Plutus V3 at protocol 11,
 * variant E). Plutus V4 at protocol 12 is variant G, the `def` (maxBound) variant the suite at
 * plutus master evaluates with (bug 434). `valueLiterals: "normalise"` reads value literals as
 * plutus 1.63's parser did (uplcText.ts `ParseOptions`; the 1.63 suite expects it).
 */
export function runConformanceCase(program: string, expected: string, budget: string, v3Costs: ReadonlyArray<number>, opts: { lang?: 3 | 4; pv?: number; valueLiterals?: ParseOptions["valueLiterals"] } = {}): ConformanceResult {
    const lang = opts.lang ?? 3, pv = opts.pv ?? 11;
    // plutus master writes "parse/decode error" where 1.63 wrote "parse error"
    const exp0 = expected.trim(), exp = exp0 === "parse/decode error" ? "parse error" : exp0, wantBudget = parseBudget(budget);
    let parsed;
    try { parsed = parseProgram(program, { valueLiterals: opts.valueLiterals }); }
    catch (e) {
        if (e instanceof FreeVariableError) return { resultOk: exp === "evaluation failure", budgetOk: wantBudget === null, detail: "free variable" };
        if (e instanceof UplcParseError) return { resultOk: exp === "parse error", budgetOk: true, detail: `parse error: ${e.message}` };
        throw e;
    }
    // an unavailable Plutus Core version or builtin is a decode error (bug 553), the suite's "parse/decode error"
    const unavailable = programUnavailable(parsed.version, parsed.term, lang, pv);
    if (unavailable) return { resultOk: exp === "parse error", budgetOk: wantBudget === null, detail: unavailable };
    if (exp === "parse error") return { resultOk: false, budgetOk: true, detail: "parsed, expected a parse error" };
    let want: Term | null = null;
    if (exp !== "evaluation failure") {
        try { want = parseProgram(exp).term; }
        catch (e) { return { resultOk: false, budgetOk: false, skipped: `expected output not parseable: ${(e as Error).message}` }; }
    }
    const r = evaluate(parsed.term, costTable(lang, v3Costs, pv), { cpu: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER }, { pv });
    const got = { cpu: r.cpu, mem: r.mem };
    if (!r.ok) {
        if (r.error?.startsWith("evaluator limit")) return { resultOk: false, budgetOk: false, detail: r.error, got };
        // the suite counts with saturating Int64 arithmetic and no limit; costs beyond 2^53 exceed every real budget here
        if (r.budgetExceeded && (r.cpu >= Number.MAX_SAFE_INTEGER || r.mem >= Number.MAX_SAFE_INTEGER) && wantBudget && (wantBudget.cpu >= Number.MAX_SAFE_INTEGER || wantBudget.mem >= Number.MAX_SAFE_INTEGER)) {
            return { resultOk: false, budgetOk: false, skipped: "cost saturates Int64 (beyond any real budget; both machines fail with a real one)", got };
        }
        return { resultOk: want === null, budgetOk: wantBudget === null, detail: `failed: ${r.error}`, got };
    }
    const resultOk = want !== null && termEq(discharge(r.result!, r.code!), want);
    const budgetOk = wantBudget !== null && wantBudget.cpu === r.cpu && wantBudget.mem === r.mem;
    return { resultOk, budgetOk, detail: resultOk ? undefined : want === null ? "succeeded, expected a failure" : "different result", got };
}
