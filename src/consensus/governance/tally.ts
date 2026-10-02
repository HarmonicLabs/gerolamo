/**
 * Shared pieces of the Conway ratification: action kinds, rationals and the parameter groups of
 * a ParameterChange (cardano-ledger `ConwayPParams` THKD groups). The round itself — thresholds,
 * the three bodies' tallies, ordering and the enact state — is ratify.ts (bugs 151–155, 158; the
 * accept functions that lived here counted a committee member that did not vote as absent, excluded
 * an AlwaysAbstain pool from a hard fork and applied the committee minimum in the bootstrap phase).
 */
export type Vote = 0 | 1 | 2; // No, Yes, Abstain

export interface Rational { num: bigint; den: bigint }

export type ActionKind = "ParameterChange" | "InitHardFork" | "TreasuryWithdrawals" | "NoConfidence" | "UpdateCommittee" | "NewConstitution" | "Info";

/** Which parameter groups a ParameterChange touches (cardano-ledger pparam groups). */
export function paramGroups(changedKeys: string[]): Set<"network" | "economic" | "technical" | "gov" | "security"> {
    const groups = new Set<"network" | "economic" | "technical" | "gov" | "security">();
    const network = ["max_block_size", "max_tx_size", "max_block_header_size", "max_val_size", "max_tx_ex_mem", "max_tx_ex_steps", "max_block_ex_mem", "max_block_ex_steps", "max_collateral_inputs"];
    const economic = ["min_fee_a", "min_fee_b", "key_deposit", "pool_deposit", "rho", "tau", "min_pool_cost", "coins_per_utxo_size", "price_mem", "price_step", "min_fee_ref_script_cost_per_byte"];
    const technical = ["a0", "e_max", "n_opt", "cost_models", "collateral_percent"];
    const gov = ["pvt_motion_no_confidence", "pvt_committee_normal", "pvt_committee_no_confidence", "pvt_hard_fork_initiation", "pvt_p_p_security_group", "dvt_motion_no_confidence", "dvt_committee_normal", "dvt_committee_no_confidence", "dvt_update_to_constitution", "dvt_hard_fork_initiation", "dvt_p_p_network_group", "dvt_p_p_economic_group", "dvt_p_p_technical_group", "dvt_p_p_gov_group", "dvt_treasury_withdrawal", "committee_min_size", "committee_max_term_length", "gov_action_lifetime", "gov_action_deposit", "drep_deposit", "drep_activity"];
    const security = ["max_block_size", "max_tx_size", "max_block_header_size", "max_val_size", "max_block_ex_mem", "max_block_ex_steps", "min_fee_a", "min_fee_b", "coins_per_utxo_size", "gov_action_deposit", "min_fee_ref_script_cost_per_byte"];
    for (const k of changedKeys) {
        if (network.includes(k)) groups.add("network");
        if (economic.includes(k)) groups.add("economic");
        if (technical.includes(k)) groups.add("technical");
        if (gov.includes(k)) groups.add("gov");
        if (security.includes(k)) groups.add("security");
    }
    return groups;
}

export function rationalOf(v: unknown, fallback: string): Rational {
    const s = String(v ?? fallback);
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return rationalOf(fallback, fallback);
    const frac = m[2] ?? "";
    return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}
