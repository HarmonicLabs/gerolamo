/**
 * BLAKE2b (RFC 7693), one-shot and unkeyed, for the hash builtins (builtins.ts).
 *
 * The on-chain inputs are short (a `blake2b_256` of 32 or 64 bytes is the common case: one compression),
 * so the cost of a streaming hasher — an object with twenty fields, an options record, a buffer and its
 * views, the work vector read from and written back to a typed array around every mixing step, a
 * BigInt for the counter, and a copy of the digest — exceeds the arithmetic. Here the sixteen 64-bit
 * words of the work vector are thirty-two int32 locals, the eight G mixes of a round are written out
 * (`compress`), the carries of the 64-bit additions are computed with int32 operations only, the
 * message words are read straight from the input (zero-padded in the word buffer for the last block)
 * and the only allocation is the digest. Output is bit-identical to a
 * reference implementation on every input length (blake2b.test.ts checks 0 … 4096 against @noble/hashes
 * and the RFC 7693 vector). Not reentrant (module-level scratch state); a hash never calls out, so that
 * is safe. Inputs are at most 65536 bytes on chain (`CByteString`); the counter is exact below 2^53.
 */

// IV = the first 64 bits of the fractional parts of the square roots of the first eight primes, as (lo, hi) int32 pairs.
const IV = Int32Array.of(
    0xf3bcc908 | 0, 0x6a09e667 | 0, 0x84caa73b | 0, 0xbb67ae85 | 0, 0xfe94f82b | 0, 0x3c6ef372 | 0, 0x5f1d36f1 | 0, 0xa54ff53a | 0,
    0xade682d1 | 0, 0x510e527f | 0, 0x2b3e6c1f | 0, 0x9b05688c | 0, 0xfb41bd6b | 0, 0x1f83d9ab | 0, 0x137e2179 | 0, 0x5be0cd19 | 0,
);
/** The message schedule of the twelve rounds (RFC 7693 §2.7, rounds 10 and 11 repeat 0 and 1), as indexes into the (lo, hi) word array. */
const S2 = Uint8Array.from([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
    7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
    2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
    13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
    10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
], (x) => 2 * x);
/** The chaining value h (16 int32: lo, hi per 64-bit word). */
const H = new Int32Array(16);
/** The current message block as 16 little-endian 64-bit words (32 int32). */
const M = new Int32Array(32);

/** Load the 128 bytes at `off` of `b` into M (little-endian words). */
function loadBlock(b: Uint8Array, off: number): void {
    for (let i = 0, p = off; i < 32; i++, p += 4) M[i] = b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24);
}

/** Load the last `rem` (< 128) bytes at `off` of `b` into M, zero-padded: whole words straight from the input, the tail word byte by byte. */
function loadPartial(b: Uint8Array, off: number, rem: number): void {
    const words = rem >> 2;
    let i = 0, p = off;
    for (; i < words; i++, p += 4) M[i] = b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24);
    if (i < 32) {
        let w = 0;
        for (let k = 0; k < (rem & 3); k++) w |= b[p + k]! << (k << 3);
        M[i++] = w;
        for (; i < 32; i++) M[i] = 0;
    }
}

/**
 * One compression of M into H with the byte counter `t` (an integer below 2^53) and the final-block flag.
 * The round body is the eight mixes G(a, b, c, d) of RFC 7693 §3.1 written out on the (lo, hi) int32
 * pairs — columns (0, 4, 8, 12) … (3, 7, 11, 15), then diagonals (0, 5, 10, 15) … (3, 4, 9, 14) — with x
 * and y the two scheduled message words of each:
 *   a += b + x; d = rotr32(d ^ a); c += d; b = rotr24(b ^ c); a += b + y; d = rotr16(d ^ a); c += d; b = rotr63(b ^ c)
 * A 64-bit addition is lo' = lo₁ + lo₂ (mod 2^32), carry = the top bit of (lo₁ ∧ lo₂) ∨ ((lo₁ ∨ lo₂) ∧ ¬lo'),
 * hi' = hi₁ + hi₂ + carry (a three-term sum carries twice); rotr32 swaps the halves, rotr24 and rotr16
 * shift across them, rotr63 is a rotate left by one. Every statement is int32-typed (`| 0`, `^`, `>>>` of
 * a constant), so the JIT keeps the whole vector in machine integers.
 */
