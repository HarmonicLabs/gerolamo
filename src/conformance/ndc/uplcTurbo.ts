/**
 * node-diversity-conformance scenario `uplc-turbo` (non-functional): pragma's corpus
 * (`turbo.tar.zst`: 3 997 fully applied mainnet scripts as `<dir>/<epoch>/<tx>-<redeemer>-<script
 * hash>-v<lang>.flat`, each a CBOR bytestring holding a flat program) timed through Gerolamo's
 * CEK machine (src/consensus/plutus, phase 2's evaluator). Each script runs as its language at the
 * protocol version of its epoch (the README's table, `pvOfEpoch`), under that language's default
 * cost model at that protocol version (plutus' `defaultCostModelParamsForVariant`,
 * src/consensus/__fixtures__/plutus-default-cost-models.json — the lists that reproduce
 * cardano-node's budgets) and within mainnet's transaction budget (`MAINNET_TX_BUDGET`; see
 * uplcCommon.ts about the README's "10M mem").
 *
 * Timing, as the README asks: the CBOR unwrap and the flat decode (flat.ts, into the machine's
 * typed-array program) happen once per script before anything is timed; then one unmeasured
 * evaluation and `runs` (50) timed evaluations of the machine alone (`Bun.nanoseconds()` around
 * `evaluate`); `cpu_us` is the mean of the best `best` (30) of them in microseconds. Before the
 * first script an unmeasured JIT warm-up repeats passes over a small set (the first 64 scripts plus
 * the first 8 of each language) until `warmupPasses` (default 3) passes ran and `warmupMs` (default
 * 3 000) elapsed, so the machine is not cold; then, per script, `warmupRuns` (default 1) unmeasured
 * evaluations precede the timed ones. The alternatives were measured and kept as options
 * (docs/parity/ndc-uplc.md): passes over the whole corpus (`warmupScope: "corpus"`) specialise the
 * JIT on the 3 987 V1 / V2 scripts and leave the 10 V3 ones paying deoptimisation exits (the more
 * corpus-wide warm-up, the slower they got), and a thousand unmeasured evaluations per script
 * (`warmupRuns`) take ten times longer without reaching, inside a run over the whole corpus, the
 * steady state the same script shows in isolation. Whatever the warm-up, three to five scripts
 * near the 2× line move across it between runs: JIT state, not evaluator speed. Nothing is forced
 * between runs (a forced GC before a run makes that run slower; the collector's own eden
 * collections are what the best-30 statistic filters out). `budget_cpu` / `budget_mem` are the
 * units the machine counted (identical across runs; null if a script fails). `mem_bytes` is null:
 * a garbage-collected runtime has no evaluation arena to measure and the schema allows null (the
 * site then judges the CPU dimension only).
 *
 * The report (schema 8974561) carries `machine` and the benchmarks; everything else measured —
 * the decode time, min / median / max, the per-group summary, the worst CPU deviations, the
 * budget agreement with a reference report (cardano-node's: the budgets must agree with the
 * majority of nodes, cardano-node breaking ties) and the setup text with the process's CPU
 * affinity — stays in the run (report-all.ts puts it in manifest.json).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { evaluate } from "../../consensus/plutus/cek";
import { parseCbor } from "../../consensus/plutus/cbor";
import { costTable, type CostTable } from "../../consensus/plutus/costs";
import { decodeProgram, type Program } from "../../consensus/plutus/flat";
import { turboMeasurements } from "./ndcScore";
import { MAINNET_TX_BUDGET, defaultCostModel, defaultCostModelVariant, implementation, pvOfEpoch, type Implementation } from "./uplcCommon";

export const TURBO_RUNS = 50, TURBO_BEST = 30;
export const TURBO_BUDGET = MAINNET_TX_BUDGET;
type V = "V1" | "V2" | "V3";

/** `bytes`: the file (a CBOR bytestring); `flat`: the program inside it, unwrapped at load time. */
export interface TurboScript { bench: string; path: string; epoch: number; pv: number; lang: 1 | 2 | 3; bytes: Uint8Array; flat: Uint8Array }

/** Every `<epoch>/*.flat` under `dir`, epochs ascending then names (the corpus order). */
export function listTurboFiles(dir: string): string[] {
    const out: string[] = [];
    const epochs = readdirSync(dir).filter((e) => /^\d+$/.test(e) && statSync(join(dir, e)).isDirectory()).sort((a, b) => Number(a) - Number(b));
    for (const e of epochs) for (const f of readdirSync(join(dir, e)).sort()) if (f.endsWith(".flat")) out.push(join(dir, e, f));
    if (out.length === 0) throw new Error(`${dir}: no <epoch>/*.flat files (an unpacked turbo.tar.zst)`);
    return out;
}

