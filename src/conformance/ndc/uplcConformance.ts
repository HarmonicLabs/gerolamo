/**
 * node-diversity-conformance scenario `uplc-conformance` (functional): pragma's corpus
 * (`uplc-conformance.tar.zst`, 1 064 vectors — the IntersectMBO plutus suite and the regression
 * vectors — laid out as `protocol-version-<pv>/v<lang>/<group…>/<case>/<case>.uplc`, with the cost
 * models to evaluate under in `cost-models/protocol-version-<pv>/v<lang>.json`) run through
 * Gerolamo's CEK machine (src/consensus/plutus) as the folder's Plutus language at the folder's
 * protocol version, within mainnet's transaction budget (the README's 10 B CPU / 14 M memory).
 * Each vector has two dimensions, scored separately by the site:
 *
 *   - evaluation: the result term as textual UPLC (uplcPrint.ts; compared up to whitespace), or
 *     "evaluation failure" / "out of budget" / "parse/decode error" (compared exactly);
 *   - budget: the consumed CPU / memory, exactly, where a result is expected.
 *
 * The report (schema 8974561) carries observations only; the site decides pass or fail against
 * its expectations.json. Our own verdict — the same comparison against the corpus's `.uplc.expected`
 * and `.budget` files — is kept beside the report for the console, the manifest and the tests. A
 * `.budget` saturated at Int64 (the suite's counting evaluator has no limit) means the vector runs
 * out of a real budget: expected "out of budget", as the site's expectations say. Where a vector
 * ships a `.flat` form, the flat program must also decode (as the vector's language at its protocol
 * version) to the textual one — the on-chain path agreeing with the text — and so must
 * `.flat.expected`; an empty `.flat` (BLS12-381 constants have no flat form) skips the check.
 *
 * Ids, titles and groups follow the site's naming: the vector's path under `v<lang>/` with
 * non-alphanumerics as `_`, lower-cased, plus `_v<lang>` (`builtin_parser_value_zero_asset_v3`);
 * the title is the case's directory name with punctuation as spaces; the group the directories
 * between the language and the case (`builtin/parser/value`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { costTable, type Lang } from "../../consensus/plutus/costs";
import { decodeProgram } from "../../consensus/plutus/flat";
import { runTextVector, type VectorOutcome } from "../../consensus/plutus/conformance";
import { encodeProgramFlat, parseBudget, parseProgram, termEq } from "../../consensus/plutus/uplcText";
import { MAINNET_TX_BUDGET, defaultCostModel, defaultCostModelVariant, implementation, type Implementation } from "./uplcCommon";
import { printProgram } from "./uplcPrint";

export interface UplcVector {
    id: string; title: string; group: string;
    lang: 1 | 2 | 3; pv: number; costModelId: string;
    /** `<case>.uplc`, `<case>.uplc.expected`, `<case>.budget` */
    program: string; expected: string; budget: string;
    /** hex flat program / expected output (`<case>.flat`, `<case>.flat.expected`), where the vector has them */
    flat?: string; flatExpected?: string;
    /** the vector's directory, relative to the corpus root */
    path: string;
}
export interface UplcCorpus {
    vectors: UplcVector[];
    /** `costModelId(lang, pv)` → the corpus's cost-models/protocol-version-<pv>/v<lang>.json */
    costModels: Map<string, number[]>;
    root: string;
}

/** The README's budget: 10 B CPU, 14 M memory (mainnet's maxTxExecutionUnits). */
export const MACHINE_BUDGET = MAINNET_TX_BUDGET;
/** Int64's maxBound: the suite's saturated budget for a vector that runs out of any real budget. */
const SATURATED = 9223372036854775807;

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const idOf = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
const titleOf = (s: string) => s.replace(/[^A-Za-z0-9]+/g, " ").trim();
const PV_DIR = /^protocol-version-(\d+)$/, LANG_DIR = /^v([123])$/;

export function costModelId(lang: Lang, pv: number): string { return `v${lang}-pv${pv}`; }

