/**
 * The shadow evaluator's builtin cost trace (GEROLAMO_PLUTUS_TRACE=1) records every
 * builtin charge of the last evaluation; the fixture block's transactions evaluate
 * within their declared budgets offline.
 */
process.env.GEROLAMO_PLUTUS_TRACE = "1";
process.env.GEROLAMO_PLUTUS_SHADOW_MS = "120000";
process.env.GEROLAMO_PLUTUS_LEGACY_SHADOW = "1"; // this test pins the legacy evaluator's builtin trace
import { describe, expect, test } from "bun:test";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { resolvedFromRow, type ResolvedUtxo } from "./resolvedUtxo";

describe("Plutus shadow builtin trace", () => {
    test("preview block 72702137 tx 12 evaluates within budget and the trace lists its builtins", async () => {
        // dynamic import: the env flag must be set before the module evaluates (static imports hoist)
        const { lastTraceSummary, setShadowTrace, shadowEvaluateTx } = await import("./plutusEval");
        setShadowTrace(1); // another test file may have loaded the module without the env flag
        const blk = Buffer.from((await Bun.file(new URL("../__fixtures__/preview-block-72702137.hex", import.meta.url)).text()).trim(), "hex");
        const m: any = MultiEraBlock.fromCbor(blk);
        const inputs = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-block-72702137-inputs.json", import.meta.url)).text());
        const raw = JSON.parse(await Bun.file(new URL("../__fixtures__/preview-params-841.json", import.meta.url)).text());
        const genesis = JSON.parse(await Bun.file(new URL("../../config/preview/shelley-genesis.json", import.meta.url)).text());
        const resolved = new Map<string, ResolvedUtxo>();
        for (const [r, v] of Object.entries<any>(inputs)) resolved.set(r, resolvedFromRow({ utxo_ref: r, ...v }));
        const body = m.block.transactionBodies[12]; const ws = m.block.transactionWitnessSets[12];
        const ev = await shadowEvaluateTx({ forceSample: true, era: 7, body, witnessSet: ws, bodyBytes: body.cborRef?.toBuffer?.() ?? null, witnessSetBytes: ws.cborRef?.toBuffer?.() ?? null, resolved, params: { raw } as any, genesis, network: "preview", markedInvalid: false });
        expect(ev.evaluated).toBe(2);
        expect(ev.mismatch).toBeNull();
        const trace = lastTraceSummary();
        expect(trace).toContain("equalsData×");
        expect(trace).toContain("headList×");
    });
});
