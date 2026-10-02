#!/usr/bin/env bun
/**
 * Differential fuzzing of the batch-6 Value builtins and BLS12-381 multi-scalar multiplication:
 * random programs evaluated by Gerolamo's evaluator (src/consensus/plutus/cek.ts, Plutus V3 at
 * protocol 11) and by a reference — aiken's `uplc` ≥ 1.1.24 (the first release with batch 6)
 * through an `eval-text <file> v3 <costs.json> 11` command printing `ok cpu C mem M result T` or
 * `error cpu C mem M : …` (tools/uplc-ref's format) — comparing verdicts, results and budgets.
 *
 *   bun scripts/plutus-batch6-diff.ts <ref binary> <costs.json> [count=500] [seed=1]
 *
 * costs.json: `cardano-cli conway query protocol-parameters` output or `{"PlutusV3": […]}`.
 * tools/uplc-ref vendors uplc 1.1.21 (no batch 6). A reference: a cargo binary on `uplc = "=1.1.24"`
 * that parses the file (`uplc::parser::program`), converts it to NamedDeBruijn and runs
 * `Machine::new_with_protocol(lang, 11, initialize_cost_model_with_protocol(lang, 11, costs), …)`;
 * 1.1.24 declares rustc 1.94.1 but builds with 1.89 under `cargo build --release --ignore-rust-version`.
 * The variant-D/E argument bounds (65536-byte bytestrings, 2^262143 integers) are not exercised:
 * aiken 1.1.24 does not implement them (plutus-core 1.63 does; batch6.test.ts covers them).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/consensus/plutus/cek";
import { costTable } from "../src/consensus/plutus/costs";
import { discharge, parseProgram, termEq } from "../src/consensus/plutus/uplcText";

const [ref, costsPath, countArg = "500", seedArg = "1"] = process.argv.slice(2);
if (!ref || !costsPath) { console.error("usage: plutus-batch6-diff.ts <ref binary> <costs.json> [count] [seed]"); process.exit(2); }
const cj = JSON.parse(readFileSync(costsPath, "utf8"));
const v3: number[] = cj.costModels?.PlutusV3 ?? cj.PlutusV3;
const costs = costTable(3, v3, 11);
const dir = mkdtempSync(join(tmpdir(), "b6diff-"));

let seed = Number(seedArg) >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32; };
const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)]!;
const int = (n: number) => Math.floor(rnd() * n);
const Q_MAX = (1n << 127n) - 1n;
const key = () => "#" + Array.from({ length: pick([0, 1, 1, 2, 3, 28, 32]) }, () => pick(["00", "01", "aa", "ff"])).join("");
const quantity = (): bigint => pick([() => BigInt(int(10) - 3), () => BigInt(int(1e9)) * (rnd() < 0.5 ? -1n : 1n), () => Q_MAX - BigInt(int(3)), () => -Q_MAX - 1n + BigInt(int(3)), () => 1n])();
/** A canonical value literal (unique ascending keys, no zero): the text parsers' normalisation is not under test. */
const value = (pos = false): string => {
    const outer = new Map<string, Map<string, bigint>>();
    for (let i = pick([0, 1, 2, 3, 5, 12]); i > 0; i--) {
        const c = key(), inner = outer.get(c) ?? new Map<string, bigint>();
        outer.set(c, inner);
        for (let m = pick([1, 1, 2, 4, 9]); m > 0; m--) { let q = quantity(); if (pos && q < 0n) q = -q - 1n; if (q === 0n) q = 1n; inner.set(key(), q); }
    }
    const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a.slice(1), "hex"), Buffer.from(b.slice(1), "hex"));
    const es = [...outer].sort((a, b) => cmp(a[0], b[0])).map(([c, ts]) => `(${c}, [${[...ts].sort((a, b) => cmp(a[0], b[0])).map(([t, q]) => `(${t}, ${q})`).join(", ")}])`);
    return `(con value [${es.join(", ")}])`;
};
const P = ["#97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb", "#c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"];
const scalar = () => pick([() => BigInt(int(100) - 50), () => (1n << 255n) + BigInt(int(9)), () => -(1n << 4095n), () => (1n << 4095n) - 1n, () => 0n])();
/** insertCoin chains (deletes included) feeding a cost- or sign-sensitive builtin: the cached sizes after each step. */
const chain = (): string => {
    let v = value();
    for (let n = 1 + int(6); n > 0; n--) v = `[(builtin insertCoin) (con bytestring ${key()}) (con bytestring ${key()}) (con integer ${pick([0n, 0n, quantity(), BigInt(int(5) + 1)])}) ${v}]`;
    return pick([
        () => `[(builtin lookupCoin) (con bytestring ${key()}) (con bytestring ${key()}) ${v}]`,
        () => `[(builtin insertCoin) (con bytestring ${key()}) (con bytestring ${key()}) (con integer 1) ${v}]`,
        () => `[(builtin valueContains) ${v} ${value(true)}]`,
        () => `[(builtin unionValue) ${v} ${value()}]`,
        () => `[(builtin valueData) [(builtin scaleValue) (con integer -1) ${v}]]`,
    ])();
};
const programs: Array<() => string> = [
    chain, chain,
    () => `[(builtin insertCoin) (con bytestring ${key()}) (con bytestring ${key()}) (con integer ${pick([0n, quantity()])}) ${value()}]`,
    () => `[(builtin lookupCoin) (con bytestring ${key()}) (con bytestring ${key()}) ${value()}]`,
    () => `[(builtin unionValue) ${value()} ${value()}]`,
    () => `[(builtin valueContains) ${value(rnd() < 0.85)} ${value(rnd() < 0.85)}]`,
    () => `[(builtin valueData) ${value()}]`,
    () => `[(builtin unValueData) [(builtin valueData) ${value()}]]`,
    () => `[(builtin scaleValue) (con integer ${pick([0n, 1n, -1n, BigInt(int(1000)) - 500n, 1n << 100n])}) ${value()}]`,
    () => {
        const n = int(4), m = int(4);
        const pts = Array.from({ length: m }, () => pick(P));
        const list = pts.reduceRight((acc, p) => `[(force (builtin mkCons)) [(builtin bls12_381_G1_uncompress) (con bytestring ${p})] ${acc}]`, "(con (list bls12_381_G1_element) [])");
        return `[(builtin bls12_381_G1_compress) [(builtin bls12_381_G1_multiScalarMul) (con (list integer) [${Array.from({ length: n }, scalar).join(", ")}]) ${list}]]`;
    },
];

