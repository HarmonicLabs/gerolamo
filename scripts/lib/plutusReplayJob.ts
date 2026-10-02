/** One replayed Plutus transaction (scripts/plutus-replay.ts), runnable inline or in a worker. */
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { outputLike } from "../../src/consensus/rules/blockRulesPure";
import { epochParamsFromRecord } from "../../src/consensus/epochParams";
import type { ResolvedUtxo } from "../../src/consensus/rules/resolvedUtxo";
import { setEpochNetwork } from "../../src/utils/epochFromSlotCalculations";
import { evaluatePhase2 } from "../../src/consensus/rules/phase2";

export interface ReplayJob {
    slot: number; i: number; txHash: string; valid: boolean; era: number;
    bodyHex: string; witnessHex: string;
    /** [ref, output CBOR hex] */
    resolved: Array<[string, string]>;
    params: Record<string, unknown> | null;
    network: string;
}
export interface ReplayResult { ok: boolean; redeemers: number; ms: number; declaredCpu: number; overDeclared?: boolean; exact?: number; spentCpu?: number; error?: string | null; detail?: string | null; langs?: string }

let net: string | null = null;
export async function runReplayJob(job: ReplayJob): Promise<ReplayResult> {
    if (net !== job.network) { setEpochNetwork(job.network); net = job.network; }
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, h] of job.resolved) {
        const o = outputLike(TxOut.fromCbor(h));
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    }
    const params = job.params ? epochParamsFromRecord(Math.floor(job.slot / 86400), job.params) : null;
    const t = performance.now();
    const r = await evaluatePhase2({ era: job.era, bodyBytes: Buffer.from(job.bodyHex, "hex"), witnessSetBytes: Buffer.from(job.witnessHex, "hex"), resolved, params, markedInvalid: !job.valid, network: job.network });
    const ms = performance.now() - t;
    return {
        ok: r.ok, redeemers: r.redeemers.length, ms, declaredCpu: r.redeemers.reduce((s, x) => s + Number(x.declared.cpu), 0),
        overDeclared: r.redeemers.some((x) => x.spent && (x.spent.cpu > x.declared.cpu || x.spent.mem > x.declared.mem) && x.ok),
        exact: r.redeemers.filter((x) => x.spent && x.spent.cpu === x.declared.cpu && x.spent.mem === x.declared.mem).length,
        spentCpu: r.redeemers.reduce((s, x) => s + Number(x.spent?.cpu ?? 0n), 0),
        langs: [...new Set(r.redeemers.map((x) => x.language))].join(""),
        error: r.error, detail: r.ok ? null : r.redeemers.filter((x) => !x.ok).map((x) => `${x.tag}:${x.index} ${x.reason ?? ""}`).join("; ").slice(0, 400),
    };
}
