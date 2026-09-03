export interface RollForwardBatcherOptions<T> {
    maxItems: number;
    flushMs: number;
    onBatch: (items: T[]) => Promise<void>;
    onError?: (error: unknown) => void;
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
        return Promise.resolve();
    }

    flush(): Promise<void> {
        this.clearTimer();
        if (this.items.length === 0) return this.flushChain;

        const batch = this.items.splice(0, this.maxItems);
        const run = this.flushChain.then(() => this.onBatch(batch));
        this.flushChain = run.then(
            () => undefined,
            () => undefined,
        );
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
