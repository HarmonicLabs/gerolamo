/// <reference lib="webworker" />
import {
    fresh,
    isRangeVerifyJob,
    runHeaderValidationJob,
    runRangeVerifyJob,
    type PoolJob,
} from "./validationJob";
import { isWitnessVerifyJob, runWitnessVerifyJob } from "./witnessJob";

/**
 * Bun Worker entry: header parse + validation, and fetched-range verification
 * (header identity + body hash), off the main thread.
 * https://bun.sh/docs/runtime/workers
 *
 * Message in : { id, job: HeaderValidationJob | RangeVerifyJob }   (byte buffers transferred)
 * Message out: { id, result } | { id, error }                       (rawHeader buffers transferred)
 */
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
