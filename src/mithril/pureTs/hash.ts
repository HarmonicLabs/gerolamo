/**
 * `createHash` for the pure-TS Mithril verifier without Node's `crypto`, so the same code runs
 * in Bun and in the browser (docs/PLAN_BROWSER_NODE.md). Same call shape as node:crypto:
 * `createHash(alg).update(a).update(b).digest()` → Uint8Array, `.digest("hex")` → string.
 */
import { blake2b } from "@noble/hashes/blake2b";
import { blake2s } from "@noble/hashes/blake2s";
import { sha256 } from "@noble/hashes/sha2";

export type HashAlgorithm = "sha256" | "blake2b256" | "blake2b512" | "blake2s256";

export interface Hasher {
    update(data: Uint8Array | string): Hasher;
    digest(): Uint8Array;
    digest(encoding: "hex"): string;
}

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function createHash(alg: HashAlgorithm | string): Hasher {
    const h = alg === "sha256" ? sha256.create()
        : alg === "blake2b256" ? blake2b.create({ dkLen: 32 })
        : alg === "blake2b512" ? blake2b.create({ dkLen: 64 })
        : alg === "blake2s256" ? blake2s.create({ dkLen: 32 })
        : null;
    if (!h) throw new Error(`unsupported hash ${alg}`);
    const hasher: Hasher = {
        update(data) { h.update(typeof data === "string" ? enc.encode(data) : data); return hasher; },
        digest(encoding?: "hex") { const out = h.digest(); return (encoding === "hex" ? toHex(out) : out) as any; },
    } as Hasher;
    return hasher;
}
