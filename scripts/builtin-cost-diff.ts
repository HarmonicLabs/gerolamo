#!/usr/bin/env bun
/**
 * Differential costing of every Plutus builtin: one small program per builtin (and argument
 * size), evaluated by our machine (plutus-machine + the named cost model) and by aiken's
 * `uplc` crate (tools/uplc-ref eval-text). Prints the builtins whose budgets differ.
 *   bun scripts/builtin-cost-diff.ts <costs.json> [v1|v2|v3] [--all]
 * costs.json: {"PlutusV2":[…]} as tools/uplc-ref expects (epoch_params cost_models).
 */
import { Machine } from "@harmoniclabs/plutus-machine";
import { parseUPLCText, showUPLC } from "@harmoniclabs/uplc";
import { toCostModelV1, toCostModelV2 } from "@harmoniclabs/cardano-costmodels-ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [costsPath, langArg = "v2"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const showAll = process.argv.includes("--all");
const costs = JSON.parse(await Bun.file(costsPath!).text());
const arr = costs[{ v1: "PlutusV1", v2: "PlutusV2", v3: "PlutusV3" }[langArg]!];
const model: any = langArg === "v1" ? toCostModelV1(arr) : langArg === "v2" ? toCostModelV2(arr) : arr;
const machine = new Machine(model);
const dir = mkdtempSync(join(tmpdir(), "bcd-"));
const B = "tools/uplc-ref/target/release/uplc-ref";

const bs = (n: number, b = 0xab) => "#" + Buffer.alloc(n, b).toString("hex");
const bigInt = (words: number) => (1n << BigInt(64 * words - 3)).toString();
const list = (xs: string[]) => `(con (list integer) [${xs.join(", ")}])`;
const dataConstr = (n: number) => `(con data (Constr 0 [${Array.from({ length: n }, (_, i) => `I ${i}`).join(", ")}]))`;
const F = (b: string, n = 1) => "(force ".repeat(n) + `(builtin ${b})` + ")".repeat(n);
const app = (f: string, ...args: string[]) => args.reduce((acc, a) => `[${acc} ${a}]`, f);

const cases: Array<[string, string]> = [];
for (const w of [1, 4]) {
    const a = `(con integer ${bigInt(w)})`, b = `(con integer ${bigInt(Math.max(1, w - 1))})`;
    for (const op of ["addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger", "equalsInteger", "lessThanInteger", "lessThanEqualsInteger"]) cases.push([`${op}/${w}w`, app(`(builtin ${op})`, a, b)]);
}
for (const n of [8, 200]) {
    const x = `(con bytestring ${bs(n)})`, y = `(con bytestring ${bs(n, 0xcd)})`;
    for (const op of ["appendByteString", "equalsByteString", "lessThanByteString", "lessThanEqualsByteString"]) cases.push([`${op}/${n}B`, app(`(builtin ${op})`, x, y)]);
    for (const op of ["sha2_256", "sha3_256", "blake2b_256", "lengthOfByteString"]) cases.push([`${op}/${n}B`, app(`(builtin ${op})`, x)]);
    cases.push([`consByteString/${n}B`, app("(builtin consByteString)", "(con integer 7)", x)]);
    cases.push([`sliceByteString/${n}B`, app("(builtin sliceByteString)", "(con integer 1)", `(con integer ${n - 2})`, x)]);
    cases.push([`indexByteString/${n}B`, app("(builtin indexByteString)", x, "(con integer 3)")]);
    const s = `(con string "${"ab".repeat(n / 2)}")`;
    cases.push([`appendString/${n}`, app("(builtin appendString)", s, s)]);
    cases.push([`equalsString/${n}`, app("(builtin equalsString)", s, s)]);
    cases.push([`encodeUtf8/${n}`, app("(builtin encodeUtf8)", s)]);
    cases.push([`decodeUtf8/${n}`, app("(builtin decodeUtf8)", `(con bytestring #${Buffer.from("ab".repeat(n / 2)).toString("hex")})`)]);
}
cases.push(["ifThenElse", app(F("ifThenElse"), "(con bool True)", "(con integer 1)", "(con integer 2)")]);
cases.push(["chooseUnit", app(F("chooseUnit"), "(con unit ())", "(con integer 1)")]);
cases.push(["trace", app(F("trace"), '(con string "hello")', "(con integer 1)")]);
cases.push(["fstPair", app(F("fstPair", 2), "(con (pair integer bytestring) (1, #00))")]);
cases.push(["sndPair", app(F("sndPair", 2), "(con (pair integer bytestring) (1, #00))")]);
cases.push(["chooseList", app(F("chooseList", 2), list(["1", "2"]), "(con integer 0)", "(con integer 1)")]);
cases.push(["mkCons", app(F("mkCons"), "(con integer 1)", list(["2", "3"]))]);
cases.push(["headList", app(F("headList"), list(["1", "2", "3"]))]);
cases.push(["tailList", app(F("tailList"), list(["1", "2", "3"]))]);
cases.push(["nullList", app(F("nullList"), list(["1", "2", "3"]))]);
cases.push(["chooseData", app(F("chooseData"), dataConstr(2), "(con integer 0)", "(con integer 1)", "(con integer 2)", "(con integer 3)", "(con integer 4)")]);
cases.push(["constrData", app("(builtin constrData)", "(con integer 0)", "(con (list data) [I 1, B #00])")]);
cases.push(["mapData", app("(builtin mapData)", "(con (list (pair data data)) [(I 1, B #00)])")]);
cases.push(["listData", app("(builtin listData)", "(con (list data) [I 1, B #00])")]);
cases.push(["iData", app("(builtin iData)", "(con integer 42)")]);
cases.push(["bData", app("(builtin bData)", `(con bytestring ${bs(20)})`)]);
cases.push(["unConstrData", app("(builtin unConstrData)", dataConstr(3))]);
cases.push(["unMapData", app("(builtin unMapData)", "(con data (Map [(I 1, I 2)]))")]);
cases.push(["unListData", app("(builtin unListData)", "(con data (List [I 1, I 2]))")]);
cases.push(["unIData", app("(builtin unIData)", "(con data (I 42))")]);
cases.push(["unBData", app("(builtin unBData)", `(con data (B ${bs(20)}))`)]);
for (const n of [2, 40]) {
    cases.push([`equalsData/${n}`, app("(builtin equalsData)", dataConstr(n), dataConstr(n))]);
    cases.push([`serialiseData/${n}`, app("(builtin serialiseData)", dataConstr(n))]);
}
cases.push(["mkPairData", app("(builtin mkPairData)", "(con data (I 1))", "(con data (B #00))")]);
cases.push(["mkNilData", app("(builtin mkNilData)", "(con unit ())")]);
cases.push(["mkNilPairData", app("(builtin mkNilPairData)", "(con unit ())")]);
cases.push(["verifyEd25519Signature", app("(builtin verifyEd25519Signature)", `(con bytestring ${bs(32, 0x01)})`, `(con bytestring ${bs(50)})`, `(con bytestring ${bs(64, 0x02)})`)]);

