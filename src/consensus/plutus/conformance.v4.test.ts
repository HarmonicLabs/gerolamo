import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runConformanceCase } from "./conformance";
import { costTable, semanticsVariant, shapeVariant, variantBoundsBytes, variantBoundsIntegers } from "./costs";
import { builtinsAvailable, decodeProgram } from "./flat";
import { encodeProgramFlat, parseProgram } from "./uplcText";
import { plutusV4CostModelArray, PARAM_NAMES_V4 } from "./v4";
import { PARAM_NAMES_V3 } from "./paramNames";

/**
 * Plutus V4 (bug 433) and semantics variants F/G (bug 434). The conformance suite at plutus
 * master evaluates with the `def` = maxBound variant, G: Plutus V4 at protocol 12 (and V3 from
 * Dijkstra). Its budgets use plutus master's default cost model E (G shares E's costs).
 */
const fx = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(new URL("../__fixtures__/plutus-conformance-master-v4.json.gz", import.meta.url))))) as {
    costModels: { PlutusV4: number[] };
    cases: Array<{ name: string; program: string; expected: string; budget: string }>;
};
/** Int64-saturating costs (as in the 1.63 suite). */
const SATURATING = ["dropList-09", "dropList-10", "dropList-14", "dropList-15", "dropList-16"];
/**
 * Cases about the UPLC *text* parser (test tooling, not the on-chain flat decoder): free variables
 * are a parse-time error upstream, an evaluation failure here. (The builtin/parser/value cases —
 * literals must be canonical — pass since bug 552.)
 */
const TEXT_PARSER_GAPS = ["term/free-vars/constr-free-var", "term/free-vars/unused-free-var", "term/free-vars/var"];

describe("plutus-conformance at plutus master as Plutus V4, protocol 12 (variant G)", () => {
    test("fixture: the whole suite and a 361-entry V4 cost model", () => {
        expect(fx.cases.length).toBe(1011);
        expect(fx.costModels.PlutusV4.length).toBe(361);
    });
    test("every case passes except the known text-parser gaps (results and budgets)", () => {
        const bad: string[] = [];
        let pass = 0;
        for (const c of fx.cases) {
            const r = runConformanceCase(c.program, c.expected, c.budget, fx.costModels.PlutusV4, { lang: 4, pv: 12 });
            if (c.budget === "") r.budgetOk = true;
            if (r.skipped) { if (!SATURATING.some((s) => c.name.endsWith(s))) bad.push(`${c.name}: skipped (${r.skipped})`); continue; }
            if (r.resultOk && r.budgetOk) { pass++; continue; }
            if (!TEXT_PARSER_GAPS.includes(c.name)) bad.push(`${c.name}: ${r.detail ?? ""} ${r.budgetOk ? "" : "budget"}`);
        }
        expect(bad).toEqual([]);
        expect(pass).toBe(1003);
    }, 120_000); // 1011 cases: ~9 s on an idle machine, more under load (the 5 s default timed out on 2026-10-10)
    test("case on Data needs protocol 12: the same programs fail as V3 at protocol 11", () => {
        const data = fx.cases.filter((c) => c.name.startsWith("term/constant-case/data/") && c.expected.trim() !== "evaluation failure");
        expect(data.length).toBeGreaterThan(0);
        for (const c of data) {
            expect(runConformanceCase(c.program, c.expected, c.budget, fx.costModels.PlutusV4, { lang: 4, pv: 12 }).resultOk).toBe(true);
            expect(runConformanceCase(c.program.replace("1.2.0", "1.1.0"), c.expected.replace("1.2.0", "1.1.0"), c.budget, fx.costModels.PlutusV4, { lang: 3, pv: 11 }).resultOk).toBe(false);
        }
    });
});

describe("semantics variants and Plutus V4 parameters", () => {
    test("variant per language and protocol version (ProtocolVersions.hs note)", () => {
        expect([semanticsVariant(1, 8), semanticsVariant(1, 10), semanticsVariant(1, 11), semanticsVariant(1, 12)]).toEqual(["A", "B", "D", "F"]);
        expect([semanticsVariant(2, 12), semanticsVariant(3, 10), semanticsVariant(3, 11), semanticsVariant(3, 12), semanticsVariant(4, 12)]).toEqual(["F", "C", "E", "G", "G"]);
        expect([shapeVariant("F"), shapeVariant("G"), shapeVariant("E")]).toEqual(["D", "E", "E"]);
        // ensurableInteger: D, E only; ensurableByteString: D..G
        expect(["D", "E", "F", "G"].map(variantBoundsIntegers)).toEqual([true, true, false, false]);
        expect(["C", "D", "E", "F", "G"].map(variantBoundsBytes)).toEqual([false, true, true, true, true]);
    });
    test("integers beyond 2^262143 fail in variant E (V3, protocol 11) but not in G (V4, protocol 12)", () => {
        const big = "(program 1.1.0 [ [ (builtin addInteger) (con integer " + (1n << 262143n).toString() + ") ] (con integer 1) ])";
        const ok = (lang: 3 | 4, pv: number) => runConformanceCase(big, "(program 1.1.0 (con integer " + ((1n << 262143n) + 1n).toString() + "))", "", fx.costModels.PlutusV4, { lang, pv }).resultOk;
        expect(ok(3, 11)).toBe(false);
        expect(ok(4, 12)).toBe(true);
        expect(ok(3, 12)).toBe(true); // V3 moves to G at protocol 12 too
    });
    test("V4 cost model names are V3's; object form maps in parameter order", () => {
        expect(PARAM_NAMES_V4).toEqual(PARAM_NAMES_V3);
        const obj: Record<string, number> = {};
        PARAM_NAMES_V4.slice(0, 251).forEach((n, i) => { obj[n] = i; });
        expect(plutusV4CostModelArray(obj)).toEqual([...Array(251).keys()]);
        expect(plutusV4CostModelArray([1, 2, 3])).toEqual([1, 2, 3]);
        expect(costTable(4, fx.costModels.PlutusV4, 12).variant).toBe("G");
    });
    test("flat: V4 has batches 1..6 from protocol 12, Plutus Core 1.2.0 decodes from protocol 12 only", () => {
        expect(builtinsAvailable(4, 11).size).toBe(0);
        expect(builtinsAvailable(4, 12)).toEqual(builtinsAvailable(3, 11));
        const p = parseProgram("(program 1.2.0 (con integer 7))");
        const bytes = encodeProgramFlat(p);
        expect(decodeProgram(bytes, 4, 12).version).toEqual([1, 2, 0]);
        expect(decodeProgram(bytes, 3, 12).version).toEqual([1, 2, 0]);
        expect(() => decodeProgram(bytes, 3, 11)).toThrow();
    });
});
