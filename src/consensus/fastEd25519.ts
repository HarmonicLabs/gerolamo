import { verifyEd25519Signature_sync } from "@harmoniclabs/crypto";
import { logger } from "../utils/logger";

/**
 * Raw ed25519 verify for header checks (operational cert, KES leaf).
 *
 * `@harmoniclabs/crypto` exposes two pure-TS implementations: the textbook
 * BigInt one behind `verifyEd25519Signature_sync` (~30 ms per verify on a
 * laptop core) and the noble-curves port it bundles under `dist/noble`
 * (~1 ms). Both are ours and both are pure TypeScript — no WASM, no native
 * binding. Header validation needs two verifies per header, so the choice is
 * the difference between ~15 and ~500 headers/s per core.
 *
 * The noble module is a deep import (the package has no exports map); if it
 * ever moves we log once and fall back to the slow verifier, never to
 * "skip".
 */
export type Ed25519Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;

type NobleEd25519 = { ed25519: { verify: (sig: Uint8Array, msg: Uint8Array, pk: Uint8Array, opts?: unknown) => boolean } };

let impl: Ed25519Verify | null = null;
let implName = "slow";

function loadNoble(): Ed25519Verify | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("@harmoniclabs/crypto/dist/noble/ed25519.js") as NobleEd25519;
        const verify = mod?.ed25519?.verify;
        if (typeof verify !== "function") return null;
        // zip215 = false matches the strict RFC 8032 semantics cardano-node uses
        // (libsodium-style cofactorless verification of canonical encodings).
        return (sig, msg, pk) => {
            try {
                return verify(sig, msg, pk, { zip215: false });
            } catch {
                return false;
            }
        };
    } catch {
        return null;
    }
}

/** Resolve once, lazily. */
export function ed25519Verify(): Ed25519Verify {
    if (impl) return impl;
    const noble = loadNoble();
    if (noble) {
        impl = noble;
        implName = "noble";
    } else {
        impl = (sig, msg, pk) => {
            try {
                return verifyEd25519Signature_sync(sig, msg, pk);
            } catch {
                return false;
            }
        };
        implName = "slow";
        logger.warn("fastEd25519: noble ed25519 not found in @harmoniclabs/crypto; using the slow BigInt verifier");
    }
    return impl;
}

export function ed25519ImplName(): string {
    ed25519Verify();
    return implName;
}

/** Convenience wrapper. */
export function verifyEd25519Fast(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    return ed25519Verify()(signature, message, publicKey);
}
