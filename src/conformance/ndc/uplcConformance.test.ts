import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProgram, termEq } from "../../consensus/plutus/uplcText";
import { buildUplcConformanceReport, expectedOutcome, loadUplcCorpus, runUplcVector, type UplcVector } from "./uplcConformance";
import { MAINNET_TX_BUDGET, defaultCostModel, defaultCostModelVariant, defaultCostModelsFixture, pvOfEpoch } from "./uplcCommon";
import { normalizeEvaluation, printProgram, quoteString } from "./uplcPrint";
import { ledgerExpectedResult, scoreLedgerRules, scoreUplcConformance, scoreUplcTurbo, turboMeasurements } from "./ndcScore";
import { checkSchema } from "./uplcSchemaCheck";
import { benchScript, bestMean, budgetAgreement, budgetOf, listTurboFiles, loadTurboScript, machineInfo, median, percentile, sitePasses, toReportBenchmark, type TurboBenchmark } from "./uplcTurbo";

/**
 * node-diversity-conformance `uplc-conformance` and `uplc-turbo` against pragma's corpora. Set
 * NDC_UPLC_CORPUS to the unpacked uplc-conformance.tar.zst and NDC_TURBO_CORPUS to the unpacked
 * turbo.tar.zst (scripts/ndc/fetch-corpora.ts: <dir>/uplc-conformance, <dir>/uplc-turbo); optionally
 * NDC_DIR to a node-diversity-conformance checkout to check the reports against the schemas, score
 * the conformance report the site's way and compare the turbo budgets with cardano-node's report
 * (<ndc>/_site/reports/uplc-turbo/cardano-node.json, which pragma's build downloads). Scores on
 * 2026-10-18 (archives 821af55e… / 8bd4ad4f…, schemas 8974561): 1064 / 1064 vectors, budget
 * 750 / 750; turbo budgets 3997 / 3997 equal to cardano-node's.
 */
const CORPUS = process.env.NDC_UPLC_CORPUS;
const TURBO = process.env.NDC_TURBO_CORPUS;
const NDC = process.env.NDC_DIR;

