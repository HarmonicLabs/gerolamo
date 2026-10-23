#!/usr/bin/env bun
/**
 * node-diversity-conformance `uplc-turbo` report for Gerolamo's UPLC machine.
 *
 *   taskset -c <two idle cores> bun scripts/ndc/uplc-turbo.ts --corpus <unpacked turbo.tar.zst> --out <report.json>
 *       [--runs 50] [--best 30] [--warmup-scope set|corpus] [--warmup-passes 3] [--warmup-ms 3000] [--warmup-runs 1] [--stride K] [--limit N] [--digest <sha256 of the archive>]
 *       [--schema <ndc>/scenarios/uplc-turbo/schema.json] [--reference <another node's uplc-turbo report.json>] [--summary <file.json>]
 *
 * The corpus is pragma's archive unpacked: `<dir>/<epoch>/<…>-v<lang>.flat`; every script runs as its language at
 * its epoch's protocol version under the default cost model (src/conformance/ndc/uplcTurbo.ts). Without selection
 * flags every script runs (the only way to a complete report); `--stride` / `--limit` pick a subset for a quick look.
 * With `--schema` the report keeps only the scripts the scenario enumerates (its `bench` list is the corpus the site
 * scores against); the others are printed and go to the `--summary` file, which also carries the setup, the
 * per-group summary, the worst CPU deviations and the budget agreement with `--reference`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { scoreUplcTurbo, turboCorpusBenchIds } from "../../src/conformance/ndc/ndcScore";
import { buildUplcTurboReport, listTurboFiles, median, percentile, selectTurboFiles, type TurboReference } from "../../src/conformance/ndc/uplcTurbo";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const num = (k: string) => { const v = flag(k); return v === undefined ? undefined : Number(v); };
const corpus = flag("--corpus"), out = flag("--out");
if (!corpus || !out) { console.error("usage: uplc-turbo.ts --corpus <dir> --out <file> [--runs 50] [--best 30] [--warmup-scope set|corpus] [--warmup-passes 3] [--warmup-ms 3000] [--warmup-runs 1] [--stride K] [--limit N] [--digest d] [--schema s] [--reference r] [--summary f]"); process.exit(2); }
const warmupScope = flag("--warmup-scope");
if (warmupScope !== undefined && warmupScope !== "set" && warmupScope !== "corpus") { console.error("--warmup-scope must be set or corpus"); process.exit(2); }
const sel = { stride: num("--stride"), limit: num("--limit") };
const all = listTurboFiles(corpus);
const files = selectTurboFiles(all, sel);
const parts = [sel.stride !== undefined && `every ${sel.stride}th`, sel.limit !== undefined && `the first ${sel.limit}`].filter(Boolean);
const selection = parts.length ? `${files.length} of ${all.length} scripts: ${parts.join(", ")} (epoch, then name order)` : undefined;
const schemaPath = flag("--schema");
const corpusIds = schemaPath ? turboCorpusBenchIds(JSON.parse(readFileSync(schemaPath, "utf8"))) : undefined;
let reference: TurboReference | undefined;
if (flag("--reference")) {
    const r = JSON.parse(readFileSync(flag("--reference")!, "utf8"));
    // the site's node id is the file name (`cardano-node.json`); the report inside calls itself "Plutus"
    reference = { name: flag("--reference")!.split("/").pop()!.replace(/\.json$/, ""), benchmarks: r.benchmarks ?? [] };
}
const t0 = performance.now();
const run = buildUplcTurboReport(files, {
    runs: num("--runs"), best: num("--best"), warmupScope: warmupScope as "set" | "corpus" | undefined, warmupPasses: num("--warmup-passes"), warmupMs: num("--warmup-ms"), warmupRuns: num("--warmup-runs"), corpusDigest: flag("--digest"), selection,
    corpusBenchIds: corpusIds ? new Set(corpusIds) : undefined, reference,
    onProgress: (d, n) => { if (d % 100 === 0 || d === n) process.stderr.write(`\r${d}/${n} scripts, ${((performance.now() - t0) / 1000).toFixed(0)} s`); },
});
process.stderr.write("\n");
writeFileSync(out, JSON.stringify(run.report, null, 2) + "\n");
console.log(`${files.length} scripts × ${run.setup.runs} runs (best ${run.setup.best}; warm-up ${run.setup.warmup_passes} passes over ${run.setup.warmup_scripts} scripts, ${run.setup.warmup_runs} run(s) per script) in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${out} (${run.report.benchmarks.length} in the report)`);
for (const s of run.summary) console.log(`${s.group} (variant ${s.cost_model_variant}): ${s.scripts} scripts, site rule passed ${s.site_passed}, cpu_us mean ${s.cpu_us_mean} median ${s.cpu_us_median} p90 ${s.cpu_us_p90} max ${s.cpu_us_max}, cpu_delta median ${s.cpu_delta_median ?? "n/a"}${s.failed_to_evaluate ? `, ${s.failed_to_evaluate} failed to evaluate` : ""}`);
const us = run.benchmarks.map((b) => b.cpu_us);
console.log(`all: cpu_us median ${median(us).toFixed(1)}, p90 ${percentile(us, 0.9).toFixed(1)}, mean ${(us.reduce((a, b) => a + b, 0) / us.length).toFixed(1)}; decode median ${median(run.benchmarks.map((b) => b.decode_us)).toFixed(1)} µs`);
const bad = run.benchmarks.filter((b) => !b.ok);
if (bad.length) console.log(`${bad.length} script(s) failed to evaluate: ${bad.slice(0, 5).map((b) => `${b.bench}: ${b.error}`).join("; ")}`);
if (run.budget_agreement) {
    const a = run.budget_agreement;
    console.log(`budgets agree with ${a.reference} on ${a.agree}/${a.total} script(s)`);
    for (const m of a.mismatches.slice(0, 20)) console.log(`  ${m.bench} (${m.plutus_version} @ ${m.protocol_version}): ours ${m.ours.join("/")}, ${a.reference} ${m.theirs.join("/")}`);
}
// the site's rule over every measured script, in the report or not; then the corpus view the site will show
const own = scoreUplcTurbo({ benchmarks: [...run.report.benchmarks, ...run.excluded] });
console.log(`site rule on the ${own.total} measured script(s): ${own.passed} pass (${run.report.benchmarks.length} in the report)${corpusIds ? `; against the scenario's ${corpusIds.length}-script corpus: ${scoreUplcTurbo(run.report, corpusIds).passed}/${corpusIds.length}` : ""}`);
for (const f of own.failures.slice(0, 50)) console.log(`  site: ${f}`);
if (own.failures.length > 50) console.log(`  … ${own.failures.length - 50} more`);
if (run.excluded.length) {
    console.log(`${run.excluded.length} measured script(s) are not in the scenario's corpus (schema bench enumeration) and are not in the report:`);
    for (const e of run.excluded) console.log(`  ${e.bench}: cpu_us ${e.cpu_us}, budget_cpu ${e.budget_cpu}`);
}
const summaryPath = flag("--summary");
if (summaryPath) {
    const { report: _report, ...rest } = run;
    const totals = { passed: own.passed, total: own.total, in_report: run.report.benchmarks.length };
    writeFileSync(summaryPath, JSON.stringify({ totals, ...rest, machine: run.report.machine, site: { passed: own.passed, total: own.total, failures: own.failures, corpus_total: corpusIds?.length } }, null, 2) + "\n");
}
