import { describe, expect, test } from "bun:test";
import { replyGetMeasuresBytes, replyGetSizesBytes } from "./LocalTxMonitorHost";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// cardano-node 11.0.1 preview relay, empty mempool, N2C v23 (2026-09-28): maxBlockBodySize 90112,
// maxBlockExUnits (77 500 000, 20 000 000 000), maxRefScriptSizePerBlock 1 MiB, all doubled.
describe("LocalTxMonitor replies (relay captures)", () => {
    const empty = {
        txCount: 0,
        bytes: { size: 0, capacity: 2 * (90112 - 1024) },
        exUnitsMemory: { size: 0n, capacity: 155_000_000n },
        exUnitsSteps: { size: 0n, capacity: 40_000_000_000n },
        referenceScriptsBytes: { size: 0, capacity: 2 * 1024 * 1024 },
    };
    test("MsgReplyGetMeasures", () => {
        expect(hex(replyGetMeasuresBytes(empty))).toBe("830c00a46f65785f756e6974735f6d656d6f727982001a093d1cc06e65785f756e6974735f737465707382001b00000009502f9000777265666572656e63655f736372697074735f627974657382001a00200000717472616e73616374696f6e5f627974657382001a0002b800");
    });
    test("MsgReplyGetSizes", () => {
        expect(hex(replyGetSizesBytes(empty))).toBe("820a831a0002b8000000");
    });
});