if (process.argv.includes("--edge")) { const { extra } = await import("./builtin-cost-cases-edge.ts"); cases.length = 0; cases.push(...extra); }
if (process.argv.includes("--edge2")) { const { extra } = await import("./builtin-cost-cases-sizes.ts"); cases.length = 0; cases.push(...extra); }
let diffs = 0, ran = 0, skipped = 0;
for (const [name, term] of cases) {
    let ours: { cpu: bigint; mem: bigint } | string; let ourResult = "";
    try {
        const t = parseUPLCText(term);
        const r: any = machine.eval(t);
        ours = { cpu: BigInt(r.budgetSpent.cpu), mem: BigInt(r.budgetSpent.mem) };
        const v: any = r.result;
        if (v instanceof Error || v?.constructor?.name === "CEKError") ourResult = `error ${String(v?.message ?? v?.msg ?? "").slice(0, 60)}`;
        else { const c = v?.value ?? v; ourResult = typeof c === "bigint" ? `(con integer ${c})` : typeof c === "boolean" ? `(con bool ${c ? "True" : "False"})` : typeof c?.toString === "function" && c?.constructor?.name === "ByteString" ? `(con bytestring #${c.toString()})` : typeof c === "string" ? `(con string "${c}")` : (v?.constructor?.name ?? String(v)); }
    } catch (e: any) { ours = `ours: ${String(e?.message ?? e).slice(0, 80)}`; }
    const f = join(dir, name.replace(/[^A-Za-z0-9]/g, "_") + ".uplc");
    writeFileSync(f, `(program 1.0.0 ${term})`);
    const p = Bun.spawnSync([B, "eval-text", f, langArg, costsPath!]);
    const out = (p.stdout.toString() + p.stderr.toString()).trim();
    const m = out.match(/ok cpu (\d+) mem (\d+)(?: result (.*))?/);
    const theirs = m ? { cpu: BigInt(m[1]!), mem: BigInt(m[2]!) } : `aiken: ${out.split("\n").slice(-1)[0]?.slice(0, 80)}`;
    if (typeof ours === "string" || typeof theirs === "string") { skipped++; console.log(`?? ${name.padEnd(28)} ${typeof ours === "string" ? ours : ""} ${typeof theirs === "string" ? theirs : ""}`); continue; }
    ran++;
    const norm = (x: string) => x.replace(/\s+/g, "");
    const aikenRes = m?.[3] ? norm(m[3]) : "";
    const resultComparable = ourResult && aikenRes && /^\(con (integer|bool|bytestring|string)/.test(ourResult) && /^\(con (integer|bool|bytestring|string)/.test(aikenRes);
    const resultDiffers = resultComparable && norm(ourResult) !== aikenRes;
    const same = ours.cpu === theirs.cpu && ours.mem === theirs.mem && !resultDiffers;
    if (!same) diffs++;
    if (!same || showAll) console.log(`${same ? "ok" : resultDiffers ? "!R" : "!!"} ${name.padEnd(28)} ours cpu ${ours.cpu} mem ${ours.mem}   aiken cpu ${theirs.cpu} mem ${theirs.mem}   Δcpu ${ours.cpu - theirs.cpu} Δmem ${ours.mem - theirs.mem}${m?.[3] ? `   aiken result ${m[3].replace(/\s+/g, " ").slice(0, 70)}` : ""}${ourResult ? `   ours result ${ourResult.replace(/\s+/g, " ").slice(0, 70)}` : ""}`);
}
console.log(`\n${ran} compared, ${diffs} differ, ${skipped} not evaluable on one side (${dir})`);