/** The unpacked corpus: `dir` itself, or its `uplc-conformance/` child (both hold `cost-models/` and the `protocol-version-N/` directories). */
export function findCorpusRoot(dir: string): string {
    for (const c of [dir, join(dir, "uplc-conformance")]) if (existsSync(join(c, "cost-models")) && readdirSync(c).some((e) => PV_DIR.test(e))) return c;
    throw new Error(`${dir}: not an unpacked uplc-conformance corpus (no cost-models/ and protocol-version-N/ directories)`);
}

export function loadUplcCorpus(dir: string): UplcCorpus {
    const root = findCorpusRoot(dir);
    const costModels = new Map<string, number[]>();
    for (const pvDir of readdirSync(join(root, "cost-models"))) {
        const m = PV_DIR.exec(pvDir); if (!m) continue;
        for (const f of readdirSync(join(root, "cost-models", pvDir))) {
            const l = /^v([123])\.json$/.exec(f); if (!l) continue;
            const list = JSON.parse(read(join(root, "cost-models", pvDir, f)));
            if (!Array.isArray(list) || !list.every((x) => Number.isInteger(x))) throw new Error(`${pvDir}/${f}: not a list of integers`);
            costModels.set(costModelId(Number(l[1]) as Lang, Number(m[1])), list);
        }
    }
    const vectors: UplcVector[] = [];
    for (const pvDir of readdirSync(root).sort()) {
        const pm = PV_DIR.exec(pvDir); if (!pm) continue;
        const pv = Number(pm[1]);
        for (const langDir of readdirSync(join(root, pvDir)).sort()) {
            const lm = LANG_DIR.exec(langDir); if (!lm) continue;
            const lang = Number(lm[1]) as 1 | 2 | 3, langRoot = join(root, pvDir, langDir);
            if (!costModels.has(costModelId(lang, pv))) throw new Error(`${pvDir}/${langDir}: no cost-models/${pvDir}/${langDir}.json`);
            const walk = (d: string) => {
                for (const e of readdirSync(d).sort()) {
                    const p = join(d, e);
                    if (statSync(p).isDirectory()) { walk(p); continue; }
                    if (!e.endsWith(".uplc")) continue;
                    const rel = relative(langRoot, d).split(sep).join("/");
                    const parts = rel.split("/"), leaf = parts.pop()!;
                    const base = p.slice(0, -".uplc".length);
                    vectors.push({
                        id: `${idOf(rel)}_v${lang}`, title: titleOf(leaf), group: parts.join("/"),
                        lang, pv, costModelId: costModelId(lang, pv),
                        program: read(p), expected: read(`${p}.expected`), budget: existsSync(`${base}.budget`) ? read(`${base}.budget`) : "",
                        ...(existsSync(`${base}.flat`) ? { flat: read(`${base}.flat`) } : {}),
                        ...(existsSync(`${base}.flat.expected`) ? { flatExpected: read(`${base}.flat.expected`) } : {}),
                        path: relative(root, d).split(sep).join("/"),
                    });
                }
            };
            walk(langRoot);
        }
    }
    return { vectors, costModels, root };
}

/** One row of the report (scenarios/uplc-conformance/schema.json `scenarios[]`). */
export interface UplcRow {
    id: string; title: string; group: string; plutus_version: string; protocol_version: string;
    /** The result program as text, or "evaluation failure" | "out of budget" | "parse/decode error" (or "crash": the evaluator threw). */
    evaluation: string;
    budget: { cpu: number; mem: number } | null;
    error?: string;
}
/** Our own comparison of a row with the vector's `.uplc.expected` / `.budget` (what the site does with its expectations.json). */
export interface UplcVerdict {
    id: string; plutus_version: string; protocol_version: string; cost_model_id: string;
    expected: { evaluation: VectorOutcome; budget: { cpu: number; mem: number } | null };
    evaluation_passed: boolean;
    /** null where the vector expects no budget (a failure, or no `.budget` figure). */
    budget_passed: boolean | null;
    passed: boolean;
    detail?: string;
}

