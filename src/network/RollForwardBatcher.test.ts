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
});
