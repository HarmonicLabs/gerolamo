#!/usr/bin/env bun
/**
 * Evaluate one dumped replay job (`plutus-replay.ts --dump-dir`) with script traces and per-redeemer
 * budgets; `--ctx <dir>` also writes each redeemer's script context (CBOR hex) for data-diff.ts.
 *   bun scripts/plutus-job.ts <job.json> [--ctx <dir>]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { TxOut } from "@harmoniclabs/cardano-ledger-ts";
import { outputLike } from "../src/consensus/rules/blockRulesPure";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
import { evaluatePhase2Sync, slotToPosixMs } from "../src/consensus/rules/phase2";
import { TxContext } from "../src/consensus/plutus/context";
import { DConstr, encodeData } from "../src/consensus/plutus/data";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
setEpochNetwork(job.network);
const resolved = new Map<string, ResolvedUtxo>();
for (const [ref, h] of job.resolved) {
    const o = outputLike(TxOut.fromCbor(h));
    resolved.set(ref, { ref, address: o.address, value: o.value, referenceScriptHash: o.referenceScriptHash ?? null, referenceScriptCbor: o.referenceScriptCbor ?? null, hasDatum: !!o.hasDatum, datumHash: o.datumHash ?? null, inlineDatumCbor: o.inlineDatumCbor ?? null });
}
const params = job.params ? epochParamsFromRecord(0, job.params) : null;
const input = { era: job.era, bodyBytes: Buffer.from(job.bodyHex, "hex"), witnessSetBytes: Buffer.from(job.witnessHex, "hex"), resolved, params, markedInvalid: !job.valid, traces: true };
const t = performance.now();
const r = evaluatePhase2Sync(input);
console.log(`slot ${job.slot} tx ${job.i} ${job.txHash} valid=${job.valid} → ok=${r.ok} error=${r.error} (${(performance.now() - t).toFixed(1)} ms)`);
for (const x of r.redeemers) console.log(`  ${x.tag}:${x.index} V${x.language} ${x.scriptHash?.slice(0, 16)} ok=${x.ok} ${x.reason ?? ""} cpu ${x.spent?.cpu}/${x.declared.cpu} mem ${x.spent?.mem}/${x.declared.mem} ${x.ms?.toFixed(1)} ms${x.logs?.length ? " logs: " + JSON.stringify(x.logs) : ""}`);
const ctxDir = process.argv.indexOf("--ctx") > 0 ? process.argv[process.argv.indexOf("--ctx") + 1] : null;
if (ctxDir) {
    mkdirSync(ctxDir, { recursive: true });
    const ctx = new TxContext({ era: job.era, pv: Number(params?.protocolMajor ?? 0), bodyBytes: input.bodyBytes, witnessSetBytes: input.witnessSetBytes, resolved, slotToPosixMs });
    for (const rd of ctx.redeemers) {
        const x = r.redeemers.find((y) => y.tag === rd.tag && y.index === rd.index)!;
        const p = ctx.purposeOf(rd)!;
        const lang = x.language ?? 3;
        const sc = lang === 3 ? new DConstr(0n, [ctx.txInfo(3), rd.data, ctx.scriptInfoData(p)]) : new DConstr(0n, [ctx.txInfo(lang), ctx.purposeData(p, lang)]);
        writeFileSync(`${ctxDir}/${rd.tag}-${rd.index}.ctx.hex`, Buffer.from(encodeData(sc)).toString("hex"));
    }
    console.log(`contexts written to ${ctxDir}`);
}
// --aiken <dir>: write tx.hex / inputs.hex / outputs.hex for tools/uplc-ref (`ctx`, `eval-tx`)
const aikenDir = process.argv.indexOf("--aiken") > 0 ? process.argv[process.argv.indexOf("--aiken") + 1] : null;
if (aikenDir) {
    mkdirSync(aikenDir, { recursive: true });
    const hdr = (major: number, n: number) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
    const tx = Buffer.concat([Buffer.from([0x84]), input.bodyBytes, input.witnessSetBytes, Buffer.from([job.valid ? 0xf5 : 0xf4, 0xf6])]);
    const ins = Buffer.concat([hdr(4, job.resolved.length), ...job.resolved.map(([ref]: [string, string]) => { const [id, ix] = ref.split(":"); return Buffer.concat([Buffer.from([0x82, 0x58, 0x20]), Buffer.from(id!, "hex"), hdr(0, Number(ix))]); })]);
    const outs = Buffer.concat([hdr(4, job.resolved.length), ...job.resolved.map(([, h]: [string, string]) => Buffer.from(h, "hex"))]);
    writeFileSync(`${aikenDir}/tx.hex`, tx.toString("hex")); writeFileSync(`${aikenDir}/inputs.hex`, ins.toString("hex")); writeFileSync(`${aikenDir}/outputs.hex`, outs.toString("hex"));
    const cm = (job.params?.cost_models ?? {}) as any;
    writeFileSync(`${aikenDir}/costs.json`, JSON.stringify({ PlutusV1: cm.PlutusV1, PlutusV2: cm.PlutusV2, PlutusV3: cm.PlutusV3 }));
    console.log(`aiken bundle written to ${aikenDir}`);
}
// --old: also run the previous shadow evaluator (plutus-machine + buildooor contexts) for comparison
if (process.argv.includes("--old")) {
    const { shadowEvaluateTxLegacy: shadowEvaluateTx, setShadowTrace, lastTraceSummary } = await import("../src/consensus/rules/plutusEval");
    const { ConwayTx, BabbageTx, AlonzoTx } = await import("@harmoniclabs/cardano-ledger-ts");
    setShadowTrace(2);
    const tx: any = { body: null, witnesses: { redeemers: [1] } };
    const ev = await shadowEvaluateTx({ forceSample: true, era: job.era, body: tx.body, witnessSet: tx.witnesses, bodyBytes: input.bodyBytes, witnessSetBytes: input.witnessSetBytes, resolved, params, genesis: null, network: job.network, markedInvalid: !job.valid });
    console.log("old shadow:", ev);
    console.log(lastTraceSummary());
}
