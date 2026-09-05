/**
 * Native (timelock) script evaluation, Shelley multisig + Allegra timelocks,
 * cardano-ledger `evalTimelock` / `evalMultiSigScript`:
 *
 *   sig h      — h ∈ verified vkey witness hashes
 *   all xs     — every child holds
 *   any xs     — some child holds
 *   atLeast n  — at least n children hold
 *   before s   — the tx's validity upper bound (ttl) is set and ttl ≤ s
 *                (RequireTimeExpire: the tx cannot be valid at or after s)
 *   after s    — the tx's validity lower bound is set and s ≤ start
 *                (RequireTimeStart: the tx cannot be valid before s)
 * Without the bound the time clause is false (the spec's SNothing case).
 */
import type { NativeScript } from "@harmoniclabs/cardano-ledger-ts";

export interface TimelockContext {
    /** Verified vkey witness key hashes, lowercase hex. */
    signers: ReadonlySet<string>;
    /** Validity interval lower bound (Allegra+ `validity_interval_start`), when set. */
    validFrom?: bigint | null;
    /** Validity interval upper bound (`ttl`), when set. */
    validTo?: bigint | null;
}

function hex(v: unknown): string {
    if (typeof v === "string") return v.toLowerCase();
    if (v && typeof (v as { toString(): string }).toString === "function") return String(v).toLowerCase();
    return "";
}

export function evalNativeScript(script: NativeScript, ctx: TimelockContext): boolean {
    const s = script as any;
    switch (s.type) {
        case "sig":
            return ctx.signers.has(hex(s.keyHash));
        case "all":
            return (s.scripts as NativeScript[]).every((c) => evalNativeScript(c, ctx));
        case "any":
            return (s.scripts as NativeScript[]).some((c) => evalNativeScript(c, ctx));
        case "atLeast": {
            const need = Number(s.required);
            let n = 0;
            for (const c of s.scripts as NativeScript[]) if (evalNativeScript(c, ctx)) n++;
            return n >= need;
        }
        case "before":
            return ctx.validTo != null && ctx.validTo <= BigInt(s.slot);
        case "after":
            return ctx.validFrom != null && BigInt(s.slot) <= ctx.validFrom;
        default:
            return false;
    }
}

/**
 * The native-script JSON tree of a witness-set entry. ledger-ts wraps native
 * scripts in `Script` (whose `nativeScript` is a *method*, not a field); older
 * decoders hand back the tree itself.
 */
export function nativeScriptTreeOf(script: any): NativeScript | null {
    if (!script) return null;
    if (typeof script.type === "string" && script.type !== "NativeScript") return script as NativeScript;
    try {
        if (typeof script.nativeScript === "function") return script.nativeScript() ?? null;
        if (script.nativeScript && typeof script.nativeScript === "object") return script.nativeScript as NativeScript;
        if (typeof script.toJson === "function") {
            const j = script.toJson();
            return j && typeof j.type === "string" ? (j as NativeScript) : null;
        }
    } catch {
        return null;
    }
    return null;
}