/** Corpus subset for quick runs: every `stride`-th file, then the first `limit`; no option = everything. */
export function selectTurboFiles(files: string[], sel: { stride?: number; limit?: number }): string[] {
    let out = sel.stride !== undefined && sel.stride > 1 ? files.filter((_, i) => i % sel.stride! === 0) : files;
    if (sel.limit !== undefined) out = out.slice(0, sel.limit);
    return out;
}

export function loadTurboScript(path: string): TurboScript {
    const name = basename(path), epoch = Number(basename(dirname(path)));
    const m = /-v([123])\.flat$/.exec(name);
    if (!m) throw new Error(`${name}: cannot tell the Plutus version from the file name`);
    if (!Number.isInteger(epoch)) throw new Error(`${path}: the parent directory must be the epoch`);
    const bytes = new Uint8Array(readFileSync(path));
    return { bench: name, path, epoch, pv: pvOfEpoch(epoch), lang: Number(m[1]) as 1 | 2 | 3, bytes, flat: unwrap(bytes) };
}

/** The flat bytes inside the CBOR bytestring. */
export function unwrap(b: Uint8Array): Uint8Array {
    const n = parseCbor(b);
    if (n.t !== "b") throw new Error("not a CBOR bytestring");
    return n.v;
}

const tables = new Map<string, CostTable>();
/** The default cost table of a script's language at its protocol version. */
export function turboCostTable(lang: 1 | 2 | 3, pv: number): CostTable {
    const k = `${lang}:${pv}`;
    let t = tables.get(k);
    if (!t) tables.set(k, (t = costTable(lang, defaultCostModel(lang, pv), pv)));
    return t;
}

/** One evaluation: the counted budget (what the report's `budget_*` carry) and whether the script succeeds. */
export function budgetOf(s: TurboScript): { ok: boolean; cpu: number; mem: number; error?: string } {
    const r = evaluate(decodeProgram(s.flat, s.lang, s.pv), turboCostTable(s.lang, s.pv), TURBO_BUDGET, { pv: s.pv });
    return r.ok ? { ok: true, cpu: r.cpu, mem: r.mem } : { ok: false, cpu: r.cpu, mem: r.mem, error: r.error };
}

/** One script's measurements (the run's view; `toReportBenchmark` is the schema's). */
export interface TurboBenchmark {
    bench: string; plutus_version: V; protocol_version: number; epoch: number;
    budget_cpu: number | null; budget_mem: number | null; ok: boolean; error?: string;
    /** mean of the best `best` of `runs` pure evaluations, µs */
    cpu_us: number;
    cpu_min_us: number; cpu_median_us: number; cpu_max_us: number;
    /** the one flat decode before timing, µs */
    decode_us: number;
    size_bytes: number;
}

/** scenarios/uplc-turbo/schema.json `$defs/benchmark`. */
export interface TurboReportBenchmark {
    bench: string; plutus_version: V; protocol_version: string;
    budget_cpu: number | null; budget_mem: number | null;
    /** Mean pure CEK evaluation time in microseconds. */
    cpu_us: number;
    mem_bytes: number | null;
}
/** scenarios/uplc-turbo/schema.json `$defs/machine`. */
export interface TurboMachine { os: string; os_version: string | null; architecture: string; cpu: string | null; logical_cores: number; memory_bytes: number | null }
/** scenarios/uplc-turbo/schema.json: nothing beyond these keys is allowed. */
export interface UplcTurboReport {
    version: "1"; scenario: "uplc-turbo"; generated_at: string;
    implementation: { name: string; language: string };
    machine: TurboMachine;
    benchmarks: TurboReportBenchmark[];
}

const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sorted = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b);
export const median = (xs: ReadonlyArray<number>) => { const s = sorted(xs), n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) >> 1]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
/** The site's percentile style: the element at ⌊q·n⌋ of the sorted sample. */
export const percentile = (xs: ReadonlyArray<number>, q: number) => { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN; };
const round1 = (x: number) => Math.round(x * 10) / 10;
/** The mean of the smallest `best` of `samples` (README: evaluate 50 times, take the best 30). */
export function bestMean(samples: ReadonlyArray<number>, best: number): number { return mean(sorted(samples).slice(0, Math.min(best, samples.length))); }

/**
 * Time one script: decode once (not timed for the report; `decode_us` records it), `warmupRuns`
 * unmeasured evaluations, then `runs` timed evaluations of the machine alone; `cpu_us` = mean of
 * the best `best`.
 */
