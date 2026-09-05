import { describe, expect, test } from "bun:test";
import { RollForwardBatcher } from "./RollForwardBatcher";

describe("RollForwardBatcher", () => {
    test("flushes one bounded FIFO batch at maxItems", async () => {
        const batches: number[][] = [];
        const batcher = new RollForwardBatcher<number>({
            maxItems: 3,
            flushMs: 1_000,
            onBatch: async (items) => {
                batches.push(items);
            },
        });

        await batcher.push(1);
        await batcher.push(2);
        await batcher.push(3);

        expect(batches).toEqual([[1, 2, 3]]);
        expect(batcher.size).toBe(0);
        batcher.dispose();
    });

    test("flushes a partial live-tail batch after the deadline", async () => {
        const batches: number[][] = [];
        const batcher = new RollForwardBatcher<number>({
            maxItems: 32,
            flushMs: 10,
            onBatch: async (items) => {
                batches.push(items);
            },
        });

        await batcher.push(7);
        await batcher.push(8);
        await Bun.sleep(30);

        expect(batches).toEqual([[7, 8]]);
        batcher.dispose();
    });

    test("serializes flushes and discards queued items on reset", async () => {
        const batches: number[][] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const batcher = new RollForwardBatcher<number>({
            maxItems: 2,
            flushMs: 1_000,
            onBatch: async (items) => {
                batches.push(items);
                if (items[0] === 1) await held;
            },
        });

        const first = batcher.push(1);
        const firstFlush = batcher.push(2);
        await Bun.sleep(0);
        await batcher.push(3);
        batcher.reset();
        release();
        await first;
        await firstFlush;
        await batcher.drain();

        expect(batches).toEqual([[1, 2]]);
        expect(batcher.size).toBe(0);
        batcher.dispose();
    });

    test("holds pushes while more than maxQueuedBatches batches wait for consensus", async () => {
        const started: number[][] = [];
        let release: (() => void) | null = null;
        const batcher = new RollForwardBatcher<number>({
            maxItems: 2,
            flushMs: 1000, // no deadline flush during the test: only full batches chain
            maxQueuedBatches: 1,
            onBatch: async (items) => {
                started.push(items);
                await new Promise<void>((r) => { release = r; });
            },
        });
        // batch 1 fills and starts (blocked inside onBatch); batch 2 chains behind it
        void batcher.push(1); void batcher.push(2);
        void batcher.push(3); void batcher.push(4);
        await Promise.resolve();
        expect(batcher.queued).toBe(2);
        // a push that does not fill a batch must now wait for room
        let resolved = false;
        const held = batcher.push(5).then(() => { resolved = true; });
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(false);
        // consensus finishes batch 1 → one batch queued → room
        release!();
        await new Promise((r) => setTimeout(r, 5));
        expect(resolved).toBe(true);
        await held;
        expect(started[0]).toEqual([1, 2]);
        batcher.dispose();
    });

    test("dispose releases held pushes", async () => {
        const batcher = new RollForwardBatcher<number>({
            maxItems: 1,
            flushMs: 0,
            maxQueuedBatches: 1,
            onBatch: () => new Promise<void>(() => {}),
        });
        void batcher.push(1); void batcher.push(2); void batcher.push(3);
        const held = batcher.whenRoom();
        batcher.dispose();
        await held;
        expect(batcher.queued).toBe(3);
    });
});