describe.skipIf(!CORPUS)("uplc-conformance (pragma's corpus)", () => {
    test("no regression below 1064 / 1064 evaluation, 750 / 750 budget; the report is what the schema wants", () => {
        const corpus = loadUplcCorpus(CORPUS!);
        expect(corpus.vectors.length).toBeGreaterThanOrEqual(1064);
        expect(corpus.costModels.size).toBe(6);
        const run = buildUplcConformanceReport(corpus);
        const failing = run.verdicts.filter((s) => !s.passed).map((s) => `${s.id} @ ${s.protocol_version}: ${s.detail ?? ""}`);
        expect(failing).toEqual([]);
        expect(run.totals.evaluation.passed).toBeGreaterThanOrEqual(1064);
        expect(run.totals.budget.passed).toBeGreaterThanOrEqual(750);
        expect(run.totals.passed).toBe(run.totals.total);
        // the corpus's cost models are plutus' defaults of the semantics variants
        expect(run.cost_models.map((c) => `${c.id}:${c.default_variant}`)).toEqual(["v1-pv10:B", "v1-pv11:D", "v2-pv10:B", "v2-pv11:D", "v3-pv10:C", "v3-pv11:E"]);
        // the site's naming: path ids with the language suffix, titles as the directory names
        const ids = new Set(run.report.scenarios.map((r) => r.id));
        expect(ids.has("example_fibonacci_v3")).toBe(true);
        expect(ids.has("builtin_semantics_consbytestring_negative_wraps_v2")).toBe(true);
        expect(ids.has("builtin_parser_value_zero_asset_v3")).toBe(true);
        expect(run.report.scenarios.find((r) => r.id === "program_version_1_1_0_before_pv11_v1")?.title).toBe("1 1 0 before pv11");
        expect(run.report.scenarios.find((r) => r.id === "program_version_1_1_0_before_pv11_v1")?.evaluation).toBe("parse/decode error");
        // every success row prints a program that parses back to an α-equivalent term
        for (const r of run.report.scenarios) {
            if (!r.evaluation.startsWith("(program")) { expect(["evaluation failure", "out of budget", "parse/decode error"]).toContain(r.evaluation); expect(r.budget).toBeNull(); continue; }
            expect(r.budget).not.toBeNull();
            expect(() => parseProgram(r.evaluation)).not.toThrow();
        }
        if (NDC) {
            const schema = JSON.parse(readFileSync(join(NDC, "scenarios/uplc-conformance/schema.json"), "utf8"));
            expect(checkSchema(schema, run.report)).toEqual([]);
            // the site agrees with our verdict on every vector
            const expectations = JSON.parse(readFileSync(join(NDC, "scenarios/uplc-conformance/expectations.json"), "utf8")).scenarios;
            const site = scoreUplcConformance(run.report, expectations);
            expect(site.failures).toEqual([]);
            expect(site.passed).toBe(expectations.length);
        }
    }, 120_000);
    test("a wrong expected budget or result is reported, not hidden; a saturated budget means out of budget", () => {
        const corpus = loadUplcCorpus(CORPUS!);
        const v = corpus.vectors.find((x) => x.id === "example_fibonacci_v3" && x.pv === 11)!;
        const costs = corpus.costModels.get(v.costModelId)!;
        const ok = runUplcVector(v, costs);
        expect(ok.verdict.passed).toBe(true);
        expect(normalizeEvaluation(ok.row.evaluation)).toBe(normalizeEvaluation(v.expected)); // the printed result is the suite's text
        expect(ok.row.budget).toEqual(ok.verdict.expected.budget);
        const badBudget: UplcVector = { ...v, budget: "({cpu: 1\n| mem: 1})" };
        const r1 = runUplcVector(badBudget, costs);
        expect([r1.verdict.evaluation_passed, r1.verdict.budget_passed, r1.verdict.passed]).toEqual([true, false, false]);
        expect(r1.row).toEqual(ok.row); // the report says what was observed, whatever the expectation
        const badResult: UplcVector = { ...v, expected: "(program 1.0.0 (con integer 1))", flatExpected: undefined };
        const r2 = runUplcVector(badResult, costs);
        expect([r2.verdict.evaluation_passed, r2.verdict.passed]).toEqual([false, false]);
        expect(r2.row.evaluation).toBe(ok.row.evaluation);
        const drop = corpus.vectors.find((x) => x.id === "builtin_semantics_droplist_droplist_10_v3")!;
        expect(expectedOutcome(drop)).toEqual({ outcome: "out of budget", budget: null });
        expect(runUplcVector(drop, corpus.costModels.get(drop.costModelId)!).row.evaluation).toBe("out of budget");
    });
});

describe.skipIf(!TURBO)("uplc-turbo (pragma's corpus)", () => {
    test("3997 scripts, protocol version by epoch, every budget equal to cardano-node's (when NDC_DIR has its report)", () => {
        const files = listTurboFiles(TURBO!);
        expect(files.length).toBe(3997);
        const benches = files.map((f) => { const s = loadTurboScript(f); const b = budgetOf(s); return { ...b, bench: s.bench, protocol_version: s.pv, plutus_version: `V${s.lang}` as const, epoch: s.epoch }; });
        expect(benches.filter((b) => !b.ok)).toEqual([]);
        expect(new Set(benches.map((b) => b.protocol_version))).toEqual(new Set([8, 9]));
        const ref = NDC ? join(NDC, "_site/reports/uplc-turbo/cardano-node.json") : null;
        if (ref && existsSync(ref)) {
            const r = JSON.parse(readFileSync(ref, "utf8"));
            const rows = benches.map((b): TurboBenchmark => ({ bench: b.bench, plutus_version: b.plutus_version, protocol_version: b.protocol_version, epoch: b.epoch, budget_cpu: b.cpu, budget_mem: b.mem, ok: true, cpu_us: 0, cpu_min_us: 0, cpu_median_us: 0, cpu_max_us: 0, decode_us: 0, size_bytes: 0 }));
            const a = budgetAgreement(rows, { name: "cardano-node", benchmarks: r.benchmarks });
            expect(a.mismatches).toEqual([]);
            expect([a.agree, a.total]).toEqual([3997, 3997]);
            // the reference's protocol versions are the epoch rule's
            const theirs = new Map(r.benchmarks.map((x: any) => [x.bench, x.protocol_version]));
            expect(benches.every((b) => theirs.get(b.bench) === `${b.protocol_version}.0`)).toBe(true);
        }
    }, 120_000);
    test("timing a script: the budget of every run is the same, the report row is the best-of mean", () => {
        const s = loadTurboScript(listTurboFiles(TURBO!)[0]!);
        const { bench, samples } = benchScript(s, 6, 3);
        expect(samples.length).toBe(6);
        expect(bench.ok).toBe(true);
        expect(bench.budget_cpu).toBe(budgetOf(s).cpu);
        expect(bench.cpu_us).toBeGreaterThan(0);
        expect(bench.cpu_us).toBeLessThanOrEqual(bench.cpu_median_us + 0.11);
        const row = toReportBenchmark(bench);
        expect(row).toEqual({ bench: s.bench, plutus_version: `V${s.lang}`, protocol_version: `${s.pv}.0`, budget_cpu: bench.budget_cpu, budget_mem: bench.budget_mem, cpu_us: bench.cpu_us, mem_bytes: null });
    });
});

