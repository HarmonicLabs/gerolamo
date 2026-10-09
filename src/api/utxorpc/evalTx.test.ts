import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { cardano } from "@utxorpc/spec";
import { outputLike } from "../../consensus/rules/blockRulesPure";
import { epochParamsFromRecord } from "../../consensus/epochParams";
import { setEpochNetwork } from "../../utils/epochFromSlotCalculations";
import type { ResolvedUtxo } from "../../consensus/rules/resolvedUtxo";
import { evalTx } from "./submit";
import { bigIntValue, txFromBytes } from "./mapper";
import type { UtxorpcProvider } from "./provider";

const FIX = new URL("../../consensus/__fixtures__/", import.meta.url).pathname;

/** A provider that knows only what EvalTx reads: the spent outputs and the parameters of a replayed preview transaction. */
function fixture(name: string, opts: { zeroUnits?: boolean } = {}) {
    const job = JSON.parse(readFileSync(FIX + name, "utf8"));
    setEpochNetwork(job.network);
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, h] of job.resolved as Array<[string, string]>) {
        const o = outputLike(TxOut.fromCbor(h));
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    }
    let wit = Buffer.from(job.witnessHex, "hex");
    if (opts.zeroUnits) wit = Buffer.from(job.witnessHex.replace("821a001768ea1a1be5eaa6", "820000"), "hex"); // the declared [mem, steps] → [0, 0], as a builder sends before evaluating
    const tx = Buffer.concat([Buffer.of(0x84), Buffer.from(job.bodyHex, "hex"), wit, Buffer.of(job.valid ? 0xf5 : 0xf4), Buffer.of(0xf6)]);
    // the fixture keeps only what phase 2 reads; the fee parameters come from a stored preview record (unchanged since)
    const fees = JSON.parse(readFileSync(FIX + "preview-params-841.json", "utf8"));
    job.params = { ...fees, ...job.params, cost_models: job.params.cost_models };
    const p = { evalContext: async () => ({ params: epochParamsFromRecord(0, job.params), resolved, network: job.network }) } as unknown as UtxorpcProvider;
    return { job, tx, p };
}

describe("EvalTx with the node's Plutus evaluator", () => {
    test("a Plutus V2 spend (preview 124008114): the measured units equal aiken's, fee covers size and scripts", async () => {
        const { tx, p, job } = fixture("plutus-preview-124008114-0.json");
        const r = await evalTx(p, tx);
        expect(r.errors).toEqual([]);
        expect(r.redeemers.length).toBeGreaterThan(0);
        const red = r.redeemers.find((x) => x.index === 0)!;
        expect(red.purpose).toBe(cardano.RedeemerPurpose.SPEND);
        expect(red.exUnits).toMatchObject({ steps: 468052646n, memory: 1534186n });
        expect(r.exUnits!.steps).toBe(r.redeemers.reduce((a, x) => a + x.exUnits!.steps, 0n));
        // at least the size part, at most what the transaction paid (it was valid on chain)
        const fee = bigIntValue(r.fee), n = (v: unknown) => BigInt(Math.trunc(Number(v)));
        expect(fee).toBeGreaterThan(n(job.params.min_fee_a) * BigInt(tx.length) + n(job.params.min_fee_b));
        const paid = txFromBytes(tx).fee;
        expect(fee).toBeLessThanOrEqual(bigIntValue(paid));
        expect(red.payload).toBeDefined();
    });

    test("declared units of zero do not cap the evaluation (the budget is the transaction maximum)", async () => {
        const { job } = fixture("plutus-preview-124008114-0.json");
        if (!String(job.witnessHex).includes("821a001768ea1a1be5eaa6")) return; // fixture layout changed: nothing to rewrite
        const { tx, p } = fixture("plutus-preview-124008114-0.json", { zeroUnits: true });
        const r = await evalTx(p, tx);
        expect(r.redeemers.find((x) => x.index === 0)!.exUnits).toMatchObject({ steps: 468052646n, memory: 1534186n });
        expect(r.errors).toEqual([]);
    });
});
