#!/usr/bin/env bun
/**
 * node-diversity-conformance `uplc-conformance` report for Gerolamo's UPLC machine.
 *
 *   bun scripts/ndc/uplc-conformance.ts --corpus <unpacked uplc-conformance.tar.zst> --out <report.json>
 *       [--digest <sha256 of the archive>] [--expectations <ndc>/scenarios/uplc-conformance/expectations.json] [--summary <file.json>]
 *
 * The corpus is pragma's archive unpacked (`protocol-version-<pv>/v<lang>/…` vectors and `cost-models/`); each vector
 * runs as its folder's language at its folder's protocol version under the corpus's cost model for that pair. The
 * report carries observations only (schema 8974561); our own verdicts against the corpus's `.uplc.expected` /
 * `.budget` files are printed, and with `--expectations` so is the score the site will compute from the report
 * (ndcScore.ts), with every disagreement. `--summary` writes what the schema no longer lets the report carry
 * (totals, cost models, digest, commit).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildUplcConformanceReport, loadUplcCorpus } from "../../src/conformance/ndc/uplcConformance";
import { scoreUplcConformance } from "../../src/conformance/ndc/ndcScore";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const corpusDir = flag("--corpus"), out = flag("--out");
if (!corpusDir || !out) { console.error("usage: uplc-conformance.ts --corpus <dir> --out <file> [--digest <sha256>] [--expectations <file>] [--summary <file>]"); process.exit(2); }
const corpus = loadUplcCorpus(corpusDir);
const t0 = performance.now();
const run = buildUplcConformanceReport(corpus, { corpusDigest: flag("--digest") });
writeFileSync(out, JSON.stringify(run.report, null, 2) + "\n");
const { totals } = run;
console.log(`${corpus.vectors.length} vectors (${corpus.costModels.size} cost models) in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${out}`);
console.log(`ours: passed ${totals.passed}/${totals.total}; evaluation ${totals.evaluation.passed}/${totals.evaluation.total}; budget ${totals.budget.passed}/${totals.budget.total}`);
for (const v of run.verdicts) if (!v.passed) console.log(`FAIL ${v.id} (${v.plutus_version} @ ${v.protocol_version}, ${v.cost_model_id}): expected ${v.expected.evaluation}${v.expected.budget ? ` ${JSON.stringify(v.expected.budget)}` : ""}${v.detail ? ` — ${v.detail}` : ""}`);
for (const c of run.cost_models) console.log(`cost model ${c.id}: ${c.parameters} parameters, ${c.source}${c.default_variant ? ` = plutus default variant ${c.default_variant}` : " (not a plutus default of the fixture)"}`);

let site: ReturnType<typeof scoreUplcConformance> | undefined;
const expectationsPath = flag("--expectations");
if (expectationsPath) {
    const expectations = JSON.parse(readFileSync(expectationsPath, "utf8")).scenarios;
    site = scoreUplcConformance(run.report, expectations);
    console.log(`site rule (${expectationsPath.split("/").slice(-3).join("/")}): ${site.passed}/${site.total}`);
    for (const f of site.failures) console.log(`  site: ${f}`);
    const known = new Set(expectations.map((e: any) => `${e.id}|${e.plutus_version}|${e.protocol_version}`));
    const orphans = run.report.scenarios.filter((r) => !known.has(`${r.id}|${r.plutus_version}|${r.protocol_version}`));
    if (orphans.length) console.log(`  ${orphans.length} row(s) of ours have no expectation on the site: ${orphans.map((r) => r.id).join(", ")}`);
}
const summaryPath = flag("--summary");
if (summaryPath) {
    writeFileSync(summaryPath, JSON.stringify({
        implementation: run.implementation, corpus: run.corpus, corpus_digest: run.corpus_digest, budget_limit: run.budget_limit, totals: run.totals, cost_models: run.cost_models,
        site: site ? { passed: site.passed, total: site.total, failures: site.failures } : undefined,
        failing: run.verdicts.filter((v) => !v.passed),
    }, null, 2) + "\n");
}
