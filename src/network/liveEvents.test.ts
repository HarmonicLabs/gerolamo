import { describe, expect, test } from "bun:test";
import { emitMempool, setMempoolListener } from "./liveEvents";

describe("liveEvents mempool", () => {
    test("a burst of mempool changes coalesces into one listener call", async () => {
        let calls = 0;
        setMempoolListener(() => { calls++; });
        emitMempool();
        emitMempool();
        emitMempool();
        await new Promise((r) => setTimeout(r, 350));
        expect(calls).toBe(1);
        setMempoolListener(null);
    });
});
