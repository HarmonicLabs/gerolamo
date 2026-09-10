import { describe, expect, test } from "bun:test";
import { AnnounceWindow, encodeInit, encodeReplyTxIds, encodeReplyTxs, hashBytes, parseTxSubmissionMessages } from "./txSubmissionCodec";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("tx-submission2 codec (as cardano-node speaks it)", () => {
    test("a blocking id request decodes with its CBOR boolean and counts", () => {
        expect(parseTxSubmissionMessages(Buffer.from("8400f50003", "hex"))).toEqual([{ kind: "requestTxIds", blocking: true, ack: 0, req: 3 }]);
        expect(parseTxSubmissionMessages(Buffer.from("8400f40103", "hex"))).toEqual([{ kind: "requestTxIds", blocking: false, ack: 1, req: 3 }]);
    });
    test("a transaction request carries era-tagged ids in an indefinite list, possibly followed by the next id request", () => {
        const chunk = Buffer.from("82029f82065820" + "ab".repeat(32) + "ff" + "8400f40003", "hex");
        const msgs = parseTxSubmissionMessages(chunk);
        expect(msgs).toHaveLength(2);
        expect(msgs[0]!.kind).toBe("requestTxs");
        expect(hex((msgs[0] as any).ids[0])).toBe("ab".repeat(32));
        expect(msgs[1]).toEqual({ kind: "requestTxIds", blocking: false, ack: 0, req: 3 });
    });
    test("id and transaction replies use [era, …] items in indefinite lists; init is [6]", () => {
        const id = new Uint8Array(32).fill(0xcd);
        expect(hex(encodeReplyTxIds(6, [{ hash: id, size: 670 }]))).toBe("81".replace("81", "82") + "01" + "9f" + "82" + "82065820" + "cd".repeat(32) + "19029e" + "ff");
        expect(hex(encodeReplyTxs(6, [new Uint8Array([0x84, 0x00])]))).toBe("8203" + "9f" + "8206" + "d818" + "428400" + "ff");
        expect(hex(encodeInit())).toBe("8106");
    });
    test("mempool hashes given as an Int32Array view are the underlying 32 bytes", () => {
        const bytes = new Uint8Array(32); for (let i = 0; i < 32; i++) bytes[i] = i;
        const view = new Int32Array(bytes.buffer, 0, 8);
        expect(hex(hashBytes(view))).toBe(hex(bytes));
        expect(hashBytes(bytes)).toBe(bytes);
    });
});

describe("announce window", () => {
    test("an id is announced to a peer once per connection, acknowledged or not", () => {
        const w = new AnnounceWindow();
        expect(w.fresh(["a", "b", "c"])).toEqual(["a", "b", "c"]);
        w.announce(["a", "b"]);
        expect(w.outstanding).toBe(2);
        expect(w.fresh(["a", "b", "c"])).toEqual(["c"]);
        w.acknowledge(2); // the peer acknowledged a and b: still never announced again
        expect(w.outstanding).toBe(0);
        expect(w.fresh(["a", "b", "c"])).toEqual(["c"]);
        w.announce(["c"]); w.acknowledge(5); // over-acknowledging is harmless
        expect(w.fresh(["a", "b", "c", "d"])).toEqual(["d"]);
    });
});
