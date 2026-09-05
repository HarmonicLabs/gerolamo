export interface RollForwardBatcherOptions<T> {
    maxItems: number;
    flushMs: number;
    onBatch: (items: T[]) => Promise<void>;
    onError?: (error: unknown) => void;
    /**
     * Back-pressure: `push` resolves late while more than this many batches are
     * chained ahead of consensus (default 2). Without it every header that does
     * not fill a batch resolved at once, the ChainSync pipeline stayed topped up
     * and the flush chain grew by the peer's whole surplus over the apply rate
     * (14 000 headers retained per 10 minutes on mainnet Byron, a 24 GB OOM).
     */
    maxQueuedBatches?: number;
}

/**
 * Bounded FIFO used between ChainSync headers and consensus BlockFetch work.
 * Only one onBatch callback runs at a time; reset drops queued, not in-flight, work.
 */
export class RollForwardBatcher<T> {
    private readonly maxItems: number;
    private readonly flushMs: number;
    private readonly onBatch: (items: T[]) => Promise<void>;
    private readonly onError?: (error: unknown) => void;
    private readonly items: T[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private flushChain: Promise<void> = Promise.resolve();
    private disposed = false;
    private readonly maxQueuedBatches: number;
    /** Batches chained onto flushChain that have not finished. */
    private queuedBatches = 0;
    private roomWaiters: Array<() => void> = [];

    constructor(options: RollForwardBatcherOptions<T>) {
        if (!Number.isInteger(options.maxItems) || options.maxItems < 1) {
            throw new Error("RollForwardBatcher maxItems must be a positive integer");
        }
        if (!Number.isFinite(options.flushMs) || options.flushMs < 0) {
            throw new Error("RollForwardBatcher flushMs must be non-negative");
        }
        this.maxItems = options.maxItems;
        this.flushMs = options.flushMs;
        this.onBatch = options.onBatch;
        this.onError = options.onError;
        const q = options.maxQueuedBatches ?? 2;
        if (!Number.isInteger(q) || q < 1) {
            throw new Error("RollForwardBatcher maxQueuedBatches must be a positive integer");
        }
        this.maxQueuedBatches = q;
    }

    /** Batches waiting for (or inside) onBatch. */
    get queued(): number {
        return this.queuedBatches;
    }

    /** Resolves once fewer than maxQueuedBatches batches are chained (or on reset/dispose). */
    whenRoom(): Promise<void> {
        if (this.queuedBatches <= this.maxQueuedBatches || this.disposed) return Promise.resolve();
        return new Promise<void>((resolve) => this.roomWaiters.push(resolve));
    }

    private releaseRoom(): void {
        if (this.roomWaiters.length === 0) return;
        if (this.queuedBatches > this.maxQueuedBatches && !this.disposed) return;
        const waiters = this.roomWaiters;
        this.roomWaiters = [];
        for (const w of waiters) w();
    }

    get size(): number {
        return this.items.length;
    }

    push(item: T): Promise<void> {
        if (this.disposed) {
            return Promise.reject(new Error("RollForwardBatcher is disposed"));
        }
        this.items.push(item);
        if (this.items.length >= this.maxItems) {
            return this.flush();
        }
        this.schedule();
        // Hold the caller (and with it the ChainSync top-up) while consensus is behind.
        return this.whenRoom();
    }

    flush(): Promise<void> {
        this.clearTimer();
        if (this.items.length === 0) return this.flushChain;

        const batch = this.items.splice(0, this.maxItems);
        this.queuedBatches++;
        const done = () => {
            this.queuedBatches--;
            this.releaseRoom();
        };
        const run = this.flushChain.then(() => this.onBatch(batch));
        this.flushChain = run.then(done, done);
        if (this.items.length > 0) this.schedule();
        return run;
    }

    async drain(): Promise<void> {
        while (this.items.length > 0) {
            await this.flush();
        }
        await this.flushChain;
    }

    reset(): void {
        this.clearTimer();
        this.items.length = 0;
    }

    dispose(): void {
        this.reset();
        this.disposed = true;
        this.releaseRoom();
    }

    private schedule(): void {
        if (this.timer || this.items.length === 0 || this.disposed) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch((error) => this.onError?.(error));
        }, this.flushMs);
    }

    private clearTimer(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
