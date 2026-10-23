/**
 * How pragma's site scores a report (node-diversity-conformance `scripts/build.py` and the
 * scenarios' `build.py`, commit 8974561), in TypeScript so report-all.ts can print what the site
 * will compute from a report before it is published, and the tests can check that our own
 * verdicts agree with it. Data in, numbers out; nothing here runs the corpora.
 *
 *   - cbor-decoding: sum of `*_actual` over sum of `*_expected` in `totals`;
 *   - ledger-rules: a fixture counts when the report's `result` for its id equals the fixture's
 *     expectation ("pass", "DecodingFailure", or the predicate); a missing id is a failure;
 *   - uplc-conformance: a row matches an expectation by id, plutus_version and protocol_version;
 *     the evaluation text must agree up to whitespace and the budget exactly where one is expected;
 *   - uplc-turbo: per benchmark of the corpus, cpu within 2× its budget (1 unit = 1 ps) or within
 *     200 µs of it, memory likewise (1 unit = 1 byte, 320 KiB tolerance) when reported; a missing
 *     benchmark fails. The site's fourth rule (budget agreement with the other nodes) needs their
 *     reports and is not computed here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeEvaluation } from "./uplcPrint";

export interface SiteScore { passed: number; total: number; failures: string[] }

// ───────────────────────────── cbor-decoding ─────────────────────────────

export function scoreCborDecoding(report: any): SiteScore {
    const totals: Record<string, number> = report?.totals ?? {};
    let expected = 0, actual = 0;
    for (const [k, v] of Object.entries(totals)) {
        if (k.endsWith("_expected")) expected += v;
        else if (k.endsWith("_actual")) actual += v;
    }
    return { passed: actual, total: expected, failures: [] };
}

// ───────────────────────────── ledger-rules ─────────────────────────────

/** `expected_result`: what the site wants to see in `result` for a fixture. */
export function ledgerExpectedResult(expected: unknown): string {
    if (expected === undefined || expected === "Pass") return "pass";
    if (expected && typeof expected === "object") {
        const e = expected as Record<string, unknown>;
        if (e.decoding_failure === true) return "DecodingFailure";
        if (typeof e.predicate === "string" && e.predicate) return e.predicate;
    }
    return "failed";
}

/** The site's definitions: `<fixtures>/scenarios/<id>-*.json` → id and expected result. */
export function ledgerDefinitions(fixturesDir: string): Array<{ id: string; expected: string }> {
    const dir = join(fixturesDir, "scenarios");
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
        const m = /^(\d{5})-/.exec(f);
        if (!m) throw new Error(`${f}: scenario filename must start with a five-digit id`);
        const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { id: m[1]!, expected: ledgerExpectedResult(doc.expected) };
    });
}

export function scoreLedgerRules(report: any, definitions: Array<{ id: string; expected: string }>): SiteScore {
    const results = new Map<string, unknown>();
    const ids = new Set(definitions.map((d) => d.id));
    for (const item of report?.scenarios ?? []) {
        const id = String(item?.id ?? "").slice(0, 5);
        if (ids.has(id)) results.set(id, item.result); // the last row of an id wins, as the site's dict comprehension
    }
    const failures: string[] = [];
    for (const d of definitions) {
        const r = results.get(d.id);
        if (r !== d.expected) failures.push(`${d.id}: expected ${d.expected}, report says ${r === undefined ? "nothing" : JSON.stringify(r)}`);
    }
    return { passed: definitions.length - failures.length, total: definitions.length, failures };
}

// ───────────────────────────── uplc-conformance ─────────────────────────────

export interface UplcExpectation { id: string; plutus_version?: unknown; protocol_version?: unknown; evaluation?: unknown; budget?: { cpu: number; mem: number } | null }

function budgetValue(v: unknown): { cpu: number; mem: number } | null {
    if (v && typeof v === "object") return v as { cpu: number; mem: number };
    if (typeof v !== "string") return null;
    const m = /cpu:\s*(-?\d+).*?mem:\s*(-?\d+)/s.exec(v);
    return m ? { cpu: Number(m[1]), mem: Number(m[2]) } : null;
}
const budgetEq = (a: { cpu: number; mem: number } | null, b: { cpu: number; mem: number } | null) => (a === null || b === null ? a === b : a.cpu === b.cpu && a.mem === b.mem);

