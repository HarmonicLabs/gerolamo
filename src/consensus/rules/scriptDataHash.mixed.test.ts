import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { costModelArrays, languageViews, witnessSlices } from "./scriptDataHash";

// Preview block at slot 11663879, tx 9: V1 and V2 scripts in one transaction. The
// language views map must be in canonical CBOR key order (V2's `01` before V1's `4100`).
describe("script data hash with V1 and V2 scripts in one transaction", () => {
    test("language views are canonically ordered and the hash matches the body", async () => {
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-11663879.hex", import.meta.url)).text()).trim(), "hex");
        const raw = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-params-134.json", import.meta.url)).text());
        const m: any = MultiEraBlock.fromCbor(blk);
        let root: any = Cbor.parse(blk, { keepRef: true } as any);
        if (root.array[0] instanceof CborUInt) root = root.array[1];
        const ws = root.array[2].array[9];
        const ref: any = ws.subCborRef ?? ws.cborRef;
        const wsBytes: Uint8Array = ref?.toBuffer ? ref.toBuffer() : Cbor.encode(ws).toBuffer();
        const body: any = m.block.transactionBodies[9];
        const expected = Buffer.from(body.scriptDataHash?.toBuffer?.() ?? body.scriptDataHash).toString("hex");
        const { redeemers, datums } = witnessSlices(wsBytes);
        const lv = languageViews(costModelArrays(raw), new Set([1, 2] as any))!;
        expect(Buffer.from(lv).toString("hex").startsWith("a201")).toBe(true); // V2 key first
        const h = Buffer.from(blake2b_256(Buffer.concat([Buffer.from(redeemers!), datums ? Buffer.from(datums) : Buffer.alloc(0), Buffer.from(lv)]))).toString("hex");
        expect(h).toBe(expected);
    });
});