describe("default cost models and the epoch rule", () => {
    test("protocol version of a mainnet epoch (the uplc-turbo README)", () => {
        expect([290, 506, 507, 536, 537, 643, 644].map(pvOfEpoch)).toEqual([8, 8, 9, 9, 10, 10, 11]);
    });
    test("plutus' defaults by semantics variant: lengths, variants, and the values that tell them apart", () => {
        const fx = defaultCostModelsFixture();
        expect(fx.plutus.files.length).toBe(10);
        expect(fx.variants).toEqual({ "8": { PlutusV1: "A", PlutusV2: "A" }, "9": { PlutusV1: "B", PlutusV2: "B", PlutusV3: "C" }, "10": { PlutusV1: "B", PlutusV2: "B", PlutusV3: "C" }, "11": { PlutusV1: "D", PlutusV2: "D", PlutusV3: "E" } });
        expect([defaultCostModel(1, 8).length, defaultCostModel(2, 9).length, defaultCostModel(3, 9).length]).toEqual([332, 332, 350]);
        expect(() => defaultCostModel(3, 8)).toThrow(); // V3 exists from protocol 9
        expect(defaultCostModelVariant(2, 8)).toBe("A");
        // variant A: Vasil's addInteger (205665 / 812) and 23000-unit steps, but plutus' secp256k1 costs, not mainnet epoch 400's (35892428)
        expect(defaultCostModel(2, 8).slice(0, 2)).toEqual([205665, 812]);
        expect(defaultCostModel(2, 8)[167]).toBe(35190005); // verifyEcdsaSecp256k1Signature-cpu-arguments
        expect(defaultCostModel(1, 9).slice(0, 2)).toEqual([100788, 420]);
        expect(defaultCostModel(3, 10)[54]).toBe(549); // divideInteger c11 of variant C
        expect(defaultCostModel(3, 11)[54]).toBe(960); // and of variant E
        expect(defaultCostModel(3, 11)[319]).toBe(390841); // insertCoin-cpu-arguments-intercept (master, not 1.63's 356924)
        expect(MAINNET_TX_BUDGET).toEqual({ cpu: 10_000_000_000, mem: 14_000_000 });
    });
});

