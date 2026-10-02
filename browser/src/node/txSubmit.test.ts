import { describe, expect, test } from "bun:test";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { TxSubmitClient, txIdOf } from "./txSubmit";
import { TxSubmissionResponder } from "../../../src/network/n2n/N2NTxSubmissionHost";
import { buildWithMinFee, generateKeyPair, txId } from "../../../src/pool/operator";

function sampleTx(seed: number): { hash: Uint8Array; bytes: Uint8Array } {
    const built = buildWithMinFee({
        inputs: [{ txHash: new Uint8Array(32).fill(seed), index: 0 }], outputs: [{ address: new Uint8Array(57).fill(1), lovelace: 5_000_000n }], changeIndex: 0,
        certificates: [], minFeeA: 44n, minFeeB: 155381n, keys: [generateKeyPair(new Uint8Array(32).fill(seed))],
    });
    return { hash: txId(built.body), bytes: built.tx };
}

/** The browser client wired to the relay's own responder core through a fake multiplexer. */
function pair() {
    const mempool = new Map<string, Uint8Array>();
    const r = new TxSubmissionResponder({ mempool: { getTxHashes: async () => [...mempool.keys()].map((h) => Buffer.from(h, "hex")), append: async (h, t) => { mempool.set(toHex(h), t); } }, era: () => 6, window: 5 });
    let deliver: ((b: Uint8Array) => void) | null = null;
    let chain = Promise.resolve();
    const mux: any = {
        on: (_p: number, cb: (b: Uint8Array) => void) => { deliver = cb; },
        off: () => { deliver = null; },
        send: (bytes: Uint8Array) => { chain = chain.then(async () => { for (const f of await r.receive(bytes)) deliver?.(f); }); },
    };
    const client = new TxSubmitClient(mux);
    return { client, mempool, responder: r, settle: async () => { for (let i = 0; i < 10; i++) { await chain; await new Promise((x) => setTimeout(x, 0)); } } };
}

describe("browser tx-submission client", () => {
    test("txIdOf is the body hash", () => {
        const a = sampleTx(3);
        expect(toHex(txIdOf(a.bytes))).toBe(toHex(a.hash));
    });

    test("the relay's blocking request waits; a submitted tx is announced, fetched, appended and acknowledged", async () => {
        const { client, mempool, responder, settle } = pair();
        await settle();
        expect(mempool.size).toBe(0); // init → blocking request, held by the client
        const a = sampleTx(1), b = sampleTx(2);
        expect(client.submit(a.bytes)).toBe(toHex(a.hash));
        await settle();
        expect([...mempool.keys()]).toEqual([toHex(a.hash)]);
        expect(client.list()).toEqual([]); // acknowledged in the next id request
        client.submit(b.bytes);
        await settle();
        expect(mempool.has(toHex(b.hash))).toBe(true);
        expect(responder.stats).toEqual({ announced: 2, fetched: 2, accepted: 2, rejected: 0 });
    });
});
