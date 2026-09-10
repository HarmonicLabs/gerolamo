#!/usr/bin/env bun
/**
 * Re-evaluate an on-chain transaction's Plutus scripts with aiken (`aiken tx simulate`),
 * an independent implementation that builds its own script context, and compare its
 * execution units with the budgets declared in the transaction.
 * Inputs are resolved from Koios and re-encoded as Babbage outputs.
 *   bun scripts/aiken-simulate.ts --tx <hash> [--network preview|preprod|mainnet] [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Cbor, CborArray, CborBytes, CborMap, CborNegInt, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const net = args.network ?? "preview";
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
const H = { accept: "application/json", "content-type": "application/json" };
const post = async (path: string, body: any) => (await fetch(`${base}/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
// shelley slot config per network (zero-time ms, zero-slot, slot length ms)
const SLOTS: Record<string, [number, number, number]> = {
    mainnet: [1596059091000, 4492800, 1000], preprod: [1655769600000, 86400, 1000], preview: [1666656000000, 0, 1000],
};

const [cb] = await post("tx_cbor", { _tx_hashes: [args.tx] });
const [info] = await post("tx_info", { _tx_hashes: [args.tx], _inputs: true, _scripts: true, _assets: true, _withdrawals: true, _certs: true });
const refs = [...(info.inputs ?? []), ...(info.reference_inputs ?? []), ...(info.collateral_inputs ?? [])];
const uniq = [...new Map(refs.map((u: any) => [`${u.tx_hash}#${u.tx_index}`, u])).values()];
const ext: any[] = await post("utxo_info", { _utxo_refs: uniq.map((u: any) => `${u.tx_hash}#${u.tx_index}`), _extended: true });

const uint = (n: bigint) => n < 0n ? new CborNegInt(n) : new CborUInt(n);
function valueCbor(u: any) {
    const lovelace = uint(BigInt(u.value));
    const assets: any[] = u.asset_list ?? [];
    if (assets.length === 0) return lovelace;
    const byPolicy = new Map<string, Array<[string, bigint]>>();
    for (const a of assets) byPolicy.set(a.policy_id, [...(byPolicy.get(a.policy_id) ?? []), [a.asset_name ?? "", BigInt(a.quantity)]]);
    const ma = new CborMap([...byPolicy].sort().map(([p, as]) => ({
        k: new CborBytes(fromHex(p)),
        v: new CborMap(as.sort((x, y) => x[0].length - y[0].length || (x[0] < y[0] ? -1 : 1)).map(([n, q]) => ({ k: new CborBytes(fromHex(n)), v: uint(q) }))),
    })));
    return new CborArray([lovelace, ma]);
}
const LANG: Record<string, number> = { timelock: 0, plutusV1: 1, plutusV2: 2, plutusV3: 3 };
function outputCbor(u: any) {
    const entries: any[] = [
        { k: new CborUInt(0), v: new CborBytes(Address.fromString(u.address).toBuffer()) },
        { k: new CborUInt(1), v: valueCbor(u) },
    ];
    if (u.inline_datum?.bytes) entries.push({ k: new CborUInt(2), v: new CborArray([new CborUInt(1), new CborTag(24, new CborBytes(fromHex(u.inline_datum.bytes)))]) });
    else if (u.datum_hash) entries.push({ k: new CborUInt(2), v: new CborArray([new CborUInt(0), new CborBytes(fromHex(u.datum_hash))]) });
    if (u.reference_script?.bytes) {
        const lang = LANG[String(u.reference_script.type)];
        const script = lang === 0
            ? new CborArray([new CborUInt(0), Cbor.parse(fromHex(u.reference_script.bytes))])
            : new CborArray([new CborUInt(lang), new CborBytes(fromHex(u.reference_script.bytes))]);
        entries.push({ k: new CborUInt(3), v: new CborTag(24, new CborBytes(Cbor.encode(script).toBuffer())) });
    }
    return new CborMap(entries);
}
const resolved = uniq.map((u: any) => ext.find((x) => x.tx_hash === u.tx_hash && Number(x.tx_index) === Number(u.tx_index)));
if (resolved.some((x) => !x)) throw new Error("unresolved input");
const inputs = new CborArray(resolved.map((u: any) => new CborArray([new CborBytes(fromHex(u.tx_hash)), new CborUInt(BigInt(u.tx_index))])));
const outputs = new CborArray(resolved.map(outputCbor));
const dir = args.out ?? `/tmp/aiken-sim-${String(args.tx).slice(0, 8)}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/tx.hex`, cb.cbor);
writeFileSync(`${dir}/inputs.hex`, toHex(Cbor.encode(inputs).toBuffer()));
writeFileSync(`${dir}/outputs.hex`, toHex(Cbor.encode(outputs).toBuffer()));
const [zeroTime, zeroSlot, slotLen] = SLOTS[net];
const proc = Bun.spawnSync(["aiken", "tx", "simulate", `${dir}/tx.hex`, `${dir}/inputs.hex`, `${dir}/outputs.hex`, "--zero-time", String(zeroTime), "--zero-slot", String(zeroSlot), "--slot-length", String(slotLen)], { stdout: "pipe", stderr: "pipe" });
const out = proc.stdout.toString(), err = proc.stderr.toString();
console.log(`tx ${String(args.tx).slice(0, 12)} slot ${info.absolute_slot} epoch ${info.epoch_no} inputs ${resolved.length} (files in ${dir})`);
console.log("declared:", (info.plutus_contracts ?? []).map((c: any) => `${c.input?.redeemer?.purpose ?? c.purpose}:${c.input?.redeemer?.unit?.mem ?? "?"}/${c.input?.redeemer?.unit?.steps ?? "?"}`).join(" "));
console.log("aiken stdout:\n" + out.trim());
if (err.trim()) console.log("aiken stderr:\n" + err.trim().slice(0, 4000));
