import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { bodyOutputBytes } from "./scriptDataHash";

describe("bodyOutputBytes", () => {
    test("slices each output out of the body's original bytes (preprod block at slot 10662793)", async () => {
        const hex = (await Bun.file(new URL("../__fixtures__/preprod-block-10662793.hex", import.meta.url)).text()).trim();
        const b: any = (MultiEraBlock.fromCbor(new Uint8Array(Buffer.from(hex, "hex"))) as any).block;
        const tx0 = b.transactionBodies[0], tx1 = b.transactionBodies[1];
        expect(bodyOutputBytes(tx0.cborRef.toBuffer())!.map((s) => s.length)).toEqual([43, 71]);
        // the decoder keeps no slice for this legacy-form output; the body slice is 2 bytes
        // shorter than the re-encoding, which is the difference between a halt and a pass
        expect(tx1.outputs[0].cborRef).toBeUndefined();
        expect(bodyOutputBytes(tx1.cborRef.toBuffer())![0]!.length).toBe(120);
        expect(tx1.outputs[0].toCborBytes().length).toBe(122);
    });
});
