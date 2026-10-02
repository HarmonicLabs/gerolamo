import { describe, expect, test } from "bun:test";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { TxSubmissionResponder } from "./N2NTxSubmissionHost";
import { encodeInit, encodeReplyTxIds, encodeReplyTxs, parseTxSubmissionMessages } from "../txSubmissionCodec";
import { buildWithMinFee, generateKeyPair, txId } from "../../pool/operator";

// A real Conway transaction (the same builder the pool tooling uses), so `Tx.fromCbor` validates it.
function sampleTx(seed: number): { hash: Uint8Array; bytes: Uint8Array } {
    const built = buildWithMinFee({
        inputs: [{ txHash: new Uint8Array(32).fill(seed), index: 0 }], outputs: [{ address: new Uint8Array(57).fill(1), lovelace: 5_000_000n }], changeIndex: 0,
        certificates: [], minFeeA: 44n, minFeeB: 155381n, keys: [generateKeyPair(new Uint8Array(32).fill(seed))],
    });
    return { hash: txId(built.body), bytes: built.tx };
}

class FakeMempool {
    readonly txs = new Map<string, Uint8Array>();
    async getTxHashes() { return [...this.txs.keys()].map((h) => Buffer.from(h, "hex")); }
    async append(hash: Uint8Array, tx: Uint8Array) { this.txs.set(toHex(hash), tx); return { status: 0 }; }
}

describe("inbound tx-submission responder", () => {
    test("init → blocking id request; announced ids we lack are fetched, validated and appended; acknowledged next round", async () => {
        const mempool = new FakeMempool();
        const r = new TxSubmissionResponder({ mempool, era: () => 6, window: 5 });
        const a = sampleTx(1), b = sampleTx(2);
        mempool.txs.set(toHex(b.hash), b.bytes); // already held: must not be requested

        const first = await r.receive(encodeInit());
        expect(first.map((f) => parseTxSubmissionMessages(f)[0])).toEqual([{ kind: "requestTxIds", blocking: true, ack: 0, req: 5 }]);
        expect(await r.receive(encodeInit())).toHaveLength(0); // a second init is ignored

        const second = await r.receive(encodeReplyTxIds(6, [{ hash: a.hash, size: a.bytes.length }, { hash: b.hash, size: b.bytes.length }]));
        expect(second).toHaveLength(1);
        const req = parseTxSubmissionMessages(second[0]!)[0] as any;
        expect(req.kind).toBe("requestTxs");
        expect(req.ids.map(toHex)).toEqual([toHex(a.hash)]);
        expect(toHex(second[0]!).startsWith("82029f8206")).toBe(true); // [2, 9f [6, hash] … ff]

        const third = await r.receive(encodeReplyTxs(6, [a.bytes]));
        expect(mempool.txs.has(toHex(a.hash))).toBe(true);
        expect(parseTxSubmissionMessages(third[0]!)[0]).toEqual({ kind: "requestTxIds", blocking: true, ack: 2, req: 5 });
        expect(r.stats).toEqual({ announced: 2, fetched: 1, accepted: 1, rejected: 0 });
    });

    test("a body that does not hash to a requested id, a malformed body and an oversized announcement are rejected", async () => {
        const mempool = new FakeMempool();
        const r = new TxSubmissionResponder({ mempool, era: () => 6, window: 3, maxTxBytes: 16_384 });
        await r.receive(encodeInit());
        const a = sampleTx(3), c = sampleTx(4);
        const out = await r.receive(encodeReplyTxIds(6, [{ hash: a.hash, size: a.bytes.length }, { hash: c.hash, size: 20_000 }]));
        const req = parseTxSubmissionMessages(out[0]!)[0] as any;
        expect(req.ids.map(toHex)).toEqual([toHex(a.hash)]); // the oversized one is skipped
        await r.receive(encodeReplyTxs(6, [c.bytes, new Uint8Array([0x00, 0x01]), a.bytes]));
        expect([...mempool.txs.keys()]).toEqual([toHex(a.hash)]);
        expect(r.stats.rejected).toBe(2);
        expect(r.stats.accepted).toBe(1);
    });

    test("an empty announcement just asks again, acknowledging nothing new; done stops the exchange", async () => {
        const r = new TxSubmissionResponder({ mempool: new FakeMempool(), era: () => 6 });
        await r.receive(encodeInit());
        const out = await r.receive(encodeReplyTxIds(6, []));
        expect(parseTxSubmissionMessages(out[0]!)[0]).toEqual({ kind: "requestTxIds", blocking: true, ack: 0, req: 10 });
        expect(await r.receive(Buffer.from("8104", "hex"))).toHaveLength(0);
        expect(await r.receive(encodeReplyTxIds(6, []))).toHaveLength(0);
    });

    test("with ledger admission the validating mempool decides; a ledger rejection is dropped without a reply", async () => {
        const mempool = new FakeMempool();
        const seen: string[] = [];
        const a = sampleTx(5), b = sampleTx(6);
        const r = new TxSubmissionResponder({
            mempool, era: () => 6, window: 4,
            admit: async (bytes) => { seen.push(toHex(bytes)); return toHex(bytes) === toHex(a.bytes) ? { ok: true } : { ok: false, reason: "BadInputsUTxO" }; },
        });
        await r.receive(encodeInit());
        await r.receive(encodeReplyTxIds(6, [{ hash: a.hash, size: a.bytes.length }, { hash: b.hash, size: b.bytes.length }]));
        const next = await r.receive(encodeReplyTxs(6, [a.bytes, b.bytes]));
        expect(seen).toEqual([toHex(a.bytes), toHex(b.bytes)]);
        expect(mempool.txs.size).toBe(0); // the admission path stores, not the raw append
        expect(r.stats).toEqual({ announced: 2, fetched: 2, accepted: 1, rejected: 1 });
        expect(parseTxSubmissionMessages(next[0]!)[0]).toEqual({ kind: "requestTxIds", blocking: true, ack: 2, req: 4 });
    });
});
