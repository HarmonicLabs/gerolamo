/**
 * Governance rules of one block (govRules.ts) against the ledger state before it (govLedgerView.ts):
 * the entry point of the body validator and of `scripts/gov-replay.ts`.
 *
 * Mode (`GEROLAMO_GOV_RULES` = strict | report): strict rejects the block like any other ledger-rule
 * failure (the producer drops the named `tx[i]`); report logs and counts only. The default is set
 * from the replay of preview's governance history (docs/VALIDATION_STATUS.md, bug 150). Tip sync
 * (no ledger behind the tip) is always report-only.
 */
import { logger } from "../../utils/logger";
import { bodyHasGovernance, decodeGovTx, type GovTxModel } from "./govTxDecode";
import { checkGovTx, GovBlockOverlay, type GovLedgerView, type GovRuleParams } from "./govRules";
import { buildGovLedgerView } from "./govLedgerView";

export type GovRulesMode = "strict" | "report";
/**
 * Strict since the preview replay (bug 150): 218 325 governance-bearing transactions of epochs
 * 646–1434 through these checks with no failure, and none on either node's LMDB store.
 */
const DEFAULT_MODE: GovRulesMode = "strict";
export function govRulesMode(): GovRulesMode {
    const e = process.env.GEROLAMO_GOV_RULES?.trim().toLowerCase();
    return e === "strict" || e === "report" ? e : DEFAULT_MODE;
}

const stats = { blocks: 0, txs: 0, failedTxs: 0, failures: 0, decodeErrors: 0, byRule: {} as Record<string, number>, last: null as null | { slot: number; failures: string[] } };
/** /metrics JSON: how many governance-bearing transactions were checked and what failed, by rule. */
export function govRuleSummary(): { mode: GovRulesMode; blocks: number; txs: number; failedTxs: number; failures: number; decodeErrors: number; byRule: Record<string, number>; last: { slot: number; failures: string[] } | null } {
    return { mode: govRulesMode(), ...stats, byRule: { ...stats.byRule } };
}

export function govRuleParamsOf(raw: Record<string, unknown>, epoch: number, networkId: number): GovRuleParams {
    const big = (v: unknown, d: bigint) => { try { return v == null ? d : BigInt(String(v)); } catch { return d; } };
    return {
        protocolMajor: Number(raw.protocol_major_ver ?? 9), protocolMinor: Number(raw.protocol_minor_ver ?? 0),
        keyDeposit: big(raw.key_deposit, 2_000_000n), minPoolCost: big(raw.min_pool_cost, 0n), eMax: Number(raw.e_max ?? 18),
        networkId, epoch,
        govActionDeposit: big(raw.gov_action_deposit, 0n), drepDeposit: big(raw.drep_deposit, 0n), govActionLifetime: Number(raw.gov_action_lifetime ?? 6),
    };
}

export interface GovBlockInput {
    slot: number;
    epoch: number;
    /** Transaction bodies (CBOR bytes of each body map) and ids, in block order. */
    bodies: Array<{ bytes: Uint8Array | null; txId?: string }>;
    /** Indices of phase-2-invalid transactions (no certificates, no governance). */
    invalid: Set<number>;
    raw: Record<string, unknown>;
    networkId: number;
    /** A prepared view; default: the node's store. */
    view?: GovLedgerView;
    /** The store holds no reward balances (the replay): the zero-balance predicate is skipped. */
    balancesUnknown?: boolean;
}

export interface GovBlockVerdict { failures: string[]; reports: string[]; checked: number; models: Array<{ index: number; model: GovTxModel }> }

/** Decode the governance content of a block's transactions (phase-2-valid ones, with any key the rules read). */
export function blockGovModels(input: Pick<GovBlockInput, "bodies" | "invalid">, reports: string[]): Array<{ index: number; model: GovTxModel }> {
    const out: Array<{ index: number; model: GovTxModel }> = [];
    input.bodies.forEach((b, i) => {
        if (input.invalid.has(i) || !b.bytes || !bodyHasGovernance(b.bytes)) return;
        try { out.push({ index: i, model: decodeGovTx(b.bytes, b.txId) }); }
        catch (err) { stats.decodeErrors++; reports.push(`tx[${i}]: governance content not decodable (${(err as Error).message}); not checked`); }
    });
    return out;
}

export async function checkBlockGovernance(input: GovBlockInput): Promise<GovBlockVerdict> {
    const reports: string[] = [], failures: string[] = [];
    const pp = govRuleParamsOf(input.raw, input.epoch, input.networkId);
    if (pp.protocolMajor < 9) return { failures, reports, checked: 0, models: [] };
    const models = blockGovModels(input, reports);
    if (models.length === 0) return { failures, reports, checked: 0, models };
    const view = input.view ?? (await buildGovLedgerView(models.map((m) => m.model), { needVrfs: pp.protocolMajor > 10 && models.some((m) => m.model.certs.some((c) => c.type === 3)), balancesUnknown: input.balancesUnknown }));
    const overlay = new GovBlockOverlay(view);
    for (const { index, model } of models) {
        const v = checkGovTx(model, pp, overlay);
        for (const f of v.failures) failures.push(`tx[${index}] ${model.txId.slice(0, 12)}…: ${f}`);
        for (const r of v.reports) reports.push(`tx[${index}] ${model.txId.slice(0, 12)}…: ${r}`);
        stats.txs++;
        if (v.failures.length) {
            stats.failedTxs++;
            for (const f of v.failures) { const rule = f.split(" ").slice(0, 2).join(" "); stats.byRule[rule] = (stats.byRule[rule] ?? 0) + 1; stats.failures++; }
        }
    }
    stats.blocks++;
    if (failures.length) stats.last = { slot: input.slot, failures: failures.slice(0, 8) };
    return { failures, reports, checked: models.length, models };
}

/** The body validator's call: log, count, and say whether a strict node must reject the block. */
export async function validateBlockGovernance(input: GovBlockInput, ledgerComplete: boolean): Promise<{ ok: boolean; failures: string[] }> {
    let verdict: GovBlockVerdict;
    try { verdict = await checkBlockGovernance(input); }
    catch (err) { logger.warn(`governance rules not evaluated at slot ${input.slot}: ${(err as Error).message}`); return { ok: true, failures: [] }; }
    for (const r of verdict.reports.slice(0, 3)) logger.info(`Governance rule report at slot ${input.slot}: ${r}`);
    if (verdict.failures.length === 0) return { ok: true, failures: [] };
    const strict = ledgerComplete && govRulesMode() === "strict";
    const msg = `Governance rules ${strict ? "failed" : "(report-only) would fail"} at slot ${input.slot}: ${verdict.failures.slice(0, 5).join(" | ")}${verdict.failures.length > 5 ? ` | +${verdict.failures.length - 5} more` : ""}`;
    if (strict) logger.error(msg); else logger.warn(msg);
    return { ok: !strict, failures: verdict.failures };
}