describe("uplc text printer", () => {
    const roundTrip = (src: string) => {
        const p = parseProgram(src);
        const printed = printProgram(p.version, p.term);
        expect(termEq(parseProgram(printed).term, p.term)).toBe(true);
        return printed;
    };
    test("terms: binders named by depth, binary applications, constr and case", () => {
        expect(roundTrip("(program 1.0.0 (lam x (delay (lam y (lam z [z [[(force x) y] z]])))))")).toBe("(program 1.0.0 (lam i-0 (delay (lam i-1 (lam i-2 [i-2 [[(force i-0) i-1] i-2]])))))");
        expect(roundTrip("(program 1.1.0 (constr 1 (con integer 1) (lam x x) (constr 0 (con integer 1))))")).toBe("(program 1.1.0 (constr 1 (con integer 1) (lam i-0 i-0) (constr 0 (con integer 1))))");
        expect(roundTrip("(program 1.1.0 (lam x (case x)))")).toBe("(program 1.1.0 (lam i-0 (case i-0)))");
        expect(roundTrip("(program 1.0.0 [(builtin addInteger) (con integer 1)])")).toBe("(program 1.0.0 [(builtin addInteger) (con integer 1)])");
        expect(roundTrip("(program 1.0.0 (delay (error)))")).toBe("(program 1.0.0 (delay (error)))");
    });
    test("constants: lists, pairs, arrays, data, bls points, values", () => {
        expect(roundTrip("(program 1.0.0 (con (pair integer (list data)) (1278, [B #ff31, I -7972, List [List []]])))")).toBe("(program 1.0.0 (con (pair integer (list data)) (1278, [B #ff31, I -7972, List [List []]])))");
        expect(roundTrip("(program 1.0.0 (con data (Map [(B #0123, I 12345), (List [I -12364689486], Constr 7 [])])))")).toBe("(program 1.0.0 (con data (Map [(B #0123, I 12345), (List [I -12364689486], Constr 7 [])])))");
        expect(roundTrip("(program 1.1.0 (con (array bool) [True,False,True]))")).toBe("(program 1.1.0 (con (array bool) [True, False, True]))");
        expect(roundTrip("(program 1.0.0 (con (pair integer (pair unit bool)) (12345, ((), True))))")).toBe("(program 1.0.0 (con (pair integer (pair unit bool)) (12345, ((), True))))");
        expect(roundTrip("(program 1.0.0 (con bls12_381_G1_element 0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000))"))
            .toBe("(program 1.0.0 (con bls12_381_G1_element 0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000))");
        expect(roundTrip("(program 1.0.0 (con value [(#aa, [(#aa, 5), (#bb, 10)]), (#bb, [(#, 1)])]))")).toBe("(program 1.0.0 (con value [(#aa, [(#aa, 5), (#bb, 10)]), (#bb, [(#, 1)])]))");
        expect(roundTrip("(program 1.0.0 (con bytestring #))")).toBe("(program 1.0.0 (con bytestring #))");
    });
    test("strings: Haskell escapes, characters beyond DEL as they are", () => {
        expect(quoteString("\t\"Success!\"\n")).toBe("\"\\t\\\"Success!\\\"\\n\"");
        expect(quoteString("λ-calculus ¬ € x²")).toBe("\"λ-calculus ¬ € x²\"");
        expect(quoteString("\b\n\x07\t\x7f\\\x00\x0eH\x0eX")).toBe("\"\\b\\n\\a\\t\\DEL\\\\\\NUL\\SO\\&H\\SOX\"");
        expect(roundTrip("(program 1.0.0 (con (list string) [\"\\\\\", \"\\\"\", \"\\DEL\", \"€\", \"\\SO\\&H\"]))")).toBe("(program 1.0.0 (con (list string) [\"\\\\\", \"\\\"\", \"\\DEL\", \"€\", \"\\SO\\&H\"]))");
    });
    test("normalizeEvaluation is build.py's: whitespace only, strings untouched", () => {
        expect(normalizeEvaluation("(program\n  1.0.0\n  [\n    [ (force (builtin ifThenElse)) (con string \"11 <= 22\") ]\n    (con string \"¬(11  <= 22)\")\n  ]\n)\n"))
            .toBe("(program 1.0.0 [[(force (builtin ifThenElse)) (con string \"11 <= 22\")] (con string \"¬(11  <= 22)\")])");
        expect(normalizeEvaluation("(con (list integer) [ 1 , 2 ,3 ])")).toBe("(con (list integer) [1,2,3])");
        expect(normalizeEvaluation("(con (pair integer bool) (12345, True))")).toBe("(con (pair integer bool) (12345,True))");
        expect(normalizeEvaluation("[ i-2 [ [ (force i-0) i-1 ] i-2 ] ]")).toBe(normalizeEvaluation("[i-2 [[(force i-0) i-1] i-2]]"));
    });
});

