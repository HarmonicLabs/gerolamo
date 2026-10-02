/**
 * One case of plutus' conformance suite (plutus-conformance/test-cases/uplc/evaluation) against
 * this evaluator: the program evaluated as Plutus V3 at protocol 11 (variant E, `case` on builtin
 * values available) with unlimited budget — the suite's `UplcEvaluatorWithCosting` — and the
 * result compared up to α-equivalence, the budget exactly. Used by scripts/plutus-conformance.ts
 * and conformance.test.ts.
 */
import { evaluate } from "./cek";
import type { Term } from "./flat";
import { costTable } from "./costs";
import { FreeVariableError, UplcParseError, discharge, parseBudget, parseProgram, termEq } from "./uplcText";

export interface ConformanceResult { resultOk: boolean; budgetOk: boolean; detail?: string; got?: { cpu: number; mem: number }; skipped?: string }

export function runConformanceCase(program: string, expected: string, budget: string, v3Costs: ReadonlyArray<number>): ConformanceResult {
    const exp = expected.trim(), wantBudget = parseBudget(budget);
    let parsed;
    try { parsed = parseProgram(program); }
    catch (e) {
        if (e instanceof FreeVariableError) return { resultOk: exp === "evaluation failure", budgetOk: wantBudget === null, detail: "free variable" };
        if (e instanceof UplcParseError) return { resultOk: exp === "parse error", budgetOk: true, detail: `parse error: ${e.message}` };
        throw e;
    }
    if (exp === "parse error") return { resultOk: false, budgetOk: true, detail: "parsed, expected a parse error" };
    let want: Term | null = null;
    if (exp !== "evaluation failure") {
        try { want = parseProgram(exp).term; }
        catch (e) { return { resultOk: false, budgetOk: false, skipped: `expected output not parseable: ${(e as Error).message}` }; }
    }
    const r = evaluate(parsed.term, costTable(3, v3Costs, 11), { cpu: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER }, { pv: 11 });
    const got = { cpu: r.cpu, mem: r.mem };
    if (!r.ok) {
        if (r.error?.startsWith("evaluator limit")) return { resultOk: false, budgetOk: false, detail: r.error, got };
        // the suite counts with saturating Int64 arithmetic and no limit; costs beyond 2^53 exceed every real budget here
        if (r.budgetExceeded && (r.cpu >= Number.MAX_SAFE_INTEGER || r.mem >= Number.MAX_SAFE_INTEGER) && wantBudget && (wantBudget.cpu >= Number.MAX_SAFE_INTEGER || wantBudget.mem >= Number.MAX_SAFE_INTEGER)) {
            return { resultOk: false, budgetOk: false, skipped: "cost saturates Int64 (beyond any real budget; both machines fail with a real one)", got };
        }
        return { resultOk: want === null, budgetOk: wantBudget === null, detail: `failed: ${r.error}`, got };
    }
    const resultOk = want !== null && termEq(discharge(r.result!), want);
    const budgetOk = wantBudget !== null && wantBudget.cpu === r.cpu && wantBudget.mem === r.mem;
    return { resultOk, budgetOk, detail: resultOk ? undefined : want === null ? "succeeded, expected a failure" : "different result", got };
}
