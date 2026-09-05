#!/usr/bin/env bun
import { Tx, BabbageTx, ConwayTx, AlonzoTx } from "@harmoniclabs/cardano-ledger-ts";
import { costModelArrays, expectedScriptDataHash, type PlutusLanguage } from "../src/consensus/rules/scriptDataHash";
const txs = await Bun.file(process.argv[2]!).json();
const params = await Bun.file(process.argv[3]!).json();
let ok = 0, bad = 0, skip = 0;
for (const t of txs) {
    const bytes = Buffer.from(t.cbor, "hex");
    let tx: any = null;
    for (const cls of [BabbageTx, ConwayTx, AlonzoTx, Tx] as any[]) { try { tx = cls.fromCbor(bytes); break; } catch { /* */ } }
    if (!tx) { skip++; console.log("cannot parse", t.tx_hash.slice(0, 12)); continue; }
    const ws = tx.witnesses ?? tx.witnessSet, body = tx.body;
    const langs = new Set<PlutusLanguage>();
    if (ws.plutusV1Scripts?.length) langs.add(1); if (ws.plutusV2Scripts?.length) langs.add(2); if (ws.plutusV3Scripts?.length) langs.add(3);
    const wsBytes = ws.cborRef?.toBuffer?.();
    if (!wsBytes) { skip++; console.log("no witness bytes", t.tx_hash.slice(0, 12), Object.keys(ws).slice(0, 5)); continue; }
    const models = costModelArrays(params[String(t.epoch)]);
    const exp = expectedScriptDataHash({ witnessSetBytes: wsBytes, languages: langs, models, alonzoForm: Number(params[String(t.epoch)].protocol_major) < 7 });
    const actual = String(body.scriptDataHash ?? "").toLowerCase();
    const hit = exp.hash === actual;
    if (hit) ok++; else bad++;
    console.log(hit ? "OK  " : "BAD ", t.tx_hash.slice(0, 12), "epoch", t.epoch, "langs", [...langs].join(","), "refInputs", t.ref_inputs, "expected", exp.hash?.slice(0, 12), exp.reason ?? "", "actual", actual.slice(0, 12), "redeemers", ws.redeemers?.length, "datums", ws.datums?.length);
}
console.log({ ok, bad, skip });