describe("site scoring (ndcScore)", () => {
    test("uplc-conformance: id + versions select the row, text up to whitespace, budget exactly where expected", () => {
        const expectations = [
            { id: "a_v3", plutus_version: "V3", protocol_version: "11.0", evaluation: "(program 1.0.0 (con integer 1))", budget: { cpu: 10, mem: 1 } },
            { id: "b_v3", plutus_version: "V3", protocol_version: "10.0", evaluation: "evaluation failure", budget: null },
            { id: "b_v3", plutus_version: "V3", protocol_version: "11.0", evaluation: "(program 1.1.0 (con unit ()))", budget: null },
            { id: "c_v3", plutus_version: "V3", protocol_version: "11.0", evaluation: "parse/decode error", budget: null },
        ];
        const report = { scenarios: [
            { id: "a_v3", plutus_version: "V3", protocol_version: "11.0", evaluation: "(program\n 1.0.0\n (con integer 1))", budget: { cpu: 10, mem: 1 } },
            { id: "b_v3", plutus_version: "V3", protocol_version: "11.0", evaluation: "(program 1.1.0 (con unit ()))", budget: { cpu: 5, mem: 5 } },
            { id: "b_v3", plutus_version: "V3", protocol_version: "10.0", evaluation: "out of budget", budget: null },
        ] };
        const s = scoreUplcConformance(report, expectations);
        expect(s.passed).toBe(2);
        expect(s.failures.map((f) => f.split(":")[0])).toEqual(["b_v3 (V3 @ 10.0)", "c_v3 (V3 @ 11.0)"]);
        expect(scoreUplcConformance({ scenarios: [{ ...report.scenarios[0], budget: { cpu: 11, mem: 1 } }] }, expectations.slice(0, 1)).passed).toBe(0);
    });
    test("ledger-rules: the fixture's expectation is the result the site wants", () => {
        expect(ledgerExpectedResult(undefined)).toBe("pass");
        expect(ledgerExpectedResult("Pass")).toBe("pass");
        expect(ledgerExpectedResult({ decoding_failure: true })).toBe("DecodingFailure");
        expect(ledgerExpectedResult({ predicate: "BadInputsUTxO", description: "x" })).toBe("BadInputsUTxO");
        const defs = [{ id: "00001", expected: "pass" }, { id: "00002", expected: "BadInputsUTxO" }, { id: "00003", expected: "pass" }];
        const s = scoreLedgerRules({ scenarios: [{ id: "00001", result: "pass" }, { id: "00002", result: "BadInputsUTxO" }, { id: "00099", result: "pass" }] }, defs);
        expect([s.passed, s.total]).toEqual([2, 3]);
        expect(s.failures).toEqual(["00003: expected pass, report says nothing"]);
    });
    test("uplc-turbo: 2× the budget or 200 µs of tolerance on cpu, memory only when reported, missing fails", () => {
        const row = (cpu_us: number, budget_cpu: number, mem_bytes: number | null = null, budget_mem = 1000) => ({ bench: "x", plutus_version: "V1", protocol_version: "8.0", budget_cpu, budget_mem, cpu_us, mem_bytes });
        expect(turboMeasurements(row(2000, 1_000_000_000)).pass).toBe(true); // budget 1000 µs, delta 1.0
        expect(turboMeasurements(row(2001, 1_000_000_000)).pass).toBe(false);
        expect(turboMeasurements(row(250, 50_000_000)).pass).toBe(true); // 50 µs budget, within 200 µs
        expect(turboMeasurements(row(251, 50_000_000)).pass).toBe(false);
        expect(turboMeasurements(row(100, 1_000_000_000, 2001 * 1024, 1000 * 1024)).pass).toBe(false);
        expect(turboMeasurements(row(100, 1_000_000_000, 1000 * 1024 + 320 * 1024, 1000 * 1024)).pass).toBe(true);
        expect(turboMeasurements({ ...row(100, 1_000_000_000), budget_cpu: null }).pass).toBe(false); // no budget: nothing to pass
        const s = scoreUplcTurbo({ benchmarks: [row(100, 1_000_000_000)] }, ["x", "y"]);
        expect([s.passed, s.total, s.failures]).toEqual([1, 2, ["y: missing"]]);
    });
});

