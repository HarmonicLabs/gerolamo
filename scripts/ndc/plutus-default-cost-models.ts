#!/usr/bin/env bun
/**
 * Regenerate src/consensus/__fixtures__/plutus-default-cost-models.json: the default cost model of
 * each Plutus ledger language at protocol versions 8–11, as plutus' `defaultCostModelParamsForVariant`
 * gives it for the language's semantics variant at that protocol version (PlutusLedgerApi.V*.
 * EvaluationContext: V1/V2 A before protocol 9, B before 11, D from 11; V3 C before 11, E from 11),
 * laid out in the ledger's `ParamName` order (paramNames.ts) at plutus 1.63's lengths (332 for V1 and
 * V2, 350 for V3).
 *
 *   bun scripts/ndc/plutus-default-cost-models.ts --plutus <IntersectMBO/plutus checkout> [--out <fixture.json>]
 *
 * Reads `plutus-core/cost-model/data/builtinCostModel{A..E}.json` and `cekMachineCosts{A..E}.json`
 * (data; nothing in the checkout runs). These are the models pragma's node-diversity-conformance
 * UPLC scenarios evaluate with: the `uplc-conformance` corpus ships the protocol 10 / 11 lists under
 * `cost-models/` (byte-identical to this derivation), and the `uplc-turbo` budgets of cardano-node's
 * report reproduce only with the variant A / B / C lists at protocol 8 / 9 (not with mainnet's
 * on-chain parameters of those epochs, which differ from variant A in the three secp256k1 V2
 * parameters). See docs/parity/ndc-uplc.md.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { semanticsVariant, shapeVariant } from "../../src/consensus/plutus/costs";
import { PARAM_NAMES_V1, PARAM_NAMES_V2, PARAM_NAMES_V3 } from "../../src/consensus/plutus/paramNames";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const plutus = flag("plutus");
if (!plutus) { console.error("usage: plutus-default-cost-models.ts --plutus <plutus checkout> [--out <fixture.json>]"); process.exit(2); }
const out = flag("out", new URL("../../src/consensus/__fixtures__/plutus-default-cost-models.json", import.meta.url).pathname)!;
const data = join(plutus, "plutus-core/cost-model/data");

/** plutus 1.63's ParamName counts (cardano-node 11.0.1): the lists the ledger carries; later names (assetCount, …) are master-only. */
export const PARAM_COUNTS = { 1: 332, 2: 332, 3: 350 } as const;
const NAMES = { 1: PARAM_NAMES_V1, 2: PARAM_NAMES_V2, 3: PARAM_NAMES_V3 } as const;
/** Protocol versions covered and the language each exists in (V3 from Chang, protocol 9). */
export const PROTOCOL_VERSIONS = [8, 9, 10, 11] as const;
const LANGUAGE_INTRODUCED_IN = { 1: 5, 2: 7, 3: 9 } as const;

/** `<builtin>-<cpu|memory>-arguments[-model-arguments]-<field>` or `cek*Cost-exBudget<CPU|Memory>` → the JSON's number. */
function lookup(builtins: any, machine: any, name: string): number {
    const m = /^(cek\w+Cost)-(exBudgetCPU|exBudgetMemory)$/.exec(name);
    if (m) { const v = machine[m[1]!]?.[m[2]!]; if (typeof v !== "number") throw new Error(`${name}: no machine cost`); return v; }
    const parts = name.split("-");
    let node = builtins[parts[0]!]?.[parts[1]!];
    if (!node) throw new Error(`${name}: no builtin cost function`);
    for (let i = 2; ; i++) {
        if (parts[i] !== "arguments") throw new Error(`${name}: unexpected segment ${parts[i]}`);
        i++;
        if (i >= parts.length) { if (typeof node.arguments !== "number") throw new Error(`${name}: not a constant`); return node.arguments; }
        if (parts[i] === "model") { node = node.arguments.model; continue; }
        const v = node.arguments?.[parts[i]!];
        if (typeof v !== "number") throw new Error(`${name}: no field ${parts[i]}`);
        return v;
    }
}

function listFor(variant: string, lang: 1 | 2 | 3): number[] {
    const builtins = JSON.parse(readFileSync(join(data, `builtinCostModel${variant}.json`), "utf8"));
    const machine = JSON.parse(readFileSync(join(data, `cekMachineCosts${variant}.json`), "utf8"));
    return NAMES[lang].slice(0, PARAM_COUNTS[lang]).map((n) => lookup(builtins, machine, n));
}

const commit = (() => { try { const p = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: plutus, stdout: "pipe", stderr: "pipe" }); return p.exitCode === 0 ? p.stdout.toString().trim() : null; } catch { return null; } })();
const variants: Record<string, Record<string, string>> = {}, models: Record<string, Record<string, number[]>> = {};
const files = new Set<string>();
for (const pv of PROTOCOL_VERSIONS) {
    variants[pv] = {}; models[pv] = {};
    for (const lang of [1, 2, 3] as const) {
        if (pv < LANGUAGE_INTRODUCED_IN[lang]) continue;
        const v = shapeVariant(semanticsVariant(lang, pv));
        if (!existsSync(join(data, `builtinCostModel${v}.json`))) throw new Error(`${data}: no builtinCostModel${v}.json`);
        variants[pv]![`PlutusV${lang}`] = v;
        models[pv]![`PlutusV${lang}`] = listFor(v, lang);
        files.add(`builtinCostModel${v}.json`); files.add(`cekMachineCosts${v}.json`);
    }
}
const fixture = {
    source: "plutus-core cost-model/data/builtinCostModel{A..E}.json + cekMachineCosts{A..E}.json (IntersectMBO/plutus), the semantics variant of each ledger language at each protocol version (PlutusLedgerApi.V*.EvaluationContext), in PlutusLedgerApi.V*.ParamName order at plutus 1.63's lengths; generated by scripts/ndc/plutus-default-cost-models.ts",
    plutus: { commit, files: [...files].sort() },
    lengths: { PlutusV1: PARAM_COUNTS[1], PlutusV2: PARAM_COUNTS[2], PlutusV3: PARAM_COUNTS[3] },
    variants,
    models,
};
writeFileSync(out, JSON.stringify(fixture, (_k, v) => v, 0).replace(/\],"/g, "],\n\"").replace(/\{"8"/, "{\n\"8\"") + "\n");
console.log(`${out}: protocol versions ${PROTOCOL_VERSIONS.join(", ")}, variants ${JSON.stringify(variants)}, plutus ${commit ?? "(unknown commit)"}`);
