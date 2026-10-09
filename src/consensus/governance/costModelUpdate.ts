/**
 * Cost-model changes carried by a Conway ParameterChange action, read from the
 * transaction body's original bytes.
 *
 * The libraries drop them: the cost-models package ignores a language whose list
 * holds a negative integer (the 297-entry PlutusV3 model of protocol 9 has four),
 * and the ledger-ts partial-parameter decoder then reports no cost models at all.
 * Preview enacted such an update at epoch 736 and every V3 script data hash
 * disagreed afterwards (bug 59).
 */
import { Cbor, CborArray, CborMap, CborNegInt, CborObj, CborTag, CborUInt } from "@harmoniclabs/cbor";

export type RawCostModels = Partial<Record<"PlutusV1" | "PlutusV2" | "PlutusV3" | "PlutusV4", number[]>>;

const LANG_NAMES = ["PlutusV1", "PlutusV2", "PlutusV3"] as const;
/** Dijkstra knows PlutusV4 (cost model key 3; bug 430). */
const LANG_NAMES_DIJKSTRA = ["PlutusV1", "PlutusV2", "PlutusV3", "PlutusV4"] as const;

/** Era-dependent decoding options: Dijkstra (protocol 12) adds PlutusV4 and update keys 34..56. */
export interface ParamUpdateOptions { dijkstra?: boolean }

function listOf(v: CborObj | undefined): CborObj[] {
    const inner: any = v instanceof CborTag ? v.data : v;
    return inner instanceof CborArray ? inner.array : [];
}

function mapGet(m: CborObj | undefined, key: number): CborObj | undefined {
    if (!(m instanceof CborMap)) return undefined;
    return m.map.find(({ k }) => k instanceof CborUInt && Number(k.num) === key)?.v;
}

