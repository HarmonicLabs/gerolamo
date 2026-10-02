import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runConformanceCase } from "./conformance";
import { decodeProgram } from "./flat";
import { encodeProgramFlat, parseProgram, termEq } from "./uplcText";

/**
 * plutus' official conformance suite at tag 1.63.0.0 (the plutus inside cardano-node 11.0.1):
 * all 999 UPLC evaluation cases (plutus-conformance/test-cases/uplc/evaluation), results and
 * budgets, with preview's protocol-11 cost models. Regenerate the fixture with
 * `bun scripts/plutus-conformance.ts <plutus>/plutus-conformance/test-cases/uplc/evaluation <pp.json> --json …`.
 */
const fx = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(new URL("../__fixtures__/plutus-conformance-1.63.json.gz", import.meta.url))))) as {
    costModels: { PlutusV1: number[]; PlutusV2: number[]; PlutusV3: number[] };
    cases: Array<{ name: string; program: string; expected: string; budget: string }>;
};
/** Costs that saturate the suite's Int64 counter (dropList by 10^19 …): beyond any real budget, both machines fail. */
const SATURATING = ["dropList-09", "dropList-10", "dropList-14", "dropList-15", "dropList-16"];

describe("plutus-conformance 1.63.0.0 (UPLC evaluation: results and budgets)", () => {
    test("the fixture holds the whole suite", () => {
        expect(fx.cases.length).toBe(999);
        expect(fx.costModels.PlutusV3.length).toBe(350);
    });
    const groups = new Map<string, typeof fx.cases>();
    for (const c of fx.cases) {
        const parts = c.name.split("/");
        const g = parts[0] === "builtin" && parts[1] === "semantics" ? `builtin ${parts[2]}` : parts.slice(0, 2).join(" ");
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(c);
    }
    for (const [g, cs] of groups) {
        test(`${g} (${cs.length})`, () => {
            const bad: string[] = [];
            for (const c of cs) {
                const r = runConformanceCase(c.program, c.expected, c.budget, fx.costModels.PlutusV3);
                if (r.skipped) { if (!SATURATING.some((s) => c.name.endsWith(s))) bad.push(`${c.name}: skipped (${r.skipped})`); continue; }
                if (!r.resultOk || !r.budgetOk) bad.push(`${c.name}: ${r.resultOk ? "" : `result ${r.detail} `}${r.budgetOk ? "" : `budget ${r.got?.cpu}/${r.got?.mem} vs ${c.budget.replace(/\s+/g, " ")}`}`);
            }
            expect(bad).toEqual([]);
        });
    }

    test("flat round trip: every parseable program without BLS12-381 constants decodes back to itself (V3, protocol 11)", () => {
        let n = 0;
        for (const c of fx.cases) {
            let p;
            try { p = parseProgram(c.program); } catch { continue; }
            let bytes: Uint8Array;
            try { bytes = encodeProgramFlat(p); } catch { continue; } // BLS12-381 points have no flat encoding

            expect(termEq(decodeProgram(bytes, 3, 11).term, p.term)).toBe(true);
            n++;
        }
        expect(n).toBeGreaterThan(700);
    });
});