const count = Number(countArg);
let same = 0, diff = 0, failures = 0;
for (let i = 0; i < count; i++) {
    const body = pick(programs)();
    const src = `(program 1.1.0 ${body})`;
    const f = join(dir, `p${i}.uplc`);
    writeFileSync(f, src);
    const out = Bun.spawnSync([ref, "eval-text", f, "v3", costsPath, "11"]).stdout.toString().trim();
    const m = /^(ok|error) cpu (\d+) mem (\d+)(?: result (.*)|.*)$/s.exec(out);
    let ours;
    try { ours = evaluate(parseProgram(src).term, costs, { cpu: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER }, { pv: 11 }); }
    catch (e) { console.log(`PARSE ${i}: ${(e as Error).message}\n  ${src}`); diff++; continue; }
    if (!m) { console.log(`REF? ${i}: ${out}\n  ${src}`); diff++; continue; }
    const refOk = m[1] === "ok";
    if (!refOk) failures++;
    let agree = refOk === ours.ok;
    if (agree && refOk) {
        agree = Number(m[2]) === ours.cpu && Number(m[3]) === ours.mem;
        try { agree &&= termEq(discharge(ours.result!), parseProgram(`(program 1.1.0 ${m[4]})`).term); }
        catch (e) { agree = false; console.log(`  (reference result not parsed: ${(e as Error).message})`); }
    }
    if (agree) same++;
    else { diff++; console.log(`DIFF ${i}: ref ${out.slice(0, 300)}\n  ours ${ours.ok ? "ok" : "error"} cpu ${ours.cpu} mem ${ours.mem} ${ours.error ?? ""}\n  ${src.slice(0, 600)}`); }
}
console.log(`${count} programs (${failures} evaluation failures): ${same} agree, ${diff} differ`);
process.exit(diff ? 1 : 0);
