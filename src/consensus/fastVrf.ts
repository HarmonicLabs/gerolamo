/**
 * ECVRF-ED25519-SHA512-Elligator2 (IETF draft-03) proof verification on
 * @noble/curves' ed25519 arithmetic — the same construction libsodium's
 * `crypto_vrf_ietfdraft03_verify` implements, which Cardano headers use for the
 * leader and nonce VRFs.
 *
 * Proof (80 bytes): Γ (32, compressed Edwards) ‖ c (16) ‖ s (32, little-endian scalar).
 *
 *   H  = hash_to_curve(Y, α)        (Elligator2 on SHA-512(suite ‖ 01 ‖ Y ‖ α)[0..32], sign bit cleared, ×8)
 *   U  = s·B − c·Y
 *   V  = s·H − c·Γ
 *   c' = SHA-512(suite ‖ 02 ‖ H ‖ Γ ‖ U ‖ V)[0..16]
 *   valid ⇔ c' = c,  output β = SHA-512(suite ‖ 03 ‖ 8Γ)
 *
 * The pure-BigInt reference in @harmoniclabs/crypto is ~80 ms per proof; this
 * is a few hundred µs. `scripts/verify-fast-vrf.ts` cross-checks both against
 * stored headers.
 *
 * `vrf03Prove` is the matching prover (libsodium `crypto_vrf_ietfdraft03_prove`)
 * for our own leader schedule and headers; it is deterministic and reproduces
 * `VrfProof03.generate` byte for byte (see fastVrf.test.ts).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha2";

const SUITE = 0x04;
const Point = ed25519.Point;
const Fp = ed25519.CURVE.Fp;
const uvRatio: (u: bigint, v: bigint) => { isValid: boolean; value: bigint } = (ed25519.CURVE as any).uvRatio;
const P = Fp.ORDER;
const N = ed25519.CURVE.n;
const A = 486662n; // Montgomery curve25519 coefficient
const ONE = 1n;

function leBytesToBigint(bytes: Uint8Array): bigint {
    let x = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
    return x;
}

function bigintToLeBytes(x: bigint, len = 32): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
    }
    return out;
}

/**
 * curve25519-dalek `MontgomeryPoint::elligator_encode(r)` followed by
 * `to_edwards(sign = 0)` and `mul_by_cofactor()` — the draft-03 hash-to-curve
 * with the sign bit always cleared.
 */
export function elligator2ToEdwards(rBytes32: Uint8Array): InstanceType<typeof Point> {
    const r0 = leBytesToBigint(rBytes32) & ((1n << 255n) - 1n); // fe_frombytes ignores the top bit
    const r = Fp.create(r0);
    const d1 = Fp.add(ONE, Fp.mul(2n, Fp.sqr(r))); // 1 + 2r²
    const d = Fp.mul(Fp.neg(A), Fp.inv(d1)); // −A / (1 + 2r²)
    const dSq = Fp.sqr(d);
    const au = Fp.mul(A, d);
    const inner = Fp.add(Fp.add(dSq, au), ONE);
    const eps = Fp.mul(d, inner); // d³ + A·d² + d
    const epsIsSquare = uvRatio(eps, ONE).isValid;
    let u = epsIsSquare ? d : Fp.add(d, A);
    if (!epsIsSquare) u = Fp.neg(u); // −d − A
    // Montgomery u → Edwards y = (u − 1)/(u + 1); x recovered with sign bit 0
    const y = Fp.mul(Fp.sub(u, ONE), Fp.inv(Fp.add(u, ONE)));
    const yBytes = bigintToLeBytes(y);
    yBytes[31]! &= 0x7f; // sign bit 0
    const point = Point.fromBytes(yBytes);
    return point.multiplyUnsafe(8n);
}

function hashToCurve(publicKey: Uint8Array, alpha: Uint8Array): InstanceType<typeof Point> {
    const input = new Uint8Array(2 + publicKey.length + alpha.length);
    input[0] = SUITE;
    input[1] = 0x01;
    input.set(publicKey, 2);
    input.set(alpha, 2 + publicKey.length);
    return elligator2ToEdwards(sha512(input).slice(0, 32));
}

function challenge(h: Uint8Array, gamma: Uint8Array, u: Uint8Array, v: Uint8Array): Uint8Array {
    const input = new Uint8Array(2 + 4 * 32);
    input[0] = SUITE;
    input[1] = 0x02;
    input.set(h, 2);
    input.set(gamma, 34);
    input.set(u, 66);
    input.set(v, 98);
    return sha512(input).slice(0, 16);
}

