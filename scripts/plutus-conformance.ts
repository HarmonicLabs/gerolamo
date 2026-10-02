#!/usr/bin/env bun
/**
 * Run plutus' official conformance suite (plutus-conformance/test-cases/uplc/evaluation in the
 * IntersectMBO/plutus repository, tag 1.63.0.0 = cardano-node 11.0.1) against Gerolamo's
 * evaluator (src/consensus/plutus/cek.ts): every `<name>.uplc` program is parsed, evaluated as
 * Plutus V3 at protocol 11 (semantics variant E, `case` on builtins available) with unlimited
 * budget, and its result and budget compared with `<name>.uplc.expected` /
 * `<name>.uplc.budget.expected`.
 *
 *   bun scripts/plutus-conformance.ts <test-cases dir> <costs.json> [--filter <substr>] [--json <out>] [-v]
 *
 * costs.json: `cardano-cli conway query protocol-parameters` output (costModels.PlutusV3) or
 * `{"PlutusV3": […]}`; the suite's budgets are plutus' default cost model, which is what preview
 * carries on chain at protocol 11. `--json` writes the selected cases as a fixture
 * ({name, program, expected, budget}[]) for src/consensus/plutus/conformance.test.ts.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runConformanceCase } from "../src/consensus/plutus/conformance";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const filter = flag("--filter"), jsonOut = flag("--json");
const verbose = args.includes("-v");
const [root, costsPath] = args.filter((a) => a !== "-v");
if (!root || !costsPath) { console.error("usage: plutus-conformance.ts <test-cases dir> <costs.json> [--filter s] [--json out] [-v]"); process.exit(2); }
const cj = JSON.parse(readFileSync(costsPath, "utf8"));
const v3: number[] = cj.costModels?.PlutusV3 ?? cj.PlutusV3;

const cases: Array<{ name: string; program: string; expected: string; budget: string }> = [];
(function walk(dir: string) {
    const ents = readdirSync(dir);
    const subdirs = ents.filter((e) => statSync(join(dir, e)).isDirectory());
    if (subdirs.length) { for (const d of subdirs.sort()) walk(join(dir, d)); return; }
    const base = dir.split("/").pop()!;
    const f = join(dir, `${base}.uplc`);
    try { statSync(f); } catch { return; }
    const name = relative(root, dir);
    if (filter && !name.includes(filter)) return;
    cases.push({ name, program: readFileSync(f, "utf8"), expected: readFileSync(`${f}.expected`, "utf8"), budget: readFileSync(`${f}.budget.expected`, "utf8") });
})(root);

let pass = 0, resFail = 0, budFail = 0, skipped = 0;
for (const c of cases) {
    const r = runConformanceCase(c.program, c.expected, c.budget, v3);
    if (r.skipped) { skipped++; if (verbose) console.log(`SKIP ${c.name}: ${r.skipped}`); continue; }
    if (r.resultOk && r.budgetOk) { pass++; continue; }
    if (!r.resultOk) resFail++;
    if (!r.budgetOk) budFail++;
    console.log(`FAIL ${c.name}: ${r.resultOk ? "" : `result (${r.detail}) `}${r.budgetOk ? "" : `budget got ${r.got?.cpu}/${r.got?.mem} want ${c.budget.replace(/\s+/g, " ").trim()}`}`);
}
console.log(`${cases.length} cases: ${pass} pass, ${resFail} result mismatches, ${budFail} budget mismatches, ${skipped} skipped`);
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify({ source: "IntersectMBO/plutus 1.63.0.0 plutus-conformance/test-cases", cases }, null, 0)); console.log(`wrote ${cases.length} cases to ${jsonOut}`); }
process.exit(resFail || budFail ? 1 : 0);
