#!/usr/bin/env bun
/**
 * Run the Plutus phase-2 shadow on one on-chain transaction, resolving its
 * inputs from Koios, to debug why the shadow skips.
 *   bun scripts/shadow-tx.ts --tx <hash> --network preprod --db <ledger.db> [--epoch N]
 */
import { Database } from "bun:sqlite";
import { BabbageTx, ConwayTx, AlonzoTx } from "@harmoniclabs/cardano-ledger-ts";
import { shadowEvaluateTx } from "../src/consensus/rules/plutusEval";
import { epochParamsFromRecord } from "../src/consensus/epochParams";
import type { ResolvedUtxo } from "../src/consensus/rules/resolvedUtxo";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json", "content-type": "application/json" };
const post = async (path: string, body: any) => (await fetch(`${base}/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
const [cb] = await post("tx_cbor", { _tx_hashes: [args.tx] });
const [info] = await post("tx_info", { _tx_hashes: [args.tx], _inputs: true, _scripts: true, _assets: true });
const bytes = Buffer.from(cb.cbor, "hex");
let tx: any = null, era = 6;
for (const [cls, e] of [[BabbageTx, 6], [ConwayTx, 7], [AlonzoTx, 5]] as any[]) { try { tx = cls.fromCbor(bytes); era = e; break; } catch { /* next */ } }
if (!tx) throw new Error("cannot parse tx");
const resolved = new Map<string, ResolvedUtxo>();
const addUtxo = (u: any) => {
    const ref = `${u.tx_hash}:${u.tx_index}`;
    const value = new Map<string, bigint>([["lovelace", BigInt(u.value)]]);
    for (const a of u.asset_list ?? []) value.set(`${a.policy_id}${a.asset_name ?? ""}`, BigInt(a.quantity));
    resolved.set(ref, {
        ref, address: u.payment_addr?.bech32 ?? "", value,
        referenceScriptHash: u.reference_script?.hash ?? null,
        referenceScriptCbor: u.reference_script?.bytes ? `82${{ plutusV1: "01", plutusV2: "02", plutusV3: "03", timelock: "00" }[String(u.reference_script.type)] ?? "02"}${cborBytes(u.reference_script.bytes)}` : null,
        hasDatum: !!(u.datum_hash || u.inline_datum),
        datumHash: u.datum_hash ?? null,
        inlineDatumCbor: u.inline_datum?.bytes ?? null,
    });
};
function cborBytes(hexStr: string): string { const n = hexStr.length / 2; const hdr = n < 24 ? (0x40 + n).toString(16) : n < 256 ? "58" + n.toString(16).padStart(2, "0") : n < 65536 ? "59" + n.toString(16).padStart(4, "0") : "5a" + n.toString(16).padStart(8, "0"); return hdr + hexStr; }
// utxo_info (extended) carries reference scripts and inline datums that tx_info omits
const refs = [...(info.inputs ?? []), ...(info.reference_inputs ?? []), ...(info.collateral_inputs ?? [])].map((u: any) => `${u.tx_hash}#${u.tx_index}`);
const ext: any[] = refs.length ? await post("utxo_info", { _utxo_refs: refs, _extended: true }) : [];
for (const u of [...(info.inputs ?? []), ...(info.reference_inputs ?? []), ...(info.collateral_inputs ?? [])]) {
    const e = ext.find((x) => x.tx_hash === u.tx_hash && Number(x.tx_index) === Number(u.tx_index));
    addUtxo(e ? { ...u, ...e, payment_addr: u.payment_addr ?? { bech32: e.address } } : u);
}
const db = new Database(args.db!, { readonly: true });
const epoch = Number(args.epoch ?? info.epoch_no);
const rec = db.query("SELECT params FROM epoch_params WHERE epoch = ?").get(epoch) as any;
const params = epochParamsFromRecord(epoch, JSON.parse(rec.params));
console.log("tx", args.tx.slice(0, 12), "era", era, "epoch", epoch, "inputs", info.inputs?.length, "refInputs", info.reference_inputs?.length, "redeemers", tx.witnesses?.redeemers?.length, "valid", info.valid_contract);
try {
    const ev = await shadowEvaluateTx({ era, body: tx.body, witnessSet: tx.witnesses, bodyBytes: tx.body.cborRef?.toBuffer?.() ?? null, witnessSetBytes: tx.witnesses.cborRef?.toBuffer?.() ?? null, resolved, params, genesis: await Bun.file(`src/config/${net}/shelley-genesis.json`).json(), network: net, markedInvalid: info.valid_contract === false });
    console.log(ev);
} catch (e: any) {
    console.log("EXCEPTION", e?.message ?? e); console.log(String(e?.stack ?? "").split("\n").slice(0, 8).join("\n"));
}
