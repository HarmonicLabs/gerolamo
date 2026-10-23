/**
 * node-diversity-conformance `cbor-decoding` report for Gerolamo
 * (src/conformance/ndc/cborDecoding.ts; mapping and failure analysis: docs/parity/ndc-cbor-decoding.md).
 *
 *   bun scripts/ndc/cbor-decoding.ts --dataset <cardano-cbor-dataset>/dataset/conway-123-100 --out report.json
 *       [--schema <node-diversity-conformance>/scenarios/cbor-decoding/schema.json] [--rules value,relay]
 *
 * The dataset directory is read as data only. With --schema the report is checked against the
 * scenario's JSON schema (and the dataset README's count invariants) before it is written.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
    checkReportInvariants,
    LEDGER_CBOR_VERSION,
    LEDGER_TS_VERSION,
    runCorpus,
    score,
    validateAgainstSchema,
} from "../../src/conformance/ndc/cborDecoding";
import { logger, LogLevel } from "../../src/utils/logger";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dataset = arg("dataset");
const outPath = arg("out");
if (!dataset || !outPath) {
    console.error("usage: bun scripts/ndc/cbor-decoding.ts --dataset <dir>/dataset/conway-123-100 --out <file> [--schema schema.json] [--rules a,b]");
    process.exit(2);
}

const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const git = (...a: string[]): string => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
let commit = "unknown";
try {
    commit = git("rev-parse", "--short", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no").length > 0) commit += "-dirty"; // tracked changes only
} catch { /* not a checkout */ }
const pkg = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8"));
const rootCbor = JSON.parse(readFileSync(resolve(repo, "node_modules/@harmoniclabs/cbor/package.json"), "utf8")).version;

// headerParser logs a parse error per rejected header at error level
logger.setLogLevel(LogLevel.NONE);

const t0 = performance.now();
const report = await runCorpus(dataset, {
    rules: arg("rules")?.split(","),
    corpus: basename(resolve(dataset)),
    protocolVersion: "11.0",
    implementation: {
        name: "gerolamo",
        version: pkg.version,
        commit,
        "cardano-ledger-ts": LEDGER_TS_VERSION,
        cbor: LEDGER_CBOR_VERSION,
        "cbor-node": rootCbor,
    },
    onRule: (rule, o) => {
        const s = score(o);
        console.log(`${rule.padEnd(24)} round-trip ${o.generated_decoded_reencoded_actual}/${o.generated_decoded_reencoded_expected}  rejected ${o.generated_must_be_rejected_actual}/${o.generated_must_be_rejected_expected}  zap ${o.zap_must_be_rejected_actual}/${o.zap_must_be_rejected_expected}  (${s.met}/${s.expected})`);
    },
});
const s = score(report.totals);
console.log(`total ${s.met}/${s.expected} (${((100 * s.met) / s.expected).toFixed(2)} %), ${report.failures.length} failures, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const problems = checkReportInvariants(report);
const schemaPath = arg("schema");
if (schemaPath) problems.push(...validateAgainstSchema(JSON.parse(JSON.stringify(report)), JSON.parse(readFileSync(schemaPath, "utf8"))));
if (problems.length) {
    console.error(`report invalid:\n  ${problems.join("\n  ")}`);
    process.exit(1);
}
if (schemaPath) console.log(`schema ok (${schemaPath})`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${outPath}`);
