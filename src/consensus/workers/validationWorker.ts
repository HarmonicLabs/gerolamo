/// <reference lib="webworker" />
import {
    fresh,
    isRangeVerifyJob,
    runHeaderValidationJob,
    runRangeVerifyJob,
    type PoolJob,
} from "./validationJob";

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
