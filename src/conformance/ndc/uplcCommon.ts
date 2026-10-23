/**
 * Shared bits of the node-diversity-conformance reports (pragma-org/node-diversity-conformance):
 * the `implementation` block, the default cost models per protocol version, the protocol version
 * of a mainnet epoch and the budget a real validation runs under.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Lang } from "../../consensus/plutus/costs";

const ROOT = new URL("../../../", import.meta.url);

export interface Implementation { name: "gerolamo"; version: string; commit: string }

/** `{name, version, commit}`: package.json's version and git HEAD's short hash, "-dirty" with uncommitted changes. */
export function implementation(): Implementation {
    const version = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")).version as string;
    let commit = "unknown";
    try {
        const cwd = ROOT.pathname;
        commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
        const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim() !== "";
        if (dirty) commit += "-dirty";
    } catch { /* not a checkout */ }
    return { name: "gerolamo", version, commit };
}

/**
 * src/consensus/__fixtures__/plutus-default-cost-models.json (scripts/ndc/plutus-default-cost-models.ts):
 * plutus' `defaultCostModelParamsForVariant` for each ledger language's semantics variant at protocol
 * versions 8–11, in the ledger's `ParamName` order at plutus 1.63's lengths (332 / 332 / 350). What
 * pragma's UPLC scenarios call the default cost models: the `uplc-conformance` corpus ships the
 * protocol 10 / 11 lists (identical), and cardano-node's `uplc-turbo` budgets reproduce with the
 * protocol 8 / 9 ones (variant A at 8 differs from mainnet's on-chain parameters of those epochs in
 * the three secp256k1 V2 parameters, so this is the reference, not Koios).
 */
export interface DefaultCostModelsFixture {
    source: string;
    plutus: { commit: string | null; files: string[] };
    lengths: Record<string, number>;
    /** protocol version → language → semantics variant whose JSON the list comes from (`A` … `E`). */
    variants: Record<string, Record<string, string>>;
    /** protocol version → language (`PlutusV1` …) → parameter list. */
    models: Record<string, Record<string, number[]>>;
}
let fixture: DefaultCostModelsFixture | null = null;
export function defaultCostModelsFixture(): DefaultCostModelsFixture {
    return (fixture ??= JSON.parse(readFileSync(new URL("src/consensus/__fixtures__/plutus-default-cost-models.json", ROOT), "utf8")) as DefaultCostModelsFixture);
}
/** The default cost model of Plutus V`lang` at protocol `pv` (8–11); throws where the language or version is not covered. */
export function defaultCostModel(lang: Lang, pv: number): number[] {
    const list = defaultCostModelsFixture().models[String(pv)]?.[`PlutusV${lang}`];
    if (!list) throw new Error(`no default cost model for Plutus V${lang} at protocol ${pv}`);
    return list;
}
/** The semantics variant the default cost model of Plutus V`lang` at protocol `pv` comes from. */
export function defaultCostModelVariant(lang: Lang, pv: number): string {
    const v = defaultCostModelsFixture().variants[String(pv)]?.[`PlutusV${lang}`];
    if (!v) throw new Error(`no default cost model for Plutus V${lang} at protocol ${pv}`);
    return v;
}
export const DEFAULT_COST_MODEL_SOURCE = "plutus-core builtinCostModel{A..E}.json + cekMachineCosts{A..E}.json by semantics variant, src/consensus/__fixtures__/plutus-default-cost-models.json";

/** The protocol version of a mainnet epoch, as the uplc-turbo README gives it: 644 → 11, 537 → 10, 507 → 9, before that 8. */
export function pvOfEpoch(epoch: number): number {
    return epoch >= 644 ? 11 : epoch >= 537 ? 10 : epoch >= 507 ? 9 : 8;
}

/**
 * Mainnet's `maxTxExecutionUnits` (10 billion CPU, 14 million memory) since Alonzo: the budget
 * every corpus script actually ran under. The uplc-conformance README gives these limits; the
 * uplc-turbo README writes "10M mem", yet cardano-node's and Amaru's turbo reports carry budgets
 * above 10 million memory units for five scripts (10 369 230 … 11 296 656), so both references
 * evaluated with at least mainnet's limit — the same here, otherwise those five would be
 * "out of budget" and could carry no budget to agree with.
 */
export const MAINNET_TX_BUDGET = { cpu: 10_000_000_000, mem: 14_000_000 } as const;