export function benchScript(s: TurboScript, runs = TURBO_RUNS, best = TURBO_BEST, warmupRuns = 1): { bench: TurboBenchmark; samples: number[] } {
    const costs = turboCostTable(s.lang, s.pv), pv = s.pv;
    const d0 = Bun.nanoseconds();
    const program: Program = decodeProgram(s.flat, s.lang, pv);
    const decodeNs = Bun.nanoseconds() - d0;
    const first = evaluate(program, costs, TURBO_BUDGET, { pv });
    for (let i = 1; i < warmupRuns; i++) evaluate(program, costs, TURBO_BUDGET, { pv });
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
        const t0 = Bun.nanoseconds();
        const r = evaluate(program, costs, TURBO_BUDGET, { pv });
        const t1 = Bun.nanoseconds();
        samples.push((t1 - t0) / 1000);
        if (r.cpu !== first.cpu || r.mem !== first.mem || r.ok !== first.ok) throw new Error(`${s.bench}: run ${i} counted ${r.cpu}/${r.mem}, the first ${first.cpu}/${first.mem}`);
    }
    const bench: TurboBenchmark = {
        bench: s.bench, plutus_version: `V${s.lang}` as V, protocol_version: pv, epoch: s.epoch,
        budget_cpu: first.ok ? first.cpu : null, budget_mem: first.ok ? first.mem : null, ok: first.ok,
        cpu_us: round1(bestMean(samples, best)), cpu_min_us: round1(Math.min(...samples)), cpu_median_us: round1(median(samples)), cpu_max_us: round1(Math.max(...samples)),
        decode_us: round1(decodeNs / 1000), size_bytes: s.flat.length,
    };
    if (!first.ok) bench.error = first.error;
    return { bench, samples };
}

/** The schema's row: the pure evaluation mean in µs, the budget the machine counted, memory not measured. */
export function toReportBenchmark(b: TurboBenchmark): TurboReportBenchmark {
    return { bench: b.bench, plutus_version: b.plutus_version, protocol_version: `${b.protocol_version}.0`, budget_cpu: b.budget_cpu, budget_mem: b.budget_mem, cpu_us: b.cpu_us, mem_bytes: null };
}
/** The site's rule on the report's row (scenarios/uplc-turbo/build.py, without the cross-node budget check). */
export function sitePasses(b: TurboReportBenchmark): boolean { return turboMeasurements(b).pass; }

export const WARMUP_SET = 64, WARMUP_PER_LANG = 8, DEFAULT_WARMUP_PASSES = 3, DEFAULT_WARMUP_MS = 3000, DEFAULT_WARMUP_RUNS = 1;

/** The warm-up set: the first `WARMUP_SET` scripts and the first `WARMUP_PER_LANG` of each language (so no language's first timed script runs cold). */
export function warmupSet(scripts: TurboScript[]): TurboScript[] {
    const set = scripts.slice(0, WARMUP_SET), seen = new Set(set);
    for (const lang of [1, 2, 3] as const) for (const s of scripts.filter((x) => x.lang === lang).slice(0, WARMUP_PER_LANG)) if (!seen.has(s)) { set.push(s); seen.add(s); }
    return set;
}

/** The process's CPU affinity (`taskset`), for the setup text; null when unknown. */
export function cpuAffinity(): string | null {
    try { const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync("/proc/self/status", "utf8")); return m ? m[1]! : null; } catch { return null; }
}

/** The schema's `machine` block from node:os (architecture in uname spelling, as the other nodes report it). */
export function machineInfo(): TurboMachine {
    const arch: Record<string, string> = { x64: "x86_64", arm64: "aarch64", ia32: "i686" };
    const cpus = os.cpus();
    return {
        os: os.type(), os_version: os.release() || null, architecture: arch[os.arch()] ?? os.arch(),
        cpu: cpus[0]?.model?.trim() || null, logical_cores: Math.max(1, cpus.length), memory_bytes: os.totalmem(),
    };
}

/** A reference report (another node's `uplc-turbo` report) to compare budgets with. */
export interface TurboReference { name: string; benchmarks: Array<{ bench: string; budget_cpu: number | null; budget_mem: number | null; cpu_us?: number }> }
export interface TurboBudgetAgreement { reference: string; agree: number; total: number; mismatches: Array<{ bench: string; protocol_version: number; plutus_version: V; ours: [number | null, number | null]; theirs: [number | null, number | null] }> }
/** Budget agreement with a reference report over the measured scripts (missing from the reference: not counted). */
export function budgetAgreement(benchmarks: TurboBenchmark[], ref: TurboReference): TurboBudgetAgreement {
    const theirs = new Map(ref.benchmarks.map((b) => [b.bench, b]));
    const out: TurboBudgetAgreement = { reference: ref.name, agree: 0, total: 0, mismatches: [] };
    for (const b of benchmarks) {
        const t = theirs.get(b.bench); if (!t) continue;
        out.total++;
        if (t.budget_cpu === b.budget_cpu && t.budget_mem === b.budget_mem) out.agree++;
        else out.mismatches.push({ bench: b.bench, protocol_version: b.protocol_version, plutus_version: b.plutus_version, ours: [b.budget_cpu, b.budget_mem], theirs: [t.budget_cpu, t.budget_mem] });
    }
    return out;
}

