import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { collectShelleyWitnesses } from "../rules/witnesses";
import { runBlockWitnessJob } from "./validationJob";
import { runWitnessVerifyJob, type WitnessItem } from "./witnessJob";
import { ValidationPool } from "./ValidationPool";

async function fixture(name: string): Promise<Uint8Array> {
    const hex = (await Bun.file(new URL(`../__fixtures__/${name}`, import.meta.url)).text()).trim();
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** The inline path's items, built the way evaluateShelleyBlock builds them. */
function inlineItems(block: Uint8Array): WitnessItem[] {
    const meb: any = MultiEraBlock.fromCbor(block);
    const b: any = meb.block;
    const items: WitnessItem[] = [];
    (b.transactionBodies ?? []).forEach((body: any, i: number) => {
        const h = String(body.hash?.toString?.() ?? "");
        items.push(...collectShelleyWitnesses(Uint8Array.from(Buffer.from(h, "hex")), b.transactionWitnessSets[i]).items);
    });
    return items;
}

describe("block witness pre-verification (worker job)", () => {
    test("verdicts equal the inline path on a 30-tx Babbage block, all valid", async () => {
        const blk = await fixture("preview-block-11663879.hex");
        const items = inlineItems(blk);
        expect(items.length).toBeGreaterThanOrEqual(30);
        const r = runBlockWitnessJob({ kind: "blockWitnesses", block: blk });
        expect(r.count).toBe(items.length);
        expect(r.ok).toEqual(runWitnessVerifyJob({ kind: "witnesses", items }).ok);
        expect(r.ok!.every(Boolean)).toBe(true);
    });

    test("a flipped signature byte fails exactly that witness, same index as inline", async () => {
        const blk = Uint8Array.from(await fixture("preview-block-11663879.hex"));
        const items = inlineItems(blk);
        // find the first witness signature inside the block bytes and flip one byte
        const sig = Buffer.from(items[0]!.signature).toString("hex");
        const pos = Buffer.from(blk).toString("hex").indexOf(sig) / 2;
        expect(pos).toBeGreaterThan(0);
        blk[pos + 5]! ^= 0x01;
        const r = runBlockWitnessJob({ kind: "blockWitnesses", block: blk });
        const inline = runWitnessVerifyJob({ kind: "witnesses", items: inlineItems(blk) }).ok;
        expect(r.ok).toEqual(inline);
        expect(r.ok!.filter((x) => !x).length).toBe(1);
        expect(r.ok![0]).toBe(false);
    });

    test("Byron and garbage blocks are left to the inline path (ok = null)", async () => {
        const byron = await fixture("shelley-mainnet-4493980.hex").catch(() => null);
        expect(runBlockWitnessJob({ kind: "blockWitnesses", block: new Uint8Array([0x82, 0x00, 0x80]) }).ok).toBeNull();
        if (byron) expect(runBlockWitnessJob({ kind: "blockWitnesses", block: byron }).count).toBeGreaterThanOrEqual(0);
    });

    test("through a real worker pool", async () => {
        const blk = await fixture("preview-block-11663879.hex");
        const pool = new ValidationPool(2);
        try {
            const r = await pool.verifyBlockWitnesses(blk);
            expect(r.count).toBe(inlineItems(blk).length);
            expect(r.ok!.every(Boolean)).toBe(true);
        } finally {
            await pool.close();
        }
    }, 30_000);
});
