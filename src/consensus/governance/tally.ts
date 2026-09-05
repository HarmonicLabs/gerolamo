/**
 * Conway ratification arithmetic (CIP-1694, cardano-ledger RATIFY), pure.
 *
 * A proposal is ratified at an epoch boundary when every body it needs agrees:
 *   CC    : yes / (yes + no) ≥ committee threshold, over active members
 *   DReps : yes stake / (total DRep stake − abstain) ≥ threshold(action)
 *           AlwaysNoConfidence stake counts as No (Yes for NoConfidence actions);
 *           AlwaysAbstain stake is excluded; unvoted DRep stake counts as No.
 *   SPOs  : yes stake / (total pool stake − abstain) ≥ threshold(action);
 *           unvoted pools count as No (their reward account may delegate to
 *           AlwaysAbstain / AlwaysNoConfidence, which is honoured).
 * Bootstrap phase (protocol major < 10): DReps do not vote; SPOs decide hard
 * forks and security-group parameter changes; CC decides the rest with SPOs
 * for NoConfidence / UpdateCommittee having no effect (not allowed).
 */
export type Vote = 0 | 1 | 2; // No, Yes, Abstain

export interface Rational { num: bigint; den: bigint }

export interface DRepTally {
    /** stake voting Yes / No / Abstain (explicit votes) */
    yes: bigint;
    no: bigint;
    abstain: bigint;
    /** stake delegated to a registered DRep that did not vote */
    unvoted: bigint;
    alwaysNoConfidence: bigint;
    alwaysAbstain: bigint;
}

export interface PoolTally {
    yes: bigint;
    no: bigint;
    abstain: bigint;
    unvoted: bigint;
    /** unvoted stake whose pool reward account delegates to AlwaysAbstain / AlwaysNoConfidence */
    unvotedAbstain: bigint;
    unvotedNoConfidence: bigint;
}

export interface CommitteeTally {
    yes: number;
    no: number;
    abstain: number;
    /** members with an authorised hot key and unexpired term */
    active: number;
}

export type ActionKind = "ParameterChange" | "InitHardFork" | "TreasuryWithdrawals" | "NoConfidence" | "UpdateCommittee" | "NewConstitution" | "Info";

export interface Thresholds {
    committee: Rational;
    drep: Rational | null; // null = DReps not required
    pool: Rational | null; // null = pools not required
}

const ge = (numA: bigint, denA: bigint, t: Rational): boolean => denA > 0n && numA * t.den >= t.num * denA;

export function drepAccepts(t: DRepTally, threshold: Rational, kind: ActionKind): boolean {
    const yes = t.yes + (kind === "NoConfidence" ? t.alwaysNoConfidence : 0n);
    const total = t.yes + t.no + t.unvoted + t.alwaysNoConfidence; // abstain excluded
    if (total === 0n) return false;
    return ge(yes, total, threshold);
}

export function poolAccepts(t: PoolTally, threshold: Rational, kind: ActionKind): boolean {
    const yes = t.yes + (kind === "NoConfidence" ? t.unvotedNoConfidence : 0n);
    const total = t.yes + t.no + t.unvoted - t.unvotedAbstain; // explicit abstain and abstain-delegated excluded
    if (total <= 0n) return false;
    return ge(yes, total, threshold);
}

export function committeeAccepts(t: CommitteeTally, threshold: Rational, minSize: number): boolean {
    if (t.active < minSize) return false; // committee below min size cannot ratify
    const voting = t.yes + t.no;
    if (voting === 0) return false;
    return ge(BigInt(t.yes), BigInt(voting), threshold);
}

export interface ThresholdParams {
    committeeThreshold: Rational;
    committeeMinSize: number;
    drep: Record<string, Rational>; // dvt_* keys
    pool: Record<string, Rational>; // pvt_* keys
    protocolMajor: number;
}

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

/** Thresholds a proposal must meet, per action kind and (for parameter changes) groups. */
export function thresholdsFor(kind: ActionKind, p: ThresholdParams, changedKeys: string[] = [], committeeState: "normal" | "noConfidence" = "normal"): Thresholds {
    const bootstrap = p.protocolMajor < 10;
    const d = (k: string) => p.drep[k] ?? { num: 1n, den: 1n };
    const pv = (k: string) => p.pool[k] ?? { num: 1n, den: 1n };
    const cc = p.committeeThreshold;
    const maxR = (rs: Rational[]): Rational | null => rs.length ? rs.reduce((a, b) => (a.num * b.den >= b.num * a.den ? a : b)) : null;
    switch (kind) {
        case "Info":
            return { committee: cc, drep: null, pool: null };
        case "NoConfidence":
            return { committee: cc, drep: bootstrap ? null : d("dvt_motion_no_confidence"), pool: pv("pvt_motion_no_confidence") };
        case "UpdateCommittee": {
            const k = committeeState === "normal" ? "committee_normal" : "committee_no_confidence";
            return { committee: cc, drep: bootstrap ? null : d(`dvt_${k}`), pool: pv(`pvt_${k}`) };
        }
        case "NewConstitution":
            return { committee: cc, drep: bootstrap ? null : d("dvt_update_to_constitution"), pool: null };
        case "InitHardFork":
            return { committee: cc, drep: bootstrap ? null : d("dvt_hard_fork_initiation"), pool: pv("pvt_hard_fork_initiation") };
        case "TreasuryWithdrawals":
            return { committee: cc, drep: bootstrap ? null : d("dvt_treasury_withdrawal"), pool: null };
        case "ParameterChange": {
            const g = paramGroups(changedKeys);
            const drepKeys: Rational[] = [];
            if (g.has("network")) drepKeys.push(d("dvt_p_p_network_group"));
            if (g.has("economic")) drepKeys.push(d("dvt_p_p_economic_group"));
            if (g.has("technical")) drepKeys.push(d("dvt_p_p_technical_group"));
            if (g.has("gov")) drepKeys.push(d("dvt_p_p_gov_group"));
            const pool = g.has("security") ? pv("pvt_p_p_security_group") : null;
            return { committee: cc, drep: bootstrap ? null : maxR(drepKeys), pool };
        }
    }
}

export function rationalOf(v: unknown, fallback: string): Rational {
    const s = String(v ?? fallback);
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return rationalOf(fallback, fallback);
    const frac = m[2] ?? "";
    return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}
