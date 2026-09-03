/// <reference lib="webworker" />
import { runHeaderValidationJob, type HeaderValidationJob } from "./validationJob";

/**
 * Bun Worker entry: header parse + validation off the main thread.
 * https://bun.sh/docs/runtime/workers
 *
 * Message in : { id, job: HeaderValidationJob }           (rollForward buffer transferred)
 * Message out: { id, result } | { id, error }             (rawHeader buffer transferred)
 */
declare const self: Worker;

self.onmessage = async (ev: MessageEvent<{ id: number; job: HeaderValidationJob }>) => {
    const { id, job } = ev.data;
    try {
        const result = await runHeaderValidationJob(job);
        // Fresh copy so we never transfer a buffer something else still references.
        const raw = new Uint8Array(result.rawHeader.byteLength);
        raw.set(result.rawHeader);
        self.postMessage({ id, result: { ...result, rawHeader: raw } }, [raw.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
};