/** β = SHA-512(suite ‖ 03 ‖ 8Γ) — the 64-byte VRF output carried in block headers. */
export function vrf03ProofToHash(proof: Uint8Array): Uint8Array | null {
    if (proof.length !== 80) return null;
    let gamma: InstanceType<typeof Point>;
    try {
        gamma = Point.fromBytes(proof.subarray(0, 32));
    } catch {
        return null;
    }
    const input = new Uint8Array(34);
    input[0] = SUITE;
    input[1] = 0x03;
    input.set(gamma.multiplyUnsafe(8n).toBytes(), 2);
    return sha512(input);
}

/**
 * Verify a draft-03 proof for `publicKey` and `alpha`. Returns the VRF output on
 * success, null otherwise. Rejects small-order keys and non-canonical scalars
 * the way libsodium does.
 */
export function vrf03Verify(publicKey: Uint8Array, alpha: Uint8Array, proof: Uint8Array): Uint8Array | null {
    if (proof.length !== 80 || publicKey.length !== 32) return null;
    let y: InstanceType<typeof Point>, gamma: InstanceType<typeof Point>;
    try {
        y = Point.fromBytes(publicKey);
        gamma = Point.fromBytes(proof.subarray(0, 32));
    } catch {
        return null;
    }
    if (y.isSmallOrder()) return null;
    const cBytes = proof.subarray(32, 48);
    const c = leBytesToBigint(cBytes);
    const s = leBytesToBigint(proof.subarray(48, 80));
    if (s >= N) return null; // non-canonical response
    let h: InstanceType<typeof Point>;
    try {
        h = hashToCurve(publicKey, alpha);
    } catch {
        return null;
    }
    const sB = s === 0n ? Point.ZERO : Point.BASE.multiplyUnsafe(s);
    const cY = c === 0n ? Point.ZERO : y.multiplyUnsafe(c);
    const sH = s === 0n ? Point.ZERO : h.multiplyUnsafe(s);
    const cG = c === 0n ? Point.ZERO : gamma.multiplyUnsafe(c);
    const u = sB.subtract(cY);
    const v = sH.subtract(cG);
    const cPrime = challenge(h.toBytes(), gamma.toBytes(), u.toBytes(), v.toBytes());
    for (let i = 0; i < 16; i++) if (cPrime[i] !== cBytes[i]) return null;
    return vrf03ProofToHash(proof);
}

/**
 * Draft-03 prove for a 32-byte seed (the first half of `vrf.skey`) and its
 * public key: deterministic, same bytes as libsodium / VrfProof03.generate.
 *
 *   (x, hs) = SHA-512(seed): x clamped scalar, hs the nonce prefix
 *   H = hash_to_curve(Y, α);  Γ = x·H
 *   k = SHA-512(hs ‖ H) mod q
 *   c = SHA-512(suite ‖ 02 ‖ H ‖ Γ ‖ k·B ‖ k·H)[0..16];  s = k + c·x mod q
 */
export function vrf03Prove(seed: Uint8Array, publicKey: Uint8Array, alpha: Uint8Array): Uint8Array {
    if (seed.length !== 32 || publicKey.length !== 32) throw new Error("vrf03Prove: seed and public key must be 32 bytes");
    const az = sha512(seed);
    const xBytes = az.slice(0, 32);
    xBytes[0]! &= 248; xBytes[31]! &= 127; xBytes[31]! |= 64; // ed25519 clamping
    const x = leBytesToBigint(xBytes);
    const h = hashToCurve(publicKey, alpha);
    const hBytes = h.toBytes();
    const gamma = h.multiplyUnsafe(x % N);
    const kInput = new Uint8Array(64); kInput.set(az.subarray(32, 64), 0); kInput.set(hBytes, 32);
    const k = leBytesToBigint(sha512(kInput)) % N;
    const kB = k === 0n ? Point.ZERO : Point.BASE.multiplyUnsafe(k);
    const kH = k === 0n ? Point.ZERO : h.multiplyUnsafe(k);
    const gammaBytes = gamma.toBytes();
    const c = challenge(hBytes, gammaBytes, kB.toBytes(), kH.toBytes());
    const s = (k + leBytesToBigint(c) * x) % N;
    const proof = new Uint8Array(80);
    proof.set(gammaBytes, 0); proof.set(c, 32); proof.set(bigintToLeBytes(s), 48);
    return proof;
}