/**
 * `warmupPass: false` skips the JIT warm-up (tests); `warmupScope` what it runs over (the small `warmupSet`, the
 * default, or the whole corpus); `warmupPasses` / `warmupMs` its extent (passes until both are reached: default 3
 * passes and 3000 ms); `warmupRuns` the unmeasured evaluations of each script before its timed ones (default 1).
 * `corpusBenchIds`: the scenario's corpus (the schema's `bench` enumeration); a measured script outside it cannot
 * be in a valid report and is returned as `excluded` instead (with its measurements), never dropped silently.
 * `reference`: another node's report whose budgets ours are compared with.
 */
export interface TurboReportOptions {
    runs?: number; best?: number; warmupPass?: boolean; warmupScope?: "set" | "corpus"; warmupPasses?: number; warmupMs?: number; warmupRuns?: number;
    corpusDigest?: string; selection?: string; now?: Date;
    corpusBenchIds?: ReadonlySet<string>;
    reference?: TurboReference;
    onProgress?: (done: number, total: number) => void;
}

export interface TurboSummaryRow {
    group: string; plutus_version: V; protocol_version: number; cost_model_variant: string;
    scripts: number; site_passed: number; failed_to_evaluate: number;
    cpu_us_mean: number; cpu_us_median: number; cpu_us_p90: number; cpu_us_max: number;
    /** median of the site's cpu_delta over the scripts it is defined for (not within 200 µs of the budget) */
    cpu_delta_median: number | null;
}
/** The report plus everything measured that the schema no longer lets it carry (report-all.ts puts it in manifest.json). */
export interface UplcTurboRun {
    report: UplcTurboReport;
    implementation: Implementation;
    corpus: string; corpus_digest?: string; corpus_selection?: string;
    setup: Record<string, unknown>;
    summary: TurboSummaryRow[];
    benchmarks: TurboBenchmark[];
    worst_cases: TurboBenchmark[];
    budget_agreement?: TurboBudgetAgreement;
    /** Measured scripts that are not in the scenario's corpus (`corpusBenchIds`), kept out of the report. */
    excluded: TurboReportBenchmark[];
}

