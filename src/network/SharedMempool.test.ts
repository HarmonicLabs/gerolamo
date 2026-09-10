import { describe, expect, test } from "bun:test";
import { GlobalSharedMempool } from "./SharedMempool";

describe("shared mempool", () => {
    test("the global mempool accepts a transaction (its buffer is initialised, not just allocated)", async () => {
        const mempool = GlobalSharedMempool.getInstance();
        expect(await mempool.getAvailableSpace()).toBeGreaterThan(0);
        const hash = new Uint8Array(32).fill(0x5a);
        const tx = new Uint8Array(300).fill(0x84);
        const r = await mempool.append(hash, tx);
        expect(Number(r.status)).toBe(0); // MempoolAppendStatus.Ok
        expect(r.nTxs).toBe(1);
        expect((await mempool.getTxHashes()).length).toBe(1);
    });
});
