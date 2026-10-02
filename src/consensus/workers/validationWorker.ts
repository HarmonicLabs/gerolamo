/// <reference lib="webworker" />
import {
    fresh,
    isRangeVerifyJob,
    runHeaderValidationJob,
    runRangeVerifyJob,
    type PoolJob,
    isBlockWitnessJob,
    runBlockWitnessJob,
    isBlockRulesJob,
    runBlockRulesJob,
} from "./validationJob";
import { isWitnessVerifyJob, runWitnessVerifyJob } from "./witnessJob";
import { isMempoolPlutusJob, runMempoolPlutusJob } from "../../mempool/plutusJob";

/**
 * Bun Worker entry: header parse + validation, and fetched-range verification
 * (header identity + body hash), off the main thread.
 * https://bun.sh/docs/runtime/workers
 *
 * Message in : { id, job: HeaderValidationJob | RangeVerifyJob }   (byte buffers transferred)
 * Message out: { id, result } | { id, error }                       (rawHeader buffers transferred)
 */
const sharedParams = new Map<number, NonNullable<import("./validationJob").BlockRulesJob["params"]>>();
const sharedGenesis = new Map<number, unknown>();

declare const self: Worker;

self.onmessage = async (ev: MessageEvent<{ id: number; job: PoolJob }>) => {
    const { id, job } = ev.data;
    try {
        if ((job as any)?.kind === "memory") {
            // diagnostics: this worker thread's own heap (the process RSS is shared)
            const mu = process.memoryUsage();
            self.postMessage({ id, result: { heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external: mu.external } });
            return;
        }
        if (isWitnessVerifyJob(job)) {
            self.postMessage({ id, result: runWitnessVerifyJob(job) });
            return;
        }
        if (isMempoolPlutusJob(job)) {
            self.postMessage({ id, result: await runMempoolPlutusJob(job) });
            return;
        }
        if (isBlockWitnessJob(job)) {
            self.postMessage({ id, result: runBlockWitnessJob(job) });
            return;
        }
        if (isBlockRulesJob(job)) {
            // Params/genesis arrive once per worker under an id (BlockRulesJob.paramsId); keep them.
            if (job.paramsId != null) { if (job.params) sharedParams.set(job.paramsId, job.params); else job.params = sharedParams.get(job.paramsId) ?? null; }
            if (job.genesisId != null) { if (job.genesis != null) sharedGenesis.set(job.genesisId, job.genesis); else job.genesis = sharedGenesis.get(job.genesisId) ?? null; }
            self.postMessage({ id, result: await runBlockRulesJob(job) });
            return;
        }
        if (isRangeVerifyJob(job)) {
            const result = runRangeVerifyJob(job);
            const identities = result.identities.map((r) => ({ ...r, rawHeader: fresh(r.rawHeader) }));
            self.postMessage({ id, result: { ...result, identities } }, identities.map((r) => r.rawHeader.buffer));
            return;
        }
        const result = await runHeaderValidationJob(job);
        const raw = fresh(result.rawHeader);
        self.postMessage({ id, result: { ...result, rawHeader: raw } }, [raw.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
};