export function scoreUplcConformance(report: any, expectations: UplcExpectation[]): SiteScore {
    const actual = new Map<string, any[]>();
    for (const item of report?.scenarios ?? []) {
        const xs = actual.get(item?.id) ?? [];
        xs.push(item);
        actual.set(item?.id, xs);
    }
    const used = new Set<string>();
    const failures: string[] = [];
    for (const e of expectations) {
        const candidates = (actual.get(e.id) ?? []).map((item, index) => ({ index, item })).filter(({ index }) => !used.has(`${e.id}#${index}`));
        const same = candidates.find(({ item }) => item.plutus_version === e.plutus_version && item.protocol_version === e.protocol_version) ?? candidates[0];
        const label = `${e.id} (${e.plutus_version} @ ${e.protocol_version})`;
        if (!same) { failures.push(`${label}: no row`); continue; }
        used.add(`${e.id}#${same.index}`);
        const item = same.item;
        const metadataOk = item.plutus_version === e.plutus_version && item.protocol_version === e.protocol_version;
        const evaluationOk = metadataOk && normalizeEvaluation(String(item.evaluation ?? "")) === normalizeEvaluation(String(e.evaluation ?? ""));
        const expectedBudget = e.budget ?? null;
        const budgetOk = expectedBudget === null || (metadataOk && budgetEq(budgetValue(item.budget), expectedBudget));
        if (!metadataOk) failures.push(`${label}: row is ${item.plutus_version} @ ${item.protocol_version}`);
        else if (!evaluationOk) failures.push(`${label}: evaluation ${JSON.stringify(String(item.evaluation ?? "").slice(0, 120))} ≠ expected ${JSON.stringify(String(e.evaluation ?? "").slice(0, 120))}`);
        else if (!budgetOk) failures.push(`${label}: budget ${JSON.stringify(item.budget)} ≠ expected ${JSON.stringify(expectedBudget)}`);
    }
    return { passed: expectations.length - failures.length, total: expectations.length, failures };
}

// ───────────────────────────── uplc-turbo ─────────────────────────────

export const TURBO_DEVIATION_LIMIT = 1.0;
export const TURBO_CPU_TOLERANCE_US = 200;
export const TURBO_MEMORY_TOLERANCE_BYTES = 320 * 1024;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One benchmark's cpu and memory verdicts (null: dimension not reported); `pass`: the site's per-benchmark outcome. */
export function turboMeasurements(item: any): { cpu_delta: number | null; cpu_pass: boolean | null; mem_delta: number | null; mem_pass: boolean | null; pass: boolean } {
    const cpuUs = isNumber(item?.cpu_us) ? item.cpu_us : null;
    const memBytes = isNumber(item?.mem_bytes) ? item.mem_bytes : null;
    const cpuBudget = isNumber(item?.budget_cpu) && item.budget_cpu > 0 ? item.budget_cpu / 1_000_000 : null;
    const memBudget = isNumber(item?.budget_mem) && item.budget_mem > 0 ? item.budget_mem : null;
    const cpuDelta = cpuUs !== null && cpuBudget !== null ? (cpuUs - cpuBudget) / cpuBudget : null;
    const memDelta = memBytes !== null && memBudget !== null ? (memBytes - memBudget) / memBudget : null;
    const cpuPass = cpuDelta === null ? null : cpuDelta <= TURBO_DEVIATION_LIMIT || Math.abs(cpuUs! - cpuBudget!) <= TURBO_CPU_TOLERANCE_US;
    const memPass = memDelta === null ? null : memDelta <= TURBO_DEVIATION_LIMIT || Math.abs(memBytes! - memBudget!) <= TURBO_MEMORY_TOLERANCE_BYTES;
    const checks = [cpuPass, memPass].filter((x): x is boolean => x !== null);
    return { cpu_delta: cpuDelta, cpu_pass: cpuPass, mem_delta: memDelta, mem_pass: memPass, pass: checks.length > 0 && checks.every(Boolean) };
}

/** `benchIds`: the corpus (the schema's `bench` enum); without it, the report's own benchmarks are the denominator. */
export function scoreUplcTurbo(report: any, benchIds?: readonly string[]): SiteScore {
    const items = new Map<string, any>();
    for (const b of report?.benchmarks ?? []) if (typeof b?.bench === "string") items.set(b.bench, b);
    const ids = benchIds ?? [...items.keys()];
    const failures: string[] = [];
    for (const id of ids) {
        const item = items.get(id);
        if (!item) { failures.push(`${id}: missing`); continue; }
        const m = turboMeasurements(item);
        if (!m.pass) failures.push(`${id}: cpu ${item.cpu_us} µs vs budget ${(item.budget_cpu ?? 0) / 1e6} µs (delta ${m.cpu_delta?.toFixed(2)})${m.mem_pass === false ? `, mem delta ${m.mem_delta?.toFixed(2)}` : ""}`);
    }
    return { passed: ids.length - failures.length, total: ids.length, failures };
}

/** The `bench` enumeration of the uplc-turbo schema: the corpus the site scores against. */
export function turboCorpusBenchIds(schema: any): string[] {
    const ids = schema?.$defs?.benchmark?.properties?.bench?.enum;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new Error("uplc-turbo schema: no bench enumeration");
    return ids;
}
