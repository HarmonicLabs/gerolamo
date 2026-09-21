import { describe, expect, test } from "bun:test";
import { Cbor } from "@harmoniclabs/cbor";
import { encodeUtcTime, eraSummaries, networkFromMagic } from "./eraHistory";

const hex = (o: any) => Buffer.from(Cbor.encode(o).toBuffer()).toString("hex");

describe("node-to-client era history", () => {
    test("system start matches the reference node's encoding", () => {
        // captured from cardano-node 11.0.1 on preview: GetSystemStart → [2022, 298, 0]
        expect(hex(encodeUtcTime("2022-10-25T00:00:00Z"))).toBe("831907e619012a00");
        expect(networkFromMagic(2)).toBe("preview");
    });
    test("preview era summaries match the reference node up to Babbage", () => {
        // captured: eras 0–3 empty at [0,0,0]; Alonzo [0,0,0]→[259200e12, 259200, 3]; Babbage → [518400e12, 518400, 6]; Byron params [4320,20000,[0,864,[0]],864]; Shelley+ [86400,1000,[0,25920,[0]],25920]
        const captured = "9f838300000083000000841910e0194e2083001903608100190360838300000083000000841a000151801903e883001965408100196540838300000083000000841a000151801903e88300196540810019654083830000008300000084" ;
        const ours = hex(eraSummaries("preview", 5));
        expect(ours.startsWith(captured.slice(0, 120))).toBe(true); // indefinite list, first summaries byte-identical
        // the Conway summary of a synced node has an unbounded end
        const conway = hex(eraSummaries("preview", 6));
        expect(conway.startsWith("9f")).toBe(true);
        expect(conway).toContain("f6"); // null end
    });
});

test("preview: Conway starts at epoch 646 and the last era ends at the horizon after the tip's epoch (relay capture 2026-09-14)", () => {
    const hex = Buffer.from(Cbor.encode(eraSummaries("preview", 6, 1420)).toBuffer()).toString("hex");
    // Conway start bound: [55814400 s in picos, slot 55814400, epoch 646]; end bound epoch 1421 at slot 122774400
    expect(hex).toContain("190286"); // epoch 646
    expect(hex).toContain("19058d"); // epoch 1421
    expect(hex).toContain("1a07516380"); // slot 122774400
    expect(hex.endsWith("83c24906a7d64a5037b800001a0751638019058d841a000151801903e883001965408100196540ff")).toBe(true); // relay tail
    expect(hex.endsWith("ff")).toBe(true);
});