/** The vector's expected outcome; a saturated `.budget` turns an expected result into "out of budget". */
export function expectedOutcome(v: UplcVector): { outcome: VectorOutcome; budget: { cpu: number; mem: number } | null } {
    const e = v.expected.trim();
    if (e === "parse error" || e === "parse/decode error") return { outcome: "parse error", budget: null };
    if (e === "evaluation failure") return { outcome: "evaluation failure", budget: null };
    if (e === "out of budget") return { outcome: "out of budget", budget: null };
    const budget = parseBudget(v.budget);
    if (budget && (budget.cpu >= SATURATED || budget.mem >= SATURATED)) return { outcome: "out of budget", budget: null };
    return { outcome: "success", budget };
}

const hexOk = (s: string) => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
const pvText = (pv: number) => `${pv}.0`;
const outcomeText = (o: VectorOutcome) => (o === "parse error" ? "parse/decode error" : o);

/** Run one vector under its corpus cost model (`costs`: the list of `costModelId(v.lang, v.pv)`). */
export function runUplcVector(v: UplcVector, costs: ReadonlyArray<number>): { row: UplcRow; verdict: UplcVerdict } {
    const exp = expectedOutcome(v);
    const plutus_version = `V${v.lang}`, protocol_version = pvText(v.pv);
    const done = (evaluation: string, budget: UplcRow["budget"], evaluationPassed: boolean, budgetPassed: boolean | null, detail?: string, error?: string) => {
        const row: UplcRow = { id: v.id, title: v.title, group: v.group, plutus_version, protocol_version, evaluation, budget };
        if (error) row.error = error;
        const verdict: UplcVerdict = {
            id: v.id, plutus_version, protocol_version, cost_model_id: v.costModelId,
            expected: { evaluation: exp.outcome, budget: exp.budget }, evaluation_passed: evaluationPassed, budget_passed: budgetPassed, passed: evaluationPassed && budgetPassed !== false,
        };
        if (detail) verdict.detail = detail;
        return { row, verdict };
    };
    // a failed vector that expects a budget fails that dimension too; one expecting none leaves it out
    const budgetMissed = exp.budget ? false : null;
    let run;
    try { run = runTextVector(v.program, costTable(v.lang, costs, v.pv), { lang: v.lang, pv: v.pv, budget: MACHINE_BUDGET }); }
    catch (e) { const msg = `evaluator threw: ${(e as Error).message}`; return done("crash", null, false, budgetMissed, msg, msg); }

    if (run.outcome !== "success") {
        // The suite's `.uplc.expected` comes from an unlimited counting evaluator, so a failing builtin
        // whose cost alone exceeds the README's budget reads "evaluation failure" there while any machine
        // under that budget — the Haskell reference included, hence the site's expectations — runs out
        // of budget first (dropList with a count beyond u64). The report says what happened.
        const ok = run.outcome === exp.outcome || (exp.outcome === "evaluation failure" && run.outcome === "out of budget");
        return done(outcomeText(run.outcome), null, ok, ok ? null : budgetMissed, ok ? undefined : `${run.detail ?? run.outcome}; expected ${outcomeText(exp.outcome)}`);
    }
    const consumed = { cpu: run.cpu, mem: run.mem };
    const text = printProgram(parseProgram(v.program).version, run.term!);
    if (exp.outcome !== "success") return done(text, consumed, false, null, `evaluated, expected ${outcomeText(exp.outcome)}`);
    const budgetPassed = exp.budget ? consumed.cpu === exp.budget.cpu && consumed.mem === exp.budget.mem : null;
    let want;
    try { want = parseProgram(v.expected).term; }
    catch (e) { const msg = `expected output unparseable: ${(e as Error).message}`; return done(text, consumed, false, budgetPassed, msg, msg); }
    if (!termEq(run.term!, want)) return done(text, consumed, false, budgetPassed, "the result term differs from the expected one");
    const flatErr = checkFlat(v);
    if (flatErr) return done(text, consumed, false, budgetPassed, flatErr, flatErr);
    return done(text, consumed, true, budgetPassed);
}

/**
 * The flat forms agree with the text: `.flat` decodes (as the vector's language at its protocol
 * version, the on-chain path) to the program, `.flat.expected` to the expected output. Empty files
 * and the failure words are skipped; a program without a flat form (BLS12-381 points) too.
 */
