import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyOverlay, evaluateShelleyBlockWithInputs, shelleyBlockOverlay, shelleyBlockReads } from "../rules/blockRulesPure";
import { runBlockRulesJob } from "./validationJob";
import { ValidationPool } from "./ValidationPool";

async function fixture(name: string): Promise<Uint8Array> {
    const hex = (await Bun.file(new URL(`../__fixtures__/${name}`, import.meta.url)).text()).trim();
    return Uint8Array.from(Buffer.from(hex, "hex"));
}
const genesis = await Bun.file("src/config/preview/shelley-genesis.json").json();
const params = { epoch: 134, minFeeA: 44n, minFeeB: 155381n, maxTxSize: 16384, maxBlockSize: 90112, maxBlockHeaderSize: 1100, collateralPercent: 150, maxCollateralInputs: 3, maxValSize: 5000, protocolMajor: 8, raw: {} };

describe("block rules in a worker (pure part)", () => {
    test("worker result equals the main-thread evaluation for the same inputs", async () => {
        const blk = await fixture("preview-block-11663879.hex");
        const meb: any = MultiEraBlock.fromCbor(blk);
        // no resolved inputs on purpose: every tx reports missing inputs identically on both paths
        const inputs = { resolved: new Map(), pools: new Set<string>(), rewardBalances: undefined };
        const ctx = { config: { network: "preview", networkMagic: 2 }, pool: null, params, genesis, slot: BigInt(String(meb.block.header.body.slot)), preVerified: null };
        const main = await evaluateShelleyBlockWithInputs(meb, ctx, inputs);
        const job = { kind: "blockRules" as const, block: blk, slot: String(meb.block.header.body.slot), params, genesis, config: ctx.config, resolved: new Map(), pools: new Set<string>(), rewardBalances: null, preVerified: null };
        const direct = await runBlockRulesJob(job);
        expect(direct.outcome).not.toBeNull();
        expect(direct.outcome!.txs).toBe(main.txs);
        expect(direct.outcome!.failures).toEqual(main.failures);
        expect(direct.outcome!.witnessesVerified).toBe(main.witnessesVerified);
        const pool = new ValidationPool(2);
        try {
            const viaWorker = await pool.evaluateBlockRules({ ...job, block: Uint8Array.from(blk) });
            expect(viaWorker.outcome).not.toBeNull();
            expect(viaWorker.outcome!.failures).toEqual(main.failures);
            expect(viaWorker.outcome!.reports.length).toBe(main.reports.length);
        } finally {
            pool.close();
        }
    }, 60_000);

    test("overlay: a block's outputs and spends feed the next block's inputs", async () => {
        const blk = await fixture("preview-block-11663879.hex");
        const meb: any = MultiEraBlock.fromCbor(blk);
        const ov = shelleyBlockOverlay(meb);
        const bodies: any[] = meb.block.transactionBodies;
        const outputs = bodies.reduce((n, b) => n + (b.outputs?.length ?? 0), 0);
        const inputsN = bodies.reduce((n, b) => n + (b.inputs?.length ?? 0), 0);
        expect(ov.created.size).toBe(outputs);
        expect(ov.spent.size).toBeLessThanOrEqual(inputsN);
        expect(ov.spent.size).toBeGreaterThan(0);
        // reads of the block itself: its own inputs; applying the overlay of the same block removes what it spent and adds what it created
        const reads = shelleyBlockReads(meb);
        const base = { resolved: new Map(), pools: new Set<string>(), rewardBalances: undefined };
        const next = applyOverlay(base, ov);
        const createdAndSpent = [...ov.created.keys()].filter((r) => ov.spent.has(r)).length;
        expect(next.resolved.size).toBe(ov.created.size - createdAndSpent);
        for (const r of ov.spent) expect(next.resolved.has(r)).toBe(false);
        expect(reads.refs.size).toBeGreaterThan(0);
    });
});
