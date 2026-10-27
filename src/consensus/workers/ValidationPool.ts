import { settingsMessage } from "../../config/settings";
import os from "node:os";
import { logger } from "../../utils/logger";
import {
    runHeaderValidationJob,
    type HeaderValidationJob,
    type HeaderValidationResult,
    type RangeVerifyJob,
    type RangeVerifyResult,
    runRangeVerifyJob,
    fresh,
    type BlockWitnessResult,
    runBlockWitnessJob,
    type BlockRulesJob,
    type BlockRulesResult,
    runBlockRulesJob,
} from "./validationJob";
import { runWitnessVerifyJob, type WitnessVerifyJob, type WitnessVerifyResult } from "./witnessJob";
import { runMempoolPlutusJob, type MempoolPlutusJob, type MempoolPlutusResult } from "../../mempool/plutusJob";

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
    resolve: (r: any) => void;
    reject: (e: unknown) => void;
    worker: Worker;
    /** Load units this job counts for on its worker (1 per header, 1 per block in a range). */
    weight: number;
}

export class ValidationPool {
    readonly size: number;
    private readonly workers: Worker[] = [];
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    /** In-flight jobs per worker; dispatch goes to the least loaded (ties → round-robin). */
    private readonly load = new Map<Worker, number>();
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
            w.postMessage(settingsMessage()); // workers do not inherit the resolved settings
            w.onmessage = (ev: MessageEvent<{ id: number; result?: HeaderValidationResult | RangeVerifyResult; error?: string }>) => {
                const p = this.pending.get(ev.data.id);
                if (!p) return;
                this.pending.delete(ev.data.id);
                this.load.set(p.worker, Math.max(0, (this.load.get(p.worker) ?? p.weight) - p.weight));
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
        this.load.delete(w);
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
        const worker = this.leastLoadedWorker();
        this.load.set(worker, (this.load.get(worker) ?? 0) + 1);
        const id = this.nextId++;
        return new Promise<HeaderValidationResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight: 1 });
            const copy = fresh(job.rollForward);
            worker.postMessage({ id, job: { ...job, rollForward: copy } }, [copy.buffer]);
        });
    }

    /** Blind round-robin piled large jobs onto one worker; pick the shortest queue instead. */
    /**
     * Workers 0..rulesReserved−1 take only block-rule jobs (the apply thread waits on
     * those); everything else uses the rest. Each worker is a FIFO, so without the
     * split a rules job queued behind a header batch or a range verify and the
     * applier stalled (measured: 16 ms wait per block, throughput 87 → 31 blocks/s).
     */
    private get rulesReserved(): number {
        return this.workers.length >= 8 ? Math.max(2, Math.floor(this.workers.length / 5)) : 0;
    }

    private leastLoadedWorker(kind: "general" | "rules" = "general"): Worker {
        const r = this.rulesReserved;
        const pool = r === 0 ? this.workers : kind === "rules" ? this.workers.slice(0, r) : this.workers.slice(r);
        const start = this.rr++ % pool.length;
        let best = pool[start]!;
        let bestLoad = this.load.get(best) ?? 0;
        for (let k = 1; k < pool.length && bestLoad > 0; k++) {
            const w = pool[(start + k) % pool.length]!;
            const l = this.load.get(w) ?? 0;
            if (l < bestLoad) {
                best = w;
                bestLoad = l;
            }
        }
        return best;
    }

    /**
     * Verify a fetched range (header identity + body hash per block) off the main
     * thread. Block bytes are copied once into fresh buffers and transferred; the
     * caller keeps its originals. Inline when the pool has no workers.
     */
    verifyRange(job: RangeVerifyJob): Promise<RangeVerifyResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (this.workers.length === 0) return Promise.resolve(runRangeVerifyJob(job));
        const worker = this.leastLoadedWorker();
        const weight = Math.max(1, job.blocks.length);
        this.load.set(worker, (this.load.get(worker) ?? 0) + weight);
        const id = this.nextId++;
        return new Promise<RangeVerifyResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight });
            const copies = job.blocks.map(fresh);
            worker.postMessage({ id, job: { ...job, blocks: copies } }, copies.map((c) => c.buffer));
        });
    }

    /**
     * Verify witness signatures off the main thread. Items are copied and
     * transferred; inline when the pool has no workers.
     */
    verifyWitnesses(job: WitnessVerifyJob): Promise<WitnessVerifyResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (job.items.length === 0) return Promise.resolve({ ok: [] });
        if (this.workers.length === 0) return Promise.resolve(runWitnessVerifyJob(job));
        const worker = this.leastLoadedWorker();
        const weight = Math.max(1, Math.ceil(job.items.length / 8));
        this.load.set(worker, (this.load.get(worker) ?? 0) + weight);
        const id = this.nextId++;
        return new Promise<WitnessVerifyResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight });
            const items = job.items.map((it) => ({ publicKey: fresh(it.publicKey), signature: fresh(it.signature), message: fresh(it.message) }));
            worker.postMessage({ id, job: { kind: "witnesses", items } }, items.flatMap((it) => [it.publicKey.buffer, it.signature.buffer, it.message.buffer]));
        });
    }

    /**
     * Verify a whole block's witnesses on a worker from its bytes (copied and
     * transferred), so the apply loop does not wait on a per-block round trip.
     */
    verifyBlockWitnesses(block: Uint8Array): Promise<BlockWitnessResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (this.workers.length === 0) return Promise.resolve(runBlockWitnessJob({ kind: "blockWitnesses", block }));
        const worker = this.leastLoadedWorker();
        const weight = Math.max(1, Math.ceil(block.length / 16384));
        this.load.set(worker, (this.load.get(worker) ?? 0) + weight);
        const id = this.nextId++;
        return new Promise<BlockWitnessResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight });
            const copy = fresh(block);
            worker.postMessage({ id, job: { kind: "blockWitnesses", block: copy } }, [copy.buffer]);
        });
    }

    /**
     * Run a block's transaction rules (pure part) on a worker; the caller has
     * resolved the ledger inputs. Falls back inline without workers.
     */
    evaluateBlockRules(job: BlockRulesJob): Promise<BlockRulesResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (this.workers.length === 0) return runBlockRulesJob(job);
        // Shadow-only jobs are diagnostics nobody waits on: keep them off the reserved rules workers.
        const worker = this.leastLoadedWorker(job.phase === "shadow" ? "general" : "rules");
        const weight = Math.max(2, Math.ceil(job.block.length / 8192));
        this.load.set(worker, (this.load.get(worker) ?? 0) + weight);
        const id = this.nextId++;
        return new Promise<BlockRulesResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight });
            const copy = fresh(job.block);
            // Send params/genesis once per worker (see BlockRulesJob.paramsId).
            const ids = this.sharedIds(worker);
            const paramsId = job.params ? this.idOf(job.params) : undefined;
            const genesisId = job.genesis && typeof job.genesis === "object" ? this.idOf(job.genesis as object) : undefined;
            const slim: BlockRulesJob = { ...job, block: copy, paramsId, genesisId };
            if (paramsId != null && ids.params === paramsId) slim.params = null;
            if (genesisId != null && ids.genesis === genesisId) slim.genesis = null;
            if (paramsId != null) ids.params = paramsId;
            if (genesisId != null) ids.genesis = genesisId;
            worker.postMessage({ id, job: slim }, [copy.buffer]);
        });
    }

    /** Phase 2 of a mempool transaction (its Plutus scripts) on a worker; inline without workers. */
    evaluateMempoolPlutus(job: MempoolPlutusJob): Promise<MempoolPlutusResult> {
        if (this.closed) return Promise.reject(new Error("ValidationPool closed"));
        if (this.workers.length === 0) return runMempoolPlutusJob(job);
        const worker = this.leastLoadedWorker();
        const weight = 4;
        this.load.set(worker, (this.load.get(worker) ?? 0) + weight);
        const id = this.nextId++;
        return new Promise<MempoolPlutusResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker, weight });
            const tx = fresh(job.tx), bodyBytes = fresh(job.bodyBytes), witnessSetBytes = fresh(job.witnessSetBytes);
            worker.postMessage({ id, job: { ...job, tx, bodyBytes, witnessSetBytes } }, [tx.buffer, bodyBytes.buffer, witnessSetBytes.buffer]);
        });
    }

    private readonly objectIds = new WeakMap<object, number>();
    private nextObjectId = 1;
    private idOf(o: object): number {
        let id = this.objectIds.get(o);
        if (id == null) { id = this.nextObjectId++; this.objectIds.set(o, id); }
        return id;
    }
    private readonly shared = new WeakMap<Worker, { params?: number; genesis?: number }>();
    private sharedIds(w: Worker): { params?: number; genesis?: number } {
        let s = this.shared.get(w);
        if (!s) { s = {}; this.shared.set(w, s); }
        return s;
    }

    /** Validate many jobs concurrently, preserving order. */
    validateAll(jobs: HeaderValidationJob[]): Promise<HeaderValidationResult[]> {
        return Promise.all(jobs.map((j) => this.validate(j)));
    }

    stats(): { workers: number; pending: number } {
        return { workers: this.workers.length, pending: this.pending.size };
    }

    /** Heap sizes of every worker thread (diagnostics for memory growth outside the main heap). */
    memory(): Promise<Array<{ heapUsed: number; heapTotal: number; external: number }>> {
        if (this.closed || this.workers.length === 0) return Promise.resolve([]);
        return Promise.all(this.workers.map((worker) => new Promise<{ heapUsed: number; heapTotal: number; external: number }>((resolve) => {
            const id = this.nextId++;
            const timer = setTimeout(() => { this.pending.delete(id); resolve({ heapUsed: -1, heapTotal: -1, external: -1 }); }, 5000);
            this.pending.set(id, { resolve: (r: any) => { clearTimeout(timer); resolve(r); }, reject: () => { clearTimeout(timer); resolve({ heapUsed: -1, heapTotal: -1, external: -1 }); }, worker, weight: 0 } as any);
            worker.postMessage({ id, job: { kind: "memory" } });
        })));
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