export function buildUplcTurboReport(paths: string[], opts: TurboReportOptions = {}): UplcTurboRun {
    const runs = opts.runs ?? TURBO_RUNS, best = opts.best ?? TURBO_BEST, warmupRuns = opts.warmupRuns ?? DEFAULT_WARMUP_RUNS;
    const scripts = paths.map(loadTurboScript);
    const warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS, minPasses = opts.warmupPasses ?? DEFAULT_WARMUP_PASSES;
    const scope = opts.warmupScope ?? "set";
    let warmupPasses = 0, warmupTookMs = 0, warmupSize = 0;
    if (opts.warmupPass !== false) {
        const programs = (scope === "corpus" ? scripts : warmupSet(scripts)).map((s) => ({ p: decodeProgram(s.flat, s.lang, s.pv), costs: turboCostTable(s.lang, s.pv), pv: s.pv }));
        warmupSize = programs.length;
        const t0 = performance.now();
        for (; warmupPasses < minPasses || performance.now() - t0 < warmupMs; warmupPasses++) for (const x of programs) evaluate(x.p, x.costs, TURBO_BUDGET, { pv: x.pv });
        warmupTookMs = performance.now() - t0;
    }
    const affinity = cpuAffinity();
    const benchmarks: TurboBenchmark[] = [];
    scripts.forEach((s, i) => {
        benchmarks.push(benchScript(s, runs, best, warmupRuns).bench);
        opts.onProgress?.(i + 1, scripts.length);
    });
    const rows = benchmarks.map(toReportBenchmark);
    const inCorpus = (r: TurboReportBenchmark) => !opts.corpusBenchIds || opts.corpusBenchIds.has(r.bench);
    const delta = (b: TurboBenchmark) => turboMeasurements(toReportBenchmark(b)).cpu_delta;
    const worst = benchmarks.filter((b) => delta(b) !== null && !(Math.abs(b.cpu_us - (b.budget_cpu ?? 0) / 1e6) <= 200)).sort((a, b) => delta(b)! - delta(a)! || (a.bench < b.bench ? -1 : 1)).slice(0, 10);
    const groups = new Map<string, TurboBenchmark[]>();
    for (const b of benchmarks) { const k = `${b.plutus_version}@${b.protocol_version}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(b); }
    const summary: TurboSummaryRow[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, bs]) => {
        const us = bs.map((b) => b.cpu_us);
        const deltas = bs.map((b) => { const m = turboMeasurements(toReportBenchmark(b)); return m.cpu_delta !== null && !(Math.abs(b.cpu_us - (b.budget_cpu ?? 0) / 1e6) <= 200) ? m.cpu_delta : null; }).filter((x): x is number => x !== null);
        const lang = Number(bs[0]!.plutus_version.slice(1)) as 1 | 2 | 3;
        return {
            group, plutus_version: bs[0]!.plutus_version, protocol_version: bs[0]!.protocol_version, cost_model_variant: defaultCostModelVariant(lang, bs[0]!.protocol_version),
            scripts: bs.length, site_passed: bs.filter((b) => sitePasses(toReportBenchmark(b))).length, failed_to_evaluate: bs.filter((b) => !b.ok).length,
            cpu_us_mean: round1(mean(us)), cpu_us_median: round1(median(us)), cpu_us_p90: round1(percentile(us, 0.9)), cpu_us_max: round1(Math.max(...us)),
            cpu_delta_median: deltas.length ? Math.round(median(deltas) * 1000) / 1000 : null,
        };
    });
    const variants = [...groups.keys()].sort().map((k) => { const [v, pv] = k.split("@"); return `${v} at protocol ${pv}: variant ${defaultCostModelVariant(Number(v!.slice(1)) as 1 | 2 | 3, Number(pv))}`; });
    const run: UplcTurboRun = {
        report: {
            version: "1", scenario: "uplc-turbo", generated_at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
            implementation: { name: "gerolamo", language: "TypeScript" },
            machine: machineInfo(),
            benchmarks: rows.filter(inCorpus),
        },
        implementation: implementation(),
        corpus: "node-diversity-conformance turbo.tar.zst",
        ...(opts.corpusDigest ? { corpus_digest: opts.corpusDigest } : {}),
        ...(opts.selection ? { corpus_selection: opts.selection } : {}),
        setup: {
            runs, best, warmup_scope: scope, warmup_passes: warmupPasses, warmup_scripts: warmupSize, warmup_runs: warmupRuns,
            runtime: `bun ${Bun.version}`, platform: `${process.platform} ${process.arch}`,
            measurement: `Per script the CBOR unwrap and the flat decode (into the machine's typed-array program, constants included) happen once before timing; then ${warmupRuns} unmeasured evaluation(s) and ${runs} timed evaluations of the CEK machine alone (Bun.nanoseconds); cpu_us is the mean of the best ${best}. Unmeasured JIT warm-up first: ${warmupPasses} passes over ${warmupSize} scripts (${scope === "corpus" ? "the whole corpus" : `the first ${WARMUP_SET} plus the first ${WARMUP_PER_LANG} of each language`}; ${warmupPasses * warmupSize} evaluations, ${(warmupTookMs / 1000).toFixed(1)} s; at least ${minPasses} passes and ${warmupMs} ms). Single thread${affinity ? `, process CPU affinity ${affinity}` : ""}; nothing forced between runs. bun ${Bun.version} (JavaScriptCore JIT)`,
            protocol_version: "from the script's epoch directory: 644 → 11, 537 → 10, 507 → 9, before that 8 (the scenario README)",
            cost_model: `plutus' default cost model of the language's semantics variant at the epoch's protocol version (defaultCostModelParamsForVariant; src/consensus/__fixtures__/plutus-default-cost-models.json): ${variants.join("; ")}`,
            budget_limit: `${TURBO_BUDGET.cpu} cpu / ${TURBO_BUDGET.mem} mem (mainnet maxTxExecutionUnits; the README's 10M mem would fail five scripts whose reference budgets exceed it)`,
            deviation_units: "CPU: 1 unit = 1 picosecond; memory: 1 unit = 1 byte",
            memory_measurement: "Not measured: a garbage-collected runtime has no evaluation arena, so mem_bytes is null and the site judges the CPU dimension only",
        },
        summary,
        benchmarks,
        worst_cases: worst,
        ...(opts.reference ? { budget_agreement: budgetAgreement(benchmarks, opts.reference) } : {}),
        excluded: rows.filter((r) => !inCorpus(r)),
    };
    return run;
}
