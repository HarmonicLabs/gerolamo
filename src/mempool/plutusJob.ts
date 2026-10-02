/**
 * Phase 2 for a mempool transaction: the ledger's UTXOS rule on the submitted bytes and the
 * resolved inputs (`checkMempoolTxPhase2`, src/consensus/rules/phase2.ts — the same evaluator
 * the block path runs). Runs on a worker thread: a script can take seconds and must never stall
 * the sync loop.
 *
 * The slot → POSIX time geometry of the script context is the *network name* (preview / preprod
 * / mainnet), never the mainnet/testnet address flag: "testnet" normalises to preprod, and with
 * preprod's system start a preview transaction's validity range came out wrong — one script
 * failed on it and another looped past its budget (mempool replay, 2026-09-29).
 */
import type { EpochBodyParams } from "../consensus/epochParams";
import type { ResolvedUtxo } from "../consensus/rules/resolvedUtxo";
import { checkMempoolTxPhase2 } from "../consensus/rules/phase2";
import { setEpochNetwork } from "../utils/epochFromSlotCalculations";

export interface MempoolPlutusJob {
    kind: "mempoolPlutus";
    tx: Uint8Array;
    bodyBytes: Uint8Array;
    witnessSetBytes: Uint8Array;
    /** The transaction's is_valid flag is false (the submitter expects its collateral to be taken). */
    markedInvalid?: boolean;
    resolved: Map<string, ResolvedUtxo>;
    params: EpochBodyParams;
    genesis: unknown;
    /** Address-network flag (mainnet / testnet); not used for the script context. */
    network: string;
    /** The epoch-geometry network name (preview / preprod / mainnet) for slot → POSIX time. */
    epochNetwork: string;
}

/**
 * `passed`: the ledger's phase 2 accepts the transaction; `failed`: ValidationTagMismatch (the
 * scripts contradict the is_valid flag) or CollectErrors (no script context can be built);
 * `unchecked`: no verdict could be computed (the caller decides; the default admits and counts).
 */
export interface MempoolPlutusResult {
    verdict: "passed" | "failed" | "unchecked";
    kind?: "ValidationTagMismatch" | "CollectErrors";
    detail: string | null;
    evaluated: number;
    ms: number;
}

export function isMempoolPlutusJob(job: unknown): job is MempoolPlutusJob {
    return !!job && (job as any).kind === "mempoolPlutus" && (job as any).tx instanceof Uint8Array;
}

export async function runMempoolPlutusJob(job: MempoolPlutusJob): Promise<MempoolPlutusResult> {
    const t0 = performance.now();
    try {
        setEpochNetwork(job.epochNetwork);
        const { failure } = checkMempoolTxPhase2({
            era: 7, bodyBytes: job.bodyBytes, witnessSetBytes: job.witnessSetBytes, resolved: job.resolved, params: job.params,
            markedInvalid: job.markedInvalid === true, network: job.epochNetwork,
        });
        const ms = performance.now() - t0;
        if (!failure) return { verdict: "passed", detail: null, evaluated: 1, ms };
        const evaluated = failure.redeemers.filter((r) => r.spent).length;
        if (failure.kind === "Unknown") return { verdict: "unchecked", detail: failure.detail, evaluated, ms };
        return { verdict: "failed", kind: failure.kind, detail: failure.detail, evaluated, ms };
    } catch (err) {
        return { verdict: "unchecked", detail: err instanceof Error ? err.message : String(err), evaluated: 0, ms: performance.now() - t0 };
    }
}
