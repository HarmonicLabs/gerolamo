import os from "node:os";
import { logger } from "../../utils/logger";
import {
    runHeaderValidationJob,
    type HeaderValidationJob,
    type HeaderValidationResult,
} from "./validationJob";

/**
 * Pool of Bun Workers for header validation (KES/VRF are the CPU cost of
 * genesis sync). `size = 0` runs jobs inline on the main thread, so the
 * worker path is never a hard dependency.
 *
 * Config: `validation.workers` — a number, or "auto" (= all cores, the
 * user's chosen default). Clamped to [0, 64].
 */

export type WorkerCountSetting = number | "auto" | undefined | null;

export function resolveWorkerCount(setting: WorkerCountSetting): number {
    const cores = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : Math.max(1, os.cpus().length);
    if (setting == null || setting === "auto") return Math.max(1, Math.min(64, cores));
    const n = Number(setting);
    if (!Number.isFinite(n)) return Math.max(1, Math.min(64, cores));
    return Math.max(0, Math.min(64, Math.trunc(n)));
}

interface Pending {
    resolve: (r: HeaderValidationResult) => void;
    reject: (e: unknown) => void;
    worker: Worker;
}

export class ValidationPool {
    readonly size: number;
    private readonly workers: Worker[] = [];
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private rr = 0;
    private closed = false;
    private spawnFailed = false;

    constructor(size: number) {
        this.size = Math.max(0, size);
        for (let i = 0; i < this.size; i++) {
            const w = this.spawn(i);
            if (!w) {
                this.spawnFailed = true;
                break;
            }
            this.workers.push(w);
        }
        if (this.spawnFailed) {
            logger.warn("ValidationPool: worker spawn failed; falling back to inline validation");
            for (const w of this.workers) w.terminate();
            this.workers.length = 0;
        }
        if (this.workers.length > 0) {
            logger.info(`ValidationPool: ${this.workers.length} header-validation worker(s)`);
        } else {
            logger.info("ValidationPool: inline (0 workers)");
        }
    }

    get workerCount(): number {
        return this.workers.length;
    }

    private spawn(index: number): Worker | null {
        try {
            const w = new Worker(new URL("./validationWorker.ts", import.meta.url).href);
            w.onmessage = (ev: MessageEvent<{ id: number; result?: HeaderValidationResult; error?: string }>) => {
                const p = this.pending.get(ev.data.id);
                if (!p) return;
                this.pending.delete(ev.data.id);
                if (ev.data.error != null) p.reject(new Error(ev.data.error));
                else p.resolve(ev.data.result!);
            };
            w.onerror = (ev: ErrorEvent) => {
                logger.error(`ValidationPool worker #${index} error:`, ev.message ?? ev);
                this.failWorker(w, new Error(`validation worker crashed: ${ev.message ?? "unknown"}`));
                // Replace the crashed worker so the pool keeps its size.
                if (!this.closed) {
                    const i = this.workers.indexOf(w);
                    const nw = this.spawn(index);
                    if (nw) {
                        if (i >= 0) this.workers[i] = nw;
                        else this.workers.push(nw);
                    } else if (i >= 0) {
                        this.workers.splice(i, 1);
                    }
                }
                try {
                    w.terminate();
                } catch {
                    /* */
                }
            };
            return w;
        } catch (err) {
            logger.warn(`ValidationPool: cannot spawn worker #${index}:`, err);
            return null;
        }
    }

    private failWorker(w: Worker, err: Error): void {
        for (const [id, p] of this.pending) {
            if (p.worker === w) {
                this.pending.delete(id);
                p.reject(err);
            }
        }
    }

    validate(job: HeaderValidationJob): Promise<HeaderValidationResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (this.workers.length === 0) return runHeaderValidationJob(job);
        const worker = this.workers[this.rr++ % this.workers.length]!;
        const id = this.nextId++;
        return new Promise<HeaderValidationResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker });
            // True copy into a fresh ArrayBuffer (a Node Buffer's .slice() is a view, and
            // transferring a view's buffer would detach the caller's bytes), then transfer.
            const copy = new Uint8Array(job.rollForward.byteLength);
            copy.set(job.rollForward);
            worker.postMessage({ id, job: { ...job, rollForward: copy } }, [copy.buffer]);
        });
    }

    /** Validate many jobs concurrently, preserving order. */
    validateAll(jobs: HeaderValidationJob[]): Promise<HeaderValidationResult[]> {
        return Promise.all(jobs.map((j) => this.validate(j)));
    }

    stats(): { workers: number; pending: number } {
        return { workers: this.workers.length, pending: this.pending.size };
    }

    close(): void {
        this.closed = true;
        const err = new Error("ValidationPool closed");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        for (const w of this.workers) {
            try {
                w.terminate();
            } catch {
                /* */
            }
        }
        this.workers.length = 0;
    }
}
