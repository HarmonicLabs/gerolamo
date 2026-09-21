import { CborArray, CborMap, CborNegInt, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";

/**
 * Conway `PParams` as ouroboros-consensus returns it for `GetCurrentPParams` (LocalStateQuery):
 * the ledger's record encoding — a 31-element list in `ConwayPParams` field order — built from
 * the Blockfrost-shaped record stored in `epoch_params`.
 *
 * Rationals (a0, rho, tau, prices, thresholds, min-fee ref script cost) are stored as decimals;
 * they are turned back into tag-30 fractions in lowest terms via their decimal expansion, which
 * is exact for every value that ever appeared on preview/preprod/mainnet (all are decimals with
 * a power-of-ten denominator; `1/3`-style values would need the fraction stored — see [[TODO]]).
 */
export function conwayPParamsCbor(raw: Record<string, unknown>): CborArray {
    const u = (k: string, dflt = 0n) => new CborUInt(big(raw[k], dflt));
    const r = (k: string) => rational(raw[k]);
    const exUnits = (mem: string, steps: string) => new CborArray([u(mem), u(steps)]);
    return new CborArray([
        u("min_fee_a"),
        u("min_fee_b"),
        u("max_block_size"),
        u("max_tx_size"),
        u("max_block_header_size"),
        u("key_deposit"),
        u("pool_deposit"),
        u("e_max"),
        u("n_opt"),
        r("a0"),
        r("rho"),
        r("tau"),
        new CborArray([u("protocol_major_ver"), u("protocol_minor_ver")]),
        u("min_pool_cost"),
        u("coins_per_utxo_size"),
        costModelsCbor(raw.cost_models),
        new CborArray([r("price_mem"), r("price_step")]),
        exUnits("max_tx_ex_mem", "max_tx_ex_steps"),
        exUnits("max_block_ex_mem", "max_block_ex_steps"),
        u("max_val_size"),
        u("collateral_percent"),
        u("max_collateral_inputs"),
        new CborArray(["pvt_motion_no_confidence", "pvt_committee_normal", "pvt_committee_no_confidence", "pvt_hard_fork_initiation", "pvt_p_p_security_group"].map(r)),
        new CborArray([
            "dvt_motion_no_confidence", "dvt_committee_normal", "dvt_committee_no_confidence", "dvt_update_to_constitution", "dvt_hard_fork_initiation",
            "dvt_p_p_network_group", "dvt_p_p_economic_group", "dvt_p_p_technical_group", "dvt_p_p_gov_group", "dvt_treasury_withdrawal",
        ].map(r)),
        u("committee_min_size"),
        u("committee_max_term_length"),
        u("gov_action_lifetime"),
        u("gov_action_deposit"),
        u("drep_deposit"),
        u("drep_activity"),
        r("min_fee_ref_script_cost_per_byte"),
    ]);
}

/** `{ PlutusV1: [...], PlutusV2: [...], PlutusV3: [...] }` → `{ 0: [...], 1: [...], 2: [...] }`. */
export function costModelsCbor(cm: unknown): CborMap {
    const entries: { k: CborObj; v: CborObj }[] = [];
    if (cm && typeof cm === "object") {
        for (const [lang, ints] of Object.entries(cm as Record<string, unknown>)) {
            const m = /^PlutusV(\d+)$/.exec(lang);
            if (!m || !Array.isArray(ints)) continue;
            entries.push({ k: new CborUInt(Number(m[1]) - 1), v: new CborArray(ints.map((x) => cborInt(big(x))), { indefinite: true }) }); // the node writes cost-model lists indefinite-length (relay capture 2026-09-14)
        }
    }
    entries.sort((a, b) => Number((a.k as CborUInt).num - (b.k as CborUInt).num));
    return new CborMap(entries);
}

/** Tag 30 `[numerator, denominator]` in lowest terms from a decimal number/string (or `"n/d"`). */
export function rational(v: unknown): CborTag {
    const [n, d] = toFraction(v);
    return new CborTag(30, new CborArray([new CborUInt(n), new CborUInt(d)]));
}

export function toFraction(v: unknown): [bigint, bigint] {
    if (v == null) return [0n, 1n];
    const s = typeof v === "number" ? decimalString(v) : String(v).trim();
    const slash = s.indexOf("/");
    if (slash > 0) return reduce(BigInt(s.slice(0, slash).trim()), BigInt(s.slice(slash + 1).trim()));
    const m = /^(\d*)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`not a non-negative decimal: ${s}`);
    const frac = m[2] ?? "";
    return reduce(BigInt((m[1] || "0") + frac), 10n ** BigInt(frac.length));
}

/** Plain decimal expansion of a JS number (no exponent notation: `7.21e-05` → `0.0000721`). */
function decimalString(x: number): string {
    if (!Number.isFinite(x) || x < 0) throw new Error(`not a non-negative finite number: ${x}`);
    const s = String(x);
    const e = s.indexOf("e");
    if (e < 0) return s;
    const exp = Number(s.slice(e + 1));
    const [ip = "0", fp = ""] = s.slice(0, e).split(".");
    const digits = ip + fp;
    const point = ip.length + exp;
    if (point <= 0) return "0." + "0".repeat(-point) + digits;
    if (point >= digits.length) return digits + "0".repeat(point - digits.length);
    return digits.slice(0, point) + "." + digits.slice(point);
}

function reduce(n: bigint, d: bigint): [bigint, bigint] {
    if (d === 0n) throw new Error("zero denominator");
    let a = n < 0n ? -n : n, b = d;
    while (b) [a, b] = [b, a % b];
    return [n / a, d / a];
}

/** Cost models carry signed coefficients (PlutusV3 has negative ones). */
function cborInt(n: bigint): CborObj {
    return n < 0n ? new CborNegInt(n) : new CborUInt(n);
}

function big(v: unknown, dflt = 0n): bigint {
    if (v == null || v === "") return dflt;
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    const s = String(v).trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : dflt;
}