/** Cost models (key 18) of a protocol parameter update map, as plain integer lists per language. */
export function costModelsOfUpdateMap(update: CborObj | undefined, opts: ParamUpdateOptions = {}): RawCostModels | null {
    const cm = mapGet(update, 18);
    if (!(cm instanceof CborMap)) return null;
    const out: RawCostModels = {};
    const names: readonly string[] = opts.dijkstra ? LANG_NAMES_DIJKSTRA : LANG_NAMES;
    for (const { k, v } of cm.map) {
        if (!(k instanceof CborUInt) || !(v instanceof CborArray)) continue;
        const name = names[Number(k.num)] as keyof RawCostModels | undefined;
        if (!name) continue; // PlutusV4 and later: not modelled yet
        out[name] = v.array.map((x) => {
            if (x instanceof CborUInt || x instanceof CborNegInt) return Number(x.num);
            throw new Error("cost model entry is not an integer");
        });
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Cost models of the `index`-th proposal procedure (body key 20) when it is a
 * ParameterChange action carrying key 18; null otherwise or when the bytes do
 * not parse as a transaction body.
 */
export function costModelsOfProposal(bodyBytes: Uint8Array, index: number): RawCostModels | null {
    try {
        const body = Cbor.parse(bodyBytes);
        const proposals = listOf(mapGet(body, 20));
        const pp = proposals[index];
        if (!(pp instanceof CborArray)) return null;
        const action = pp.array[2]; // [deposit, reward_account, gov_action, anchor]
        if (!(action instanceof CborArray) || !(action.array[0] instanceof CborUInt) || Number(action.array[0].num) !== 0) return null;
        return costModelsOfUpdateMap(action.array[2]); // [0, prev_action_id, protocol_param_update, policy_hash]
    } catch {
        return null;
    }
}

/**
 * Conway applies a cost-model update per language: the languages the action
 * names are replaced, the others stay (`updateCostModels` is a left-biased union
 * over the new value). Preview epoch 736 changed only PlutusV3 and kept V1/V2.
 */
export function mergeCostModels(prev: unknown, update: RawCostModels | null | undefined): Record<string, unknown> {
    const base: Record<string, unknown> = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
    for (const [lang, list] of Object.entries(update ?? {})) if (Array.isArray(list)) base[lang] = list;
    return base;
}

/** Blockfrost-shaped keys of the Conway `protocol_param_update` map, by CBOR key. */
const PPARAM_KEYS: Record<number, string> = {
    0: "min_fee_a", 1: "min_fee_b", 2: "max_block_size", 3: "max_tx_size", 4: "max_block_header_size",
    5: "key_deposit", 6: "pool_deposit", 7: "e_max", 8: "n_opt", 9: "a0", 10: "rho", 11: "tau",
    16: "min_pool_cost", 17: "coins_per_utxo_size", 22: "max_val_size", 23: "collateral_percent", 24: "max_collateral_inputs",
    27: "committee_min_size", 28: "committee_max_term_length", 29: "gov_action_lifetime", 30: "gov_action_deposit",
    31: "drep_deposit", 32: "drep_activity", 33: "min_fee_ref_script_cost_per_byte",
};
const POOL_THRESHOLDS = ["pvt_motion_no_confidence", "pvt_committee_normal", "pvt_committee_no_confidence", "pvt_hard_fork_initiation", "pvt_p_p_security_group"];
const DREP_THRESHOLDS = ["dvt_motion_no_confidence", "dvt_committee_normal", "dvt_committee_no_confidence", "dvt_update_to_constitution", "dvt_hard_fork_initiation", "dvt_p_p_network_group", "dvt_p_p_economic_group", "dvt_p_p_technical_group", "dvt_p_p_gov_group", "dvt_treasury_withdrawal"];

function intOf(v: CborObj | undefined): string | null {
    return v instanceof CborUInt || v instanceof CborNegInt ? v.num.toString() : null;
}
/** A CBOR rational (tag 30 over [num, den]) as a JS number, like the Blockfrost-shaped records store it. */
function rationalOf(v: CborObj | undefined): number | null {
    const inner: any = v instanceof CborTag ? v.data : v;
    if (!(inner instanceof CborArray) || inner.array.length !== 2) return null;
    const n = intOf(inner.array[0]), d = intOf(inner.array[1]);
    if (n == null || d == null || d === "0") return null;
    return Number(n) / Number(d);
}

/**
 * Every change carried by a `protocol_param_update` map, as Blockfrost-shaped raw keys
 * (the same shape `epoch_params` records use). Read from the bytes so no library
 * naming or decoding gap can drop a field (bug 66: `committee_min_size`, `drep_activity`
 * and the execution-unit limits were lost by the ledger-ts field mapping).
 */
export function paramChangesOfUpdateMap(update: CborObj | undefined, opts: ParamUpdateOptions = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!(update instanceof CborMap)) return out;
    for (const { k, v } of update.map) {
        if (!(k instanceof CborUInt)) continue;
        const key = Number(k.num);
        if (opts.dijkstra && key >= 34) { dijkstraParamChange(out, key, v); continue; }
        const name = PPARAM_KEYS[key];
        if (name) {
            const r = key === 9 || key === 10 || key === 11 || key === 33 ? rationalOf(v) : null;
            const i = intOf(v);
            if (r != null) out[name] = r;
            else if (i != null) out[name] = key === 9 || key === 10 || key === 11 ? Number(i) : (Math.abs(Number(i)) <= Number.MAX_SAFE_INTEGER ? Number(i) : i);
            continue;
        }
        switch (key) {
            case 18: { const cm = costModelsOfUpdateMap(update, opts); if (cm) out.cost_models = cm; break; }
            case 19: { // ex_unit_prices [mem_price, step_price]
                const arr = v instanceof CborArray ? v.array : [];
                const pm = rationalOf(arr[0]), ps = rationalOf(arr[1]);
                if (pm != null) out.price_mem = pm;
                if (ps != null) out.price_step = ps;
                break;
            }
            case 20: case 21: { // ex_units [mem, steps]
                const arr = v instanceof CborArray ? v.array : [];
                const mem = intOf(arr[0]), steps = intOf(arr[1]);
                const pre = key === 20 ? "max_tx_ex" : "max_block_ex";
                if (mem != null) out[`${pre}_mem`] = mem;
                if (steps != null) out[`${pre}_steps`] = steps;
                break;
            }
            case 25: case 26: {
                const names = key === 25 ? POOL_THRESHOLDS : DREP_THRESHOLDS;
                const arr = v instanceof CborArray ? v.array : [];
                arr.forEach((x, i) => { const r = rationalOf(x); if (r != null && names[i]) out[names[i]] = r; });
                break;
            }
            default: break;
        }
    }
    return out;
}

/**
 * All parameter changes of the `index`-th proposal procedure (body key 20) when it is a
 * ParameterChange action; null otherwise or when the bytes do not parse.
 */
export function paramChangesOfProposal(bodyBytes: Uint8Array, index: number, opts: ParamUpdateOptions = {}): Record<string, unknown> | null {
    try {
        const body = Cbor.parse(bodyBytes);
        const proposals = listOf(mapGet(body, 20));
        const pp = proposals[index];
        if (!(pp instanceof CborArray)) return null;
        const action = pp.array[2];
        if (!(action instanceof CborArray) || !(action.array[0] instanceof CborUInt) || Number(action.array[0].num) !== 0) return null;
        return paramChangesOfUpdateMap(action.array[2], opts);
    } catch {
        return null;
    }
}

/**
 * Dijkstra `protocol_param_update` keys 34..56 (cardano-ledger eras/dijkstra PParams.hs; bug 430),
 * stored under snake_case names next to the Blockfrost-shaped Conway ones. Rationals that the
 * rules need exactly (the reference-script multiplier) are kept as "n/d" strings.
 */
export const DIJKSTRA_PPARAM_KEYS: Record<number, string> = {
    34: "max_ref_script_size_per_block", 35: "max_ref_script_size_per_tx", 36: "ref_script_cost_stride", 37: "ref_script_cost_multiplier",
    38: "max_pledge_leverage", 39: "min_pool_margin",
    40: "leios_announcement_period_ms", 41: "leios_vote_period_ms", 42: "leios_diffusion_period_ms", 43: "leios_committee_size",
    44: "leios_quorum_stake_threshold", 45: "max_eb_references_size", 46: "max_eb_txs_size", 47: "max_eb_ex_units",
    48: "max_ref_script_size_per_eb", 49: "peras_min_candidate_block_age", 50: "peras_healing_factor", 51: "peras_cert_boost",
    52: "peras_target_committee_size", 53: "peras_bootstrap_round", 54: "peras_quorum_threshold_safety_margin",
    55: "ref_inputs_cost_per_multi_asset_policy", 56: "ref_inputs_cost_per_datum_byte",
};
const DIJKSTRA_RATIONAL_KEYS = new Set([37, 38, 39, 44, 50, 54]);

function exactRational(v: CborObj | undefined): string | null {
    const inner: any = v instanceof CborTag ? v.data : v;
    if (!(inner instanceof CborArray) || inner.array.length !== 2) return null;
    const n = intOf(inner.array[0]), d = intOf(inner.array[1]);
    return n == null || d == null || d === "0" ? null : `${n}/${d}`;
}

function dijkstraParamChange(out: Record<string, unknown>, key: number, v: CborObj): void {
    const name = DIJKSTRA_PPARAM_KEYS[key];
    if (!name) return; // keys after 56: unknown to this release
    const isNull = (v as any)?.simple === null;
    if (key === 47) { // ex_units [mem, steps]
        const arr = v instanceof CborArray ? v.array : [];
        const mem = intOf(arr[0]), steps = intOf(arr[1]);
        if (mem != null) out.max_eb_ex_mem = mem;
        if (steps != null) out.max_eb_ex_steps = steps;
        return;
    }
    if (key === 38 || key === 53) { if (isNull) { out[name] = null; return; } }
    if (DIJKSTRA_RATIONAL_KEYS.has(key)) { const r = exactRational(v); if (r != null) out[name] = r; return; }
    const i = intOf(v);
    if (i != null) out[name] = Math.abs(Number(i)) <= Number.MAX_SAFE_INTEGER ? Number(i) : i;
}