function compress(count: number, last: boolean): void {
    let v0l = H[0]!, v0h = H[1]!, v1l = H[2]!, v1h = H[3]!, v2l = H[4]!, v2h = H[5]!, v3l = H[6]!, v3h = H[7]!;
    let v4l = H[8]!, v4h = H[9]!, v5l = H[10]!, v5h = H[11]!, v6l = H[12]!, v6h = H[13]!, v7l = H[14]!, v7h = H[15]!;
    let v8l = IV[0]!, v8h = IV[1]!, v9l = IV[2]!, v9h = IV[3]!, v10l = IV[4]!, v10h = IV[5]!, v11l = IV[6]!, v11h = IV[7]!;
    // v12 ^= t (low 64 bits of the counter); v13 ^= 0 (its high 64 bits: never reached); v14 inverted on the last block
    let v12l = IV[8]! ^ (count | 0), v12h = IV[9]! ^ ((count / 4294967296) | 0), v13l = IV[10]!, v13h = IV[11]!;
    let v14l = IV[12]!, v14h = IV[13]!, v15l = IV[14]!, v15h = IV[15]!;
    if (last) { v14l = ~v14l; v14h = ~v14h; }
    let t = 0, u = 0, c = 0, k = 0, xl = 0, xh = 0, yl = 0, yh = 0;
    for (let r = 0, j = 0; r < 12; r++) {
        // G0
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v0l + v4l) | 0; c = ((v0l & v4l) | ((v0l | v4l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v0l = u; v0h = (v0h + v4h + xh + c) | 0;
        t = v12l ^ v0l; v12l = v12h ^ v0h; v12h = t;
        t = (v8l + v12l) | 0; c = ((v8l & v12l) | ((v8l | v12l) & ~t)) >>> 31; v8l = t; v8h = (v8h + v12h + c) | 0;
        t = v4l ^ v8l; u = v4h ^ v8h; v4l = (t >>> 24) | (u << 8); v4h = (u >>> 24) | (t << 8);
        t = (v0l + v4l) | 0; c = ((v0l & v4l) | ((v0l | v4l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v0l = u; v0h = (v0h + v4h + yh + c) | 0;
        t = v12l ^ v0l; u = v12h ^ v0h; v12l = (t >>> 16) | (u << 16); v12h = (u >>> 16) | (t << 16);
        t = (v8l + v12l) | 0; c = ((v8l & v12l) | ((v8l | v12l) & ~t)) >>> 31; v8l = t; v8h = (v8h + v12h + c) | 0;
        t = v4l ^ v8l; u = v4h ^ v8h; v4l = (t << 1) | (u >>> 31); v4h = (u << 1) | (t >>> 31);
        // G1
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v1l + v5l) | 0; c = ((v1l & v5l) | ((v1l | v5l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v1l = u; v1h = (v1h + v5h + xh + c) | 0;
        t = v13l ^ v1l; v13l = v13h ^ v1h; v13h = t;
        t = (v9l + v13l) | 0; c = ((v9l & v13l) | ((v9l | v13l) & ~t)) >>> 31; v9l = t; v9h = (v9h + v13h + c) | 0;
        t = v5l ^ v9l; u = v5h ^ v9h; v5l = (t >>> 24) | (u << 8); v5h = (u >>> 24) | (t << 8);
        t = (v1l + v5l) | 0; c = ((v1l & v5l) | ((v1l | v5l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v1l = u; v1h = (v1h + v5h + yh + c) | 0;
        t = v13l ^ v1l; u = v13h ^ v1h; v13l = (t >>> 16) | (u << 16); v13h = (u >>> 16) | (t << 16);
        t = (v9l + v13l) | 0; c = ((v9l & v13l) | ((v9l | v13l) & ~t)) >>> 31; v9l = t; v9h = (v9h + v13h + c) | 0;
        t = v5l ^ v9l; u = v5h ^ v9h; v5l = (t << 1) | (u >>> 31); v5h = (u << 1) | (t >>> 31);
        // G2
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v2l + v6l) | 0; c = ((v2l & v6l) | ((v2l | v6l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v2l = u; v2h = (v2h + v6h + xh + c) | 0;
        t = v14l ^ v2l; v14l = v14h ^ v2h; v14h = t;
        t = (v10l + v14l) | 0; c = ((v10l & v14l) | ((v10l | v14l) & ~t)) >>> 31; v10l = t; v10h = (v10h + v14h + c) | 0;
        t = v6l ^ v10l; u = v6h ^ v10h; v6l = (t >>> 24) | (u << 8); v6h = (u >>> 24) | (t << 8);
        t = (v2l + v6l) | 0; c = ((v2l & v6l) | ((v2l | v6l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v2l = u; v2h = (v2h + v6h + yh + c) | 0;
        t = v14l ^ v2l; u = v14h ^ v2h; v14l = (t >>> 16) | (u << 16); v14h = (u >>> 16) | (t << 16);
        t = (v10l + v14l) | 0; c = ((v10l & v14l) | ((v10l | v14l) & ~t)) >>> 31; v10l = t; v10h = (v10h + v14h + c) | 0;
        t = v6l ^ v10l; u = v6h ^ v10h; v6l = (t << 1) | (u >>> 31); v6h = (u << 1) | (t >>> 31);
        // G3
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v3l + v7l) | 0; c = ((v3l & v7l) | ((v3l | v7l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v3l = u; v3h = (v3h + v7h + xh + c) | 0;
        t = v15l ^ v3l; v15l = v15h ^ v3h; v15h = t;
        t = (v11l + v15l) | 0; c = ((v11l & v15l) | ((v11l | v15l) & ~t)) >>> 31; v11l = t; v11h = (v11h + v15h + c) | 0;
        t = v7l ^ v11l; u = v7h ^ v11h; v7l = (t >>> 24) | (u << 8); v7h = (u >>> 24) | (t << 8);
        t = (v3l + v7l) | 0; c = ((v3l & v7l) | ((v3l | v7l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v3l = u; v3h = (v3h + v7h + yh + c) | 0;
        t = v15l ^ v3l; u = v15h ^ v3h; v15l = (t >>> 16) | (u << 16); v15h = (u >>> 16) | (t << 16);
        t = (v11l + v15l) | 0; c = ((v11l & v15l) | ((v11l | v15l) & ~t)) >>> 31; v11l = t; v11h = (v11h + v15h + c) | 0;
        t = v7l ^ v11l; u = v7h ^ v11h; v7l = (t << 1) | (u >>> 31); v7h = (u << 1) | (t >>> 31);
        // G4
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v0l + v5l) | 0; c = ((v0l & v5l) | ((v0l | v5l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v0l = u; v0h = (v0h + v5h + xh + c) | 0;
        t = v15l ^ v0l; v15l = v15h ^ v0h; v15h = t;
        t = (v10l + v15l) | 0; c = ((v10l & v15l) | ((v10l | v15l) & ~t)) >>> 31; v10l = t; v10h = (v10h + v15h + c) | 0;
        t = v5l ^ v10l; u = v5h ^ v10h; v5l = (t >>> 24) | (u << 8); v5h = (u >>> 24) | (t << 8);
        t = (v0l + v5l) | 0; c = ((v0l & v5l) | ((v0l | v5l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v0l = u; v0h = (v0h + v5h + yh + c) | 0;
        t = v15l ^ v0l; u = v15h ^ v0h; v15l = (t >>> 16) | (u << 16); v15h = (u >>> 16) | (t << 16);
        t = (v10l + v15l) | 0; c = ((v10l & v15l) | ((v10l | v15l) & ~t)) >>> 31; v10l = t; v10h = (v10h + v15h + c) | 0;
        t = v5l ^ v10l; u = v5h ^ v10h; v5l = (t << 1) | (u >>> 31); v5h = (u << 1) | (t >>> 31);
        // G5
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v1l + v6l) | 0; c = ((v1l & v6l) | ((v1l | v6l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v1l = u; v1h = (v1h + v6h + xh + c) | 0;
        t = v12l ^ v1l; v12l = v12h ^ v1h; v12h = t;
        t = (v11l + v12l) | 0; c = ((v11l & v12l) | ((v11l | v12l) & ~t)) >>> 31; v11l = t; v11h = (v11h + v12h + c) | 0;
        t = v6l ^ v11l; u = v6h ^ v11h; v6l = (t >>> 24) | (u << 8); v6h = (u >>> 24) | (t << 8);
        t = (v1l + v6l) | 0; c = ((v1l & v6l) | ((v1l | v6l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v1l = u; v1h = (v1h + v6h + yh + c) | 0;
        t = v12l ^ v1l; u = v12h ^ v1h; v12l = (t >>> 16) | (u << 16); v12h = (u >>> 16) | (t << 16);
        t = (v11l + v12l) | 0; c = ((v11l & v12l) | ((v11l | v12l) & ~t)) >>> 31; v11l = t; v11h = (v11h + v12h + c) | 0;
        t = v6l ^ v11l; u = v6h ^ v11h; v6l = (t << 1) | (u >>> 31); v6h = (u << 1) | (t >>> 31);
        // G6
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v2l + v7l) | 0; c = ((v2l & v7l) | ((v2l | v7l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v2l = u; v2h = (v2h + v7h + xh + c) | 0;
        t = v13l ^ v2l; v13l = v13h ^ v2h; v13h = t;
        t = (v8l + v13l) | 0; c = ((v8l & v13l) | ((v8l | v13l) & ~t)) >>> 31; v8l = t; v8h = (v8h + v13h + c) | 0;
        t = v7l ^ v8l; u = v7h ^ v8h; v7l = (t >>> 24) | (u << 8); v7h = (u >>> 24) | (t << 8);
        t = (v2l + v7l) | 0; c = ((v2l & v7l) | ((v2l | v7l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v2l = u; v2h = (v2h + v7h + yh + c) | 0;
        t = v13l ^ v2l; u = v13h ^ v2h; v13l = (t >>> 16) | (u << 16); v13h = (u >>> 16) | (t << 16);
        t = (v8l + v13l) | 0; c = ((v8l & v13l) | ((v8l | v13l) & ~t)) >>> 31; v8l = t; v8h = (v8h + v13h + c) | 0;
        t = v7l ^ v8l; u = v7h ^ v8h; v7l = (t << 1) | (u >>> 31); v7h = (u << 1) | (t >>> 31);
        // G7
        k = S2[j]!; xl = M[k]!; xh = M[k + 1]!; k = S2[j + 1]!; yl = M[k]!; yh = M[k + 1]!; j += 2;
        t = (v3l + v4l) | 0; c = ((v3l & v4l) | ((v3l | v4l) & ~t)) >>> 31; u = (t + xl) | 0; c = (c + (((t & xl) | ((t | xl) & ~u)) >>> 31)) | 0; v3l = u; v3h = (v3h + v4h + xh + c) | 0;
        t = v14l ^ v3l; v14l = v14h ^ v3h; v14h = t;
        t = (v9l + v14l) | 0; c = ((v9l & v14l) | ((v9l | v14l) & ~t)) >>> 31; v9l = t; v9h = (v9h + v14h + c) | 0;
        t = v4l ^ v9l; u = v4h ^ v9h; v4l = (t >>> 24) | (u << 8); v4h = (u >>> 24) | (t << 8);
        t = (v3l + v4l) | 0; c = ((v3l & v4l) | ((v3l | v4l) & ~t)) >>> 31; u = (t + yl) | 0; c = (c + (((t & yl) | ((t | yl) & ~u)) >>> 31)) | 0; v3l = u; v3h = (v3h + v4h + yh + c) | 0;
        t = v14l ^ v3l; u = v14h ^ v3h; v14l = (t >>> 16) | (u << 16); v14h = (u >>> 16) | (t << 16);
        t = (v9l + v14l) | 0; c = ((v9l & v14l) | ((v9l | v14l) & ~t)) >>> 31; v9l = t; v9h = (v9h + v14h + c) | 0;
        t = v4l ^ v9l; u = v4h ^ v9h; v4l = (t << 1) | (u >>> 31); v4h = (u << 1) | (t >>> 31);
    }
    H[0] ^= v0l ^ v8l; H[1] ^= v0h ^ v8h; H[2] ^= v1l ^ v9l; H[3] ^= v1h ^ v9h;
    H[4] ^= v2l ^ v10l; H[5] ^= v2h ^ v10h; H[6] ^= v3l ^ v11l; H[7] ^= v3h ^ v11h;
    H[8] ^= v4l ^ v12l; H[9] ^= v4h ^ v12h; H[10] ^= v5l ^ v13l; H[11] ^= v5h ^ v13h;
    H[12] ^= v6l ^ v14l; H[13] ^= v6h ^ v14h; H[14] ^= v7l ^ v15l; H[15] ^= v7h ^ v15h;
}

/** Unkeyed BLAKE2b of `msg` with a digest of `outLen` bytes (1 … 64). */
export function blake2b(msg: Uint8Array, outLen: number): Uint8Array {
    if (!(outLen >= 1 && outLen <= 64)) throw new RangeError(`blake2b: digest length ${outLen} is not 1 … 64`);
    // h = IV, h₀ ^= parameter block word 0: digest length | key length << 8 | fanout 1 << 16 | depth 1 << 24
    H[0] = IV[0]! ^ (0x01010000 | outLen); H[1] = IV[1]!; H[2] = IV[2]!; H[3] = IV[3]!; H[4] = IV[4]!; H[5] = IV[5]!; H[6] = IV[6]!; H[7] = IV[7]!;
    H[8] = IV[8]!; H[9] = IV[9]!; H[10] = IV[10]!; H[11] = IV[11]!; H[12] = IV[12]!; H[13] = IV[13]!; H[14] = IV[14]!; H[15] = IV[15]!;
    const n = msg.length;
    let off = 0, t = 0;
    while (n - off > 128) { loadBlock(msg, off); off += 128; t += 128; compress(t, false); }
    // the final block (full, partial or — for the empty message — all zero), always compressed as the last one
    const rem = n - off;
    if (rem === 128) loadBlock(msg, off);
    else loadPartial(msg, off, rem);
    compress(t + rem, true);
    // the digest: the first outLen bytes of h, little-endian words
    const out = new Uint8Array(outLen);
    const whole = outLen >> 2;
    let i = 0, p = 0;
    for (; i < whole; i++, p += 4) { const w = H[i]!; out[p] = w; out[p + 1] = w >>> 8; out[p + 2] = w >>> 16; out[p + 3] = w >>> 24; }
    for (let w = H[i]!; p < outLen; p++, w >>>= 8) out[p] = w;
    return out;
}
export const blake2b_256 = (msg: Uint8Array): Uint8Array => blake2b(msg, 32);
export const blake2b_224 = (msg: Uint8Array): Uint8Array => blake2b(msg, 28);
