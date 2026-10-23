/**
 * node-diversity-conformance `ledger-rules` report for Gerolamo.
 *
 *   bun scripts/ndc/ledger-rules.ts --fixtures <scenarios/ledger-rules/fixtures> --out <report.json>
 *       [--schema <scenarios/ledger-rules/schema.json>] [--summary <file.json>] [--verbose] [--only 00036,00088]
 *
 * Runs every fixture through src/conformance/ndc/ledgerRules.ts and writes the report in the
 * scenario's schema (version 1): per fixture the observed result, `pass` or the predicate failure
 * in the corpus vocabulary. With `--schema`, a result the schema does not enumerate is printed and
 * the run exits 1 (the report is still written): such a name has to be looked at, never dropped.
 * The corpus is named after the fixture checkout's commit when it is a git checkout. `--verbose`
 * prints every non-conforming fixture with both paths' failures; `--log` keeps the node's INFO log
 * (every mempool admission) on.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { loadFixtures, reportOf, runAll, fixturesRoot, ledgerResultEnum, unknownResults, type FixtureOutcome } from "../../src/conformance/ndc/ledgerRules";
import { logger, LogLevel } from "../../src/utils/logger";

// the mempool logs every admission; keep the run's own output readable
logger.setLogLevel(process.argv.includes("--log") ? LogLevel.INFO : LogLevel.ERROR);

function arg(name: string): string | null {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function git(cwd: string, args: string[]): string | null {
    try {
        const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        return p.exitCode === 0 ? p.stdout.toString().trim() : null;
    } catch { return null; }
}

const fixturesArg = arg("fixtures");
const out = arg("out");
if (!fixturesArg || !out) {
    console.error("usage: bun scripts/ndc/ledger-rules.ts --fixtures <dir> --out <file.json> [--schema schema.json] [--summary file.json] [--verbose] [--only ids]");
    process.exit(2);
}
const verbose = process.argv.includes("--verbose");
const only = arg("only")?.split(",").map((s) => s.trim());
const root = fixturesRoot(resolve(fixturesArg));
let fixtures = loadFixtures(root);
if (only) fixtures = fixtures.filter((f) => only.includes(f.id));

const repo = resolve(import.meta.dir, "../..");
const head = git(repo, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
const dirty = (git(repo, ["status", "--porcelain"]) ?? "") !== "";
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version as string;
const corpusCommit = git(root, ["rev-parse", "--short", "HEAD"]);
const corpus = `node-diversity-conformance/scenarios/ledger-rules${corpusCommit ? `@${corpusCommit}` : ""}`;

const t0 = performance.now();
const outcomes: FixtureOutcome[] = await runAll(fixtures, (f, o) => {
    if (!verbose || o.conforms) return;
    const exp = f.expected.kind === "fail" ? `${f.expected.predicate}${f.expected.description ? `/${f.expected.description}` : ""}` : f.expected.kind;
    console.log(`✗ ${f.id} ${f.title}\n    expected ${exp}; observed ${o.result}${o.decodeError ? ` (${o.decodeError})` : ""}`);
    for (const x of o.failures) console.log(`      [${x.path}] ${x.name}${x.description ? `/${x.description}` : ""}${x.text ? `  — ${x.text.slice(0, 200)}` : ""}`);
    for (const t of o.details.mempool) console.log(`      mempool: ${t.slice(0, 200)}`);
    for (const t of o.details.block) console.log(`      block:   ${t.slice(0, 200)}`);
});
const report = reportOf(outcomes, { version, commit: `${head}${dirty ? "-dirty" : ""}`, corpus });
if (!existsSync(dirname(resolve(out)))) throw new Error(`output directory ${dirname(resolve(out))} does not exist`);
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`ledger-rules: ${report.totals.passed}/${report.totals.total} conform (${((performance.now() - t0) / 1000).toFixed(1)} s) → ${out}`);
for (const o of outcomes) if (!o.conforms) console.log(`  ✗ ${o.id}: observed ${o.result}, expected ${o.expected.kind === "fail" ? o.expected.predicate : o.expected.kind}`);

let unknown: Array<{ id: string; result: string }> = [];
const schemaPath = arg("schema");
if (schemaPath) {
    const allowed = ledgerResultEnum(JSON.parse(readFileSync(schemaPath, "utf8")));
    if (!allowed) console.log(`${schemaPath}: no result vocabulary to check against`);
    else {
        unknown = unknownResults(report, allowed);
        if (unknown.length) {
            console.error(`${unknown.length} result(s) are not in the schema's vocabulary (${allowed.size} names) — look at them, the site cannot score them:`);
            for (const u of unknown) console.error(`  ${u.id}: ${u.result}`);
        } else console.log(`every result is in the schema's vocabulary (${allowed.size} names)`);
    }
}
const summaryPath = arg("summary");
if (summaryPath) {
    writeFileSync(summaryPath, JSON.stringify({
        implementation: report.implementation, corpus: report.corpus, totals: report.totals, unknown_results: unknown,
        failing: outcomes.filter((o) => !o.conforms).map((o) => ({ id: o.id, result: o.result, expected: o.expected, failures: o.failures.map((x) => `${x.path}: ${x.name}${x.description ? `/${x.description}` : ""}`) })),
    }, null, 2) + "\n");
}
if (unknown.length) process.exit(1);
