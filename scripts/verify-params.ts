#!/usr/bin/env bun
/**
 * Compare locally derived epoch parameters with Koios `epoch_params`, epoch by epoch.
 *   bun scripts/verify-params.ts --db <ledger.db> --network preprod [--from 4 --to 40]
 */
import { Database } from "bun:sqlite";
import { setEpochNetwork } from "../src/utils/epochFromSlotCalculations";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const db = new Database(args.db!, { readonly: true });
const net = args.network ?? "preprod";
setEpochNetwork(net);
const base = net === "mainnet" ? "https://api.koios.rest/api/v1" : `https://${net}.koios.rest/api/v1`;
// local (Blockfrost-shaped) key → Koios epoch_params key
const MAP: Record<string, string> = {
    min_fee_a: "min_fee_a", min_fee_b: "min_fee_b", max_block_size: "max_block_size", max_tx_size: "max_tx_size", max_block_header_size: "max_bh_size",
    key_deposit: "key_deposit", pool_deposit: "pool_deposit", e_max: "max_epoch", n_opt: "optimal_pool_count", a0: "influence", rho: "monetary_expand_rate",
    tau: "treasury_growth_rate", decentralisation_param: "decentralisation", protocol_major_ver: "protocol_major", protocol_minor_ver: "protocol_minor",
    min_utxo: "min_utxo_value", min_pool_cost: "min_pool_cost", coins_per_utxo_size: "coins_per_utxo_size", price_mem: "price_mem", price_step: "price_step",
    max_tx_ex_mem: "max_tx_ex_mem", max_tx_ex_steps: "max_tx_ex_steps", max_block_ex_mem: "max_block_ex_mem", max_block_ex_steps: "max_block_ex_steps",
    max_val_size: "max_val_size", collateral_percent: "collateral_percent", max_collateral_inputs: "max_collateral_inputs",
    gov_action_lifetime: "gov_action_lifetime", gov_action_deposit: "gov_action_deposit", drep_deposit: "drep_deposit", drep_activity: "drep_activity",
    committee_min_size: "committee_min_size", committee_max_term_length: "committee_max_term_length", min_fee_ref_script_cost_per_byte: "min_fee_ref_script_cost_per_byte",
};
const rows = db.query("SELECT epoch, source, params FROM epoch_params ORDER BY epoch").all() as any[];
const from = Number(args.from ?? rows[0]?.epoch ?? 0), to = Number(args.to ?? rows.at(-1)?.epoch ?? 0);
let epochsOk = 0, epochsBad = 0;
for (const r of rows) {
    const e = Number(r.epoch);
    if (e < from || e > to) continue;
    const local = JSON.parse(r.params);
    const k: any = (await (await fetch(`${base}/epoch_params?_epoch_no=${e}`, { headers: { accept: "application/json" } })).json())[0];
    if (!k) { console.log(`epoch ${e}: no Koios record`); continue; }
    const diffs: string[] = [];
    for (const [lk, kk] of Object.entries(MAP)) {
        let lv = local[lk];
        const kv = k[kk];
        if (lk === "coins_per_utxo_size" && lv == null) lv = local.coins_per_utxo_word;
        if (lk === "min_utxo" && Number(local.protocol_major_ver) >= 5) continue; // gone from Alonzo on
        if (lv == null && kv == null) continue;
        if (lv == null || kv == null) { if (!(lv == null && (kv === 0 || kv === "0"))) diffs.push(`${lk}: local ${lv} vs koios ${kv}`); continue; }
        const a = Number(lv), b = Number(kv);
        if (Number.isFinite(a) && Number.isFinite(b)) { if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) diffs.push(`${lk}: local ${lv} vs koios ${kv}`); }
        else if (String(lv) !== String(kv)) diffs.push(`${lk}: local ${lv} vs koios ${kv}`);
    }
    // cost models: compare arrays when both present
    const lcm = local.cost_models_raw ?? local.cost_models, kcm = k.cost_models;
    if (lcm && kcm) for (const lang of ["PlutusV1", "PlutusV2", "PlutusV3"]) {
        const a = lcm[lang], b = kcm[lang];
        if (!a || !b) continue;
        const av = Array.isArray(a) ? a.map(Number) : Object.keys(a).sort().map((x) => Number(a[x]));
        const bv = Array.isArray(b) ? b.map(Number) : Object.values(b).map(Number);
        if (av.length !== bv.length || av.some((x, i) => x !== bv[i])) diffs.push(`cost_models.${lang}: ${av.length} vs ${bv.length} values${av.length === bv.length ? ", values differ" : ""}`);
    }
    if (diffs.length) { epochsBad++; console.log(`epoch ${e} (${r.source}): ${diffs.join("; ")}`); }
    else { epochsOk++; console.log(`epoch ${e} (${r.source}): OK`); }
}
console.log({ epochsOk, epochsBad });
