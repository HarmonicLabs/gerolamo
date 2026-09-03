/**
 * Validation is not a user choice. Every block a Gerolamo node applies is
 * checked as far as its ledger state allows:
 *
 * - Always: header (KES/VRF/op-cert or Byron OBFT), body hash, per-peer agreement.
 * - Ledger complete (sync from genesis, or a Mithril-populated DB): transaction
 *   rules are enforced — a failing block halts the applier (see SYNC HALTED).
 * - Ledger partial (sync from tip): there is no UTxO set behind the tip, so
 *   balance/fee/script checks cannot be evaluated. They run in report-only mode
 *   and the UI/logs say so. This is a property of tip sync, not an option.
 *
 * `bodyValidation` / `scriptValidation` in config.json are ignored (a warning is
 * logged once if they are present) and kept only so old files still load.
 */
export type BodyPolicy = "strict" | "soft";
export type ScriptPolicy = "strict" | "log";

export interface ValidationPolicy {
    /** False when syncing from tip without prior ledger state. */
    ledgerComplete: boolean;
    body: BodyPolicy;
    script: ScriptPolicy;
    /** Human sentence for logs/UI. */
    note: string;
}

export interface ValidationPolicyConfig {
    syncFromTip?: boolean;
    syncFromGenesis?: boolean;
    syncFromPoint?: boolean;
    bodyValidation?: unknown;
    scriptValidation?: unknown;
}

export function resolveValidationPolicy(config: ValidationPolicyConfig | undefined): ValidationPolicy {
    const tip = !!config?.syncFromTip && !config?.syncFromGenesis;
    if (tip) {
        return {
            ledgerComplete: false,
            body: "soft",
            script: "log",
            note:
                "Tip sync: no ledger state exists before the tip, so transaction rules and scripts are checked in report-only mode. " +
                "Headers, body hashes and peer agreement are still enforced. Sync from genesis (or Mithril) for a fully validated ledger.",
        };
    }
    return {
        ledgerComplete: true,
        body: "strict",
        script: "strict",
        note: "Full validation: headers, body hashes, peer agreement and transaction rules are enforced.",
    };
}

/** Config keys that no longer do anything; returned so the caller can warn once. */
export function ignoredValidationKeys(config: ValidationPolicyConfig | undefined): string[] {
    const out: string[] = [];
    if (config?.bodyValidation !== undefined) out.push(`bodyValidation=${String(config.bodyValidation)}`);
    if (config?.scriptValidation !== undefined) out.push(`scriptValidation=${String(config.scriptValidation)}`);
    return out;
}