function checkFlat(v: UplcVector): string | null {
    const pairs: Array<[string | undefined, string, string]> = [[v.flat, v.program, "program"], [v.flatExpected, v.expected, "expected output"]];
    for (const [hex, text, what] of pairs) {
        if (hex === undefined) continue;
        const h = hex.trim();
        if (!hexOk(h)) continue;
        let decoded;
        try { decoded = decodeProgram(new Uint8Array(Buffer.from(h, "hex")), v.lang, v.pv); }
        catch (e) {
            if (!flatEncodable(text)) return null;
            return `flat ${what} does not decode: ${(e as Error).message}`;
        }
        if (!termEq(decoded.term, parseProgram(text).term)) return `flat ${what} decodes to a different term`;
    }
    return null;
}
function flatEncodable(text: string): boolean {
    try { encodeProgramFlat(parseProgram(text)); return true; } catch { return false; }
}

/** scenarios/uplc-conformance/schema.json: nothing beyond these keys is allowed. */
export interface UplcConformanceReport {
    version: "1"; scenario: "uplc-conformance"; generated_at: string;
    implementation: { name: string };
    scenarios: UplcRow[];
}
interface Dim { passed: number; failed: number; total: number }
export interface UplcCostModel { id: string; plutus_version: string; protocol_version: string; parameters: number; source: string; default_variant: string | null }
/** The report plus what the schema no longer lets it carry (report-all.ts puts it in manifest.json). */
export interface UplcConformanceRun {
    report: UplcConformanceReport;
    verdicts: UplcVerdict[];
    totals: { passed: number; failed: number; total: number; evaluation: Dim; budget: Dim };
    implementation: Implementation;
    corpus: string; corpus_digest?: string;
    budget_limit: { cpu: number; mem: number };
    cost_models: UplcCostModel[];
}

export function buildUplcConformanceReport(corpus: UplcCorpus, opts: { corpusDigest?: string; now?: Date } = {}): UplcConformanceRun {
    // rows in id order (byte order), the same vector under two protocol versions by version
    const key = (x: { id: string; protocol_version: string }) => `${x.id}\u0000${x.protocol_version.padStart(6, "0")}`;
    const results = corpus.vectors.map((v) => runUplcVector(v, corpus.costModels.get(v.costModelId)!)).sort((a, b) => (key(a.row) < key(b.row) ? -1 : key(a.row) > key(b.row) ? 1 : 0));
    const rows = results.map((r) => r.row), verdicts = results.map((r) => r.verdict);
    const dim = (pick: (r: UplcVerdict) => boolean | null): Dim => {
        const xs = verdicts.map(pick).filter((x) => x !== null);
        const passed = xs.filter((x) => x === true).length;
        return { passed, failed: xs.length - passed, total: xs.length };
    };
    const used = new Map<string, { lang: Lang; pv: number }>();
    for (const v of corpus.vectors) used.set(v.costModelId, { lang: v.lang, pv: v.pv });
    const cost_models = [...used.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, { lang, pv }]): UplcCostModel => {
        const list = corpus.costModels.get(id)!;
        let variant: string | null = null;
        try { if (JSON.stringify(defaultCostModel(lang, pv)) === JSON.stringify(list)) variant = defaultCostModelVariant(lang, pv); } catch { /* not covered by the fixture */ }
        return {
            id, plutus_version: `V${lang}`, protocol_version: pvText(pv), parameters: list.length,
            source: `${corpus.root.split("/").pop()}/cost-models/protocol-version-${pv}/v${lang}.json`,
            default_variant: variant,
        };
    });
    const passed = verdicts.filter((r) => r.passed).length;
    const run: UplcConformanceRun = {
        report: {
            version: "1", scenario: "uplc-conformance", generated_at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
            implementation: { name: "gerolamo" }, scenarios: rows,
        },
        verdicts,
        totals: { passed, failed: verdicts.length - passed, total: verdicts.length, evaluation: dim((r) => r.evaluation_passed), budget: dim((r) => r.budget_passed) },
        implementation: implementation(), corpus: "node-diversity-conformance uplc-conformance.tar.zst",
        budget_limit: { ...MACHINE_BUDGET }, cost_models,
    };
    if (opts.corpusDigest) run.corpus_digest = opts.corpusDigest;
    return run;
}
