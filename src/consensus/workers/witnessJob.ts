/**
 * Witness signature verification as a validation-pool job: pure ed25519 over
 * (signature, message, public key) triples, so the main thread only decides
 * which keys signed and which keys were required.
 */
import { verifyEd25519Fast } from "../fastEd25519";

export interface WitnessItem {
    /** 32-byte ed25519 public key (Byron 64-byte keys are trimmed by the caller). */
    publicKey: Uint8Array;
    signature: Uint8Array;
    message: Uint8Array;
}

export interface WitnessVerifyJob {
    kind: "witnesses";
    items: WitnessItem[];
}

export interface WitnessVerifyResult {
    /** One flag per item, in order. */
    ok: boolean[];
}

export function isWitnessVerifyJob(job: unknown): job is WitnessVerifyJob {
    return !!job && typeof job === "object" && (job as { kind?: unknown }).kind === "witnesses";
}

export function runWitnessVerifyJob(job: WitnessVerifyJob): WitnessVerifyResult {
    const ok = job.items.map((it) => {
        try {
            return it.publicKey.length === 32 && it.signature.length === 64 && verifyEd25519Fast(it.signature, it.message, it.publicKey);
        } catch {
            return false;
        }
    });
    return { ok };
}
