#!/usr/bin/env bun
/**
 * Produce all four node-diversity-conformance reports with release-asset names, validate each against the
 * scenario schema, score each the way the site's build does (src/conformance/ndc/ndcScore.ts), and write a
 * manifest with sha256 digests, both scores and the metadata the schemas no longer let a report carry.
 *
 *   bun scripts/ndc/report-all.ts --corpora <dir of fetch-corpora.ts> --out <dir>
 *       [--date YYYYMMDD] [--turbo-runs 50] [--turbo-best 30] [--turbo-reference <uplc-turbo report.json>]
 *       [--only cbor,ledger,uplc,turbo] [--allow-dirty]
 *       [--ndc <dir>] [--cbor-dataset <dir>] [--uplc <dir>] [--turbo <dir>]      (overrides of what --corpora implies)
 *
 * `--corpora` is the directory fetch-corpora.ts filled: its corpora.json gives the archives' digests, and the
 * four inputs default to <dir>/ndc, <dir>/cbor-dataset/dataset/conway-123-100, <dir>/uplc-conformance and
 * <dir>/uplc-turbo. The turbo budgets are compared with `--turbo-reference` (default: cardano-node's report as
 * pragma's build downloaded it into <ndc>/_site/reports/uplc-turbo/cardano-node.json, when that exists).
 *
 * Asset names follow the pattern pragma's build matches (`gerolamo-*-<scenario>.json`, latest YYYYMMDD wins):
 *   gerolamo-<version>-<date>-cbor-conformance.json
 *   gerolamo-<version>-<date>-ledger-rules.json
 *   gerolamo-<version>-<date>-uplc-conformance.json
 *   gerolamo-<version>-<date>-uplc-turbo.json
 *
 * The uplc-conformance and uplc-turbo schemas allow nothing beyond their fields (`additionalProperties: false`),
 * so Gerolamo's version and commit, the corpus digests, the turbo setup and the cost models live in
 * `manifest.json` (per report under `metadata`), next to `totals` (our verdicts) and `site` (what the site computes).
 *
 * A dirty working tree is refused unless --allow-dirty: a published report must name a commit anyone can check out.
 * Nothing here publishes anything; see scripts/ndc/publish.ts and docs/parity/ndc-publish.md. The turbo run wants a
 * quiet machine: run the whole thing under `taskset -c <two idle cores>` (docs/parity/ndc-run.md).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerDefinitions, scoreCborDecoding, scoreLedgerRules, scoreUplcConformance, scoreUplcTurbo, turboCorpusBenchIds, type SiteScore } from "../../src/conformance/ndc/ndcScore";
import { checkSchema } from "../../src/conformance/ndc/uplcSchemaCheck";
import { implementation } from "../../src/conformance/ndc/uplcCommon";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const has = (k: string) => argv.includes(`--${k}`);
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

const corpora = flag("corpora");
const corporaManifest: any = corpora && existsSync(join(corpora, "corpora.json")) ? JSON.parse(readFileSync(join(corpora, "corpora.json"), "utf8")) : {};
const input = (k: string, sub: string) => flag(k) ?? (corpora ? join(corpora, sub) : undefined) ?? fail(`missing --${k} (or --corpora <dir of fetch-corpora.ts>)`);
const ndc = input("ndc", "ndc");
const out = flag("out") ?? fail("missing --out");
const only = new Set((flag("only", "cbor,ledger,uplc,turbo") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const date = flag("date", new Date().toISOString().slice(0, 10).replace(/-/g, ""))!;
const impl = implementation();
if (impl.commit.endsWith("-dirty") && !has("allow-dirty")) fail(`working tree is dirty (${impl.commit}); commit first, or pass --allow-dirty for a local run`);
mkdirSync(out, { recursive: true });
const asset = (scenario: string) => join(out, `gerolamo-${impl.version}-${date}-${scenario}.json`);
const ROOT = new URL("../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "ndc-report-"));
const schemaOf = (scenario: string) => join(ndc, `scenarios/${scenario}/schema.json`);
const digestFlags = (key: string) => (corporaManifest[key]?.sha256 ? ["--digest", corporaManifest[key].sha256] : []);

interface Job { key: string; scenario: string; asset: string; args: string[]; summary?: string; site: (report: any) => SiteScore }
const jobs: Job[] = [];
if (only.has("cbor")) jobs.push({
    key: "cbor", scenario: "cbor-decoding", asset: "cbor-conformance",
    args: ["scripts/ndc/cbor-decoding.ts", "--dataset", input("cbor-dataset", "cbor-dataset/dataset/conway-123-100"), "--schema", schemaOf("cbor-decoding")],
    site: scoreCborDecoding,
});
if (only.has("ledger")) jobs.push({
    key: "ledger", scenario: "ledger-rules", asset: "ledger-rules", summary: join(scratch, "ledger-rules.json"),
    args: ["scripts/ndc/ledger-rules.ts", "--fixtures", join(ndc, "scenarios/ledger-rules/fixtures"), "--schema", schemaOf("ledger-rules")],
    site: (r) => scoreLedgerRules(r, ledgerDefinitions(join(ndc, "scenarios/ledger-rules/fixtures"))),
});
if (only.has("uplc")) jobs.push({
    key: "uplc", scenario: "uplc-conformance", asset: "uplc-conformance", summary: join(scratch, "uplc-conformance.json"),
    args: ["scripts/ndc/uplc-conformance.ts", "--corpus", input("uplc", "uplc-conformance"), "--expectations", join(ndc, "scenarios/uplc-conformance/expectations.json"), ...digestFlags("uplc_conformance")],
    site: (r) => scoreUplcConformance(r, JSON.parse(readFileSync(join(ndc, "scenarios/uplc-conformance/expectations.json"), "utf8")).scenarios),
});
if (only.has("turbo")) {
    const reference = flag("turbo-reference") ?? (existsSync(join(ndc, "_site/reports/uplc-turbo/cardano-node.json")) ? join(ndc, "_site/reports/uplc-turbo/cardano-node.json") : undefined);
    jobs.push({
        key: "turbo", scenario: "uplc-turbo", asset: "uplc-turbo", summary: join(scratch, "uplc-turbo.json"),
        args: ["scripts/ndc/uplc-turbo.ts", "--corpus", input("turbo", "uplc-turbo"), "--runs", flag("turbo-runs", "50")!, "--best", flag("turbo-best", "30")!, "--schema", schemaOf("uplc-turbo"),
            ...digestFlags("uplc_turbo"), ...(reference ? ["--reference", reference] : [])],
        site: (r) => scoreUplcTurbo(r, turboCorpusBenchIds(JSON.parse(readFileSync(schemaOf("uplc-turbo"), "utf8")))),
    });
}

// with --only, the other scenarios' entries of an existing manifest are kept
const manifestPath = join(out, "manifest.json");
const previous = has("only") && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const manifest: Record<string, unknown> = { implementation: impl, date, ndc_schemas: gitHead(ndc), corpora: corporaManifest, reports: { ...(previous.reports ?? {}) } as Record<string, unknown> };
const lines: string[] = [];
let failed = false;
for (const j of jobs) {
    const file = asset(j.asset);
    console.log(`\n== ${j.scenario} → ${file}`);
    const args = [...j.args, "--out", file, ...(j.summary ? ["--summary", j.summary] : [])];
    const proc = Bun.spawnSync(["bun", ...args], { cwd: ROOT, stdout: "inherit", stderr: "inherit", env: process.env });
    if (proc.exitCode !== 0) { console.error(`${j.scenario}: exit ${proc.exitCode}`); failed = true; continue; }
    const report = JSON.parse(readFileSync(file, "utf8"));
    const schema = JSON.parse(readFileSync(schemaOf(j.scenario), "utf8"));
    const errs = checkSchema(schema, report);
    if (errs.length) { console.error(`${j.scenario}: ${errs.length} schema error(s)\n  ${errs.slice(0, 10).join("\n  ")}`); failed = true; continue; }
    if (report.scenario !== j.scenario || report.version !== "1") { console.error(`${j.scenario}: wrong scenario/version`); failed = true; continue; }
    const bytes = readFileSync(file);
    const metadata = j.summary && existsSync(j.summary) ? JSON.parse(readFileSync(j.summary, "utf8")) : undefined;
    const site = j.site(report);
    const totals = report.totals ?? metadata?.totals ?? null;
    (manifest.reports as Record<string, unknown>)[j.scenario] = {
        file: file.split("/").pop(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        totals, site: { passed: site.passed, total: site.total }, metadata,
    };
    // cbor-decoding's totals are the per-class counters; its own score is the site's sum
    const ours = totals && typeof totals.passed === "number" ? `${totals.passed}/${totals.total}` : `${site.passed}/${site.total}`;
    const line = `${j.scenario}: schema ok, ${bytes.length} bytes; ours ${ours}, site ${site.passed}/${site.total}`;
    lines.push(line);
    console.log(line);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
rmSync(scratch, { recursive: true, force: true });
console.log(`\nmanifest: ${manifestPath}\n${lines.join("\n")}`);
process.exit(failed ? 1 : 0);

function gitHead(dir: string): string | null {
    try { const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe" }); return p.exitCode === 0 ? p.stdout.toString().trim() : null; } catch { return null; }
}
