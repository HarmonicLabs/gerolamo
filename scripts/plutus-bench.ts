#!/usr/bin/env bun
/**
 * Before/after timing of phase-2 evaluation on dumped replay jobs: the previous shadow evaluator
 * (plutus-machine + buildooor contexts) against rules/phase2.ts, same transactions.
 *   bun scripts/plutus-bench.ts <job.json>... [--runs 3] [--no-old]
 */
import { readFileSync } from "node:fs";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { outputLike } from "../src/consensus/rules/blockRulesPure";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { evaluatePhase2Sync } from "../src/consensus/rules/phase2";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";

process.env.GEROLAMO_PLUTUS_SHADOW_MS ??= "600000";
process.env.GEROLAMO_PLUTUS_SHADOW_MAX_CPU ??= "100000000000";
process.env.GEROLAMO_PLUTUS_SHADOW_STEP_CPU ??= "100000000000";
const { shadowEvaluateTxLegacy: shadowEvaluateTx } = await import("../src/consensus/rules/plutusEval");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.endsWith(".json"));
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] ?? 3) || 3;
const noOld = process.argv.includes("--no-old");
for (const f of files) {
    const job = JSON.parse(readFileSync(f, "utf8"));
    setEpochNetwork(job.network);
    const resolved = new Map<string, ResolvedUtxo>();
    for (const [ref, h] of job.resolved) {
        const o = outputLike(TxOut.fromCbor(h));
        resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
    }
    const params = job.params ? epochParamsFromRecord(0, job.params) : null;
    const input = { era: job.era, bodyBytes: Buffer.from(job.bodyHex, "hex"), witnessSetBytes: Buffer.from(job.witnessHex, "hex"), resolved, params, markedInvalid: !job.valid };
    let best = Infinity, r: any;
    for (let k = 0; k < runs; k++) { const t = performance.now(); r = evaluatePhase2Sync(input); best = Math.min(best, performance.now() - t); }
    const cpu = r.redeemers.reduce((s: bigint, x: any) => s + (x.spent?.cpu ?? 0n), 0n);
    let old = "";
    if (!noOld) {
        const t = performance.now();
        const ev = await shadowEvaluateTx({ forceSample: true, era: job.era, body: null, witnessSet: { redeemers: [1] }, bodyBytes: input.bodyBytes, witnessSetBytes: input.witnessSetBytes, resolved, params, genesis: null, network: job.network, markedInvalid: !job.valid });
        old = `old ${(performance.now() - t).toFixed(0)} ms (${ev.mismatch ? "mismatch" : ev.note ? "skipped: " + ev.note.slice(0, 60) : "agrees"})`;
    }
    console.log(`${job.slot}-${job.i} V${r.redeemers.map((x: any) => x.language).join("/")} ${r.redeemers.length} redeemer(s) cpu ${cpu} → ok=${r.ok}: new ${best.toFixed(1)} ms${old ? " | " + old : ""}`);
}