describe("report helpers", () => {
    test("schema checker: types, required, additionalProperties at any level, $ref, oneOf of consts, enum, pattern, minimum", () => {
        const schema = {
            type: "object", required: ["a", "b"],
            properties: {
                a: { const: "1" }, b: { type: "array", items: { $ref: "#/$defs/x" } },
                t: { oneOf: [{ type: "string", format: "date-time" }, { type: "integer", minimum: 0 }] },
                r: { oneOf: [{ const: "pass" }, { const: "BadInputsUTxO" }] },
                id: { type: "string", pattern: "^[0-9]{5}$" },
                i: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
            },
            $defs: { x: { type: "object", required: ["g"], properties: { g: { enum: ["V1", "V2"] }, m: { type: ["number", "null"], minimum: 0 } }, additionalProperties: false } },
        };
        expect(checkSchema(schema, { a: "1", b: [{ g: "V1", m: null }], t: "2026-10-15T00:00:00+00:00", r: "pass", id: "00042", i: { name: "gerolamo" } })).toEqual([]);
        expect(checkSchema(schema, { a: "1", b: [{ g: "V1" }], t: 5, extra: true })).toEqual([]);
        const errs = checkSchema(schema, { a: "2", b: [{ g: "V4", m: -1, z: 1 }], t: "yesterday", r: "Unnamed", id: "42", i: { name: "x", commit: "y" } });
        expect(errs).toEqual([
            "$.a: expected \"1\", got \"2\"",
            "$.b[0].g: \"V4\" is not one of the 2 enumerated values [\"V1\",\"V2\"]",
            "$.b[0].m: -1 < minimum 0",
            "$.b[0]: unexpected property z",
            "$.t: matches 0 of the oneOf alternatives",
            "$.r: \"Unnamed\" is not one of the 2 allowed constants",
            "$.id: \"42\" does not match /^[0-9]{5}$/",
            "$.i: unexpected property commit",
        ]);
        expect(checkSchema(schema, { a: "1" })).toEqual(["$: missing b"]);
    });
    test("turbo: best-of mean, percentiles, the report row, the site's rule on it, budget agreement", () => {
        expect(bestMean([5, 1, 4, 2, 3], 3)).toBe(2);
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
        const b = (cpu_us: number, budget_cpu: number): TurboBenchmark => ({ bench: "x", plutus_version: "V2", protocol_version: 8, epoch: 400, budget_cpu, budget_mem: 100, ok: true, cpu_us, cpu_min_us: cpu_us, cpu_median_us: cpu_us, cpu_max_us: cpu_us, decode_us: 10, size_bytes: 1 });
        const row = toReportBenchmark(b(333.3, 300_000_000));
        expect(row).toEqual({ bench: "x", plutus_version: "V2", protocol_version: "8.0", budget_cpu: 300_000_000, budget_mem: 100, cpu_us: 333.3, mem_bytes: null });
        expect(sitePasses(row)).toBe(true); // 333 µs vs 300 µs
        expect(sitePasses(toReportBenchmark(b(900, 300_000_000)))).toBe(false); // 900 µs vs 300 µs: delta 2
        const a = budgetAgreement([b(1, 10), { ...b(1, 20), bench: "y" }, { ...b(1, 30), bench: "z" }], { name: "ref", benchmarks: [{ bench: "x", budget_cpu: 10, budget_mem: 100 }, { bench: "y", budget_cpu: 21, budget_mem: 100 }] });
        expect([a.agree, a.total, a.mismatches.map((m) => m.bench)]).toEqual([1, 2, ["y"]]);
        const m = machineInfo();
        expect(m.logical_cores).toBeGreaterThan(0);
        expect(typeof m.os).toBe("string");
    });
    test("the other nodes' preview reports are schema-valid under this checker (when NDC_DIR is set)", () => {
        if (!NDC) return;
        for (const s of ["cbor-decoding", "ledger-rules", "uplc-conformance", "uplc-turbo"]) {
            const schema = JSON.parse(readFileSync(join(NDC, `scenarios/${s}/schema.json`), "utf8"));
            for (const node of ["amaru", "cardano-node"]) {
                const plain = join(NDC, `scenarios/${s}/preview/${node}.json`);
                if (!existsSync(plain)) continue; // compressed previews need zstd; the cbor ones are plain
                if (s === "cbor-decoding" && node === "cardano-node") continue; // lacks generated_at; the site does not validate reports against the schema
                const report = JSON.parse(readFileSync(plain, "utf8"));
                // build_common.py `parse_report` completes a legacy CBOR report (no `version`) before validating it
                if (s === "cbor-decoding" && !("version" in report)) Object.assign(report, { version: "1", scenario: s, generated_at: "2026-10-18T00:00:00+00:00" });
                expect(checkSchema(schema, report)).toEqual([]);
            }
        }
    });
});
