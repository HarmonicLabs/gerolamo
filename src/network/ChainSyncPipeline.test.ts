import { describe, expect, test } from "bun:test";
import { ChainSyncPipeline } from "./ChainSyncPipeline";

describe("ChainSyncPipeline", () => {
    test("fills to maxDepth while catching up and refills one per reply", () => {
        const p = new ChainSyncPipeline({ maxDepth: 8 });
        expect(p.toSend()).toBe(8);
        p.noteSent(8);
        expect(p.toSend()).toBe(0);
        p.noteReply(100_000n);
        expect(p.inFlight).toBe(7);
        expect(p.toSend()).toBe(1);
    });

    test("drops to depth 1 after MsgAwaitReply and stays there near the tip", () => {
        const p = new ChainSyncPipeline({ maxDepth: 32 });
        p.noteSent(32);
        p.noteAwaitReply();
        expect(p.isAtTip).toBe(true);
        expect(p.depth()).toBe(1);
        expect(p.toSend()).toBe(0); // 32 still outstanding; drain first
        for (let i = 0; i < 32; i++) p.noteReply(1n);
        expect(p.toSend()).toBe(1);
    });

    test("leaves tip mode when the peer's tip runs far ahead of what it sends", () => {
        const p = new ChainSyncPipeline({ maxDepth: 16 });
        p.noteAwaitReply();
        p.noteReply(5n);
        expect(p.depth()).toBe(1);
        p.noteReply(10_000n);
        expect(p.isAtTip).toBe(false);
        expect(p.depth()).toBe(16);
    });

    test("clamps depth and never goes negative", () => {
        expect(new ChainSyncPipeline({ maxDepth: 0 }).depth()).toBe(1);
        expect(new ChainSyncPipeline({ maxDepth: 9999 }).depth()).toBe(256);
        expect(new ChainSyncPipeline({ maxDepth: Number.NaN }).depth()).toBe(32);
        const p = new ChainSyncPipeline();
        p.noteReply();
        expect(p.inFlight).toBe(0);
        p.noteSent(3);
        p.reset();
        expect(p.inFlight).toBe(0);
        expect(p.isAtTip).toBe(false);
    });
});
