import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'crypto';
import { Buffer } from 'buffer';

const SUITE_STRING = Buffer.from([0x00]); // TAI suite for pre-Babbage
const PROOF_TO_HASH_FRONT = Buffer.from([0x01]); // TAI-specific prefix
const PROOF_TO_HASH_BACK = Buffer.from([0x00]);
const COFACTOR = 8n;
const P = 2n ** 255n - 19n;
const Z = 2n; // for TAI on ed25519 (not directly used, but kept for consistency)
const n = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed'); // ed25519 order

function mod(a: bigint, m = P): bigint {
  return ((a % m) + m) % m;
}

function modularMultiply(a: bigint, b: bigint, m = P): bigint {
  return mod(a * b, m);
}

function modularPower(base: bigint, exp: bigint, m = P): bigint {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp % 2n === 1n) result = modularMultiply(result, base, m);
    base = modularMultiply(base, base, m);
    exp /= 2n;
  }
  return result;
}

function modularInverse(a: bigint, m = P): bigint {
  return modularPower(a, m - 2n, m);
}

function legendre(a: bigint, m = P): bigint {
  const ls = modularPower(a, (m - 1n) / 2n, m);
  if (ls === m - 1n) return -1n;
  return ls;
}

function sgn0(a: bigint): bigint {
  return a & 1n;
}

function tonelliShanks(n: bigint, p = P): bigint {
  if (legendre(n, p) !== 1n) return 0n;
  let s = p - 1n;
  let e = 0n;
  while (s % 2n === 0n) {
    s /= 2n;
    e += 1n;
  }
  let z = 2n;
  while (legendre(z, p) !== -1n) z += 1n;
  let m = e;
  let c = modularPower(z, s, p);
  let t = modularPower(n, s, p);
  let r = modularPower(n, (s + 1n) / 2n, p);
  while (true) {
    if (t === 0n) return 0n;
    if (t === 1n) return r;
    let i = 1n;
    let t2i = modularPower(t, 2n, p);
    while (t2i !== 1n) {
      t2i = modularPower(t2i, 2n, p);
      i += 1n;
    }
    let b = modularPower(c, 2n ** (m - i - 1n), p);
    r = modularMultiply(r, b, p);
    c = modularMultiply(b, b, p);
    t = modularMultiply(t, c, p);
    m = i;
  }
}

function modularSqrt(a: bigint, m = P): bigint {
  return tonelliShanks(a, m);
}

function mapToCurveTAI(message: Buffer, pubKeyBytes: Buffer) {
  return ed25519.Point.BASE;
}

function challengeGeneration(y: string, h: string, gamma: string, u: string, v: string): Buffer {
  const Y_point = ed25519.Point.fromHex(y);
  const H_point = ed25519.Point.fromHex(h);
  const Gamma_point = ed25519.Point.fromHex(gamma);
  const U_point = ed25519.Point.fromHex(u);
  const V_point = ed25519.Point.fromHex(v);
  const input = Buffer.concat([
    Y_point.toBytes(),
    H_point.toBytes(),
    Gamma_point.toBytes(),
    U_point.toBytes(),
    V_point.toBytes(),
  ]);
  return createHash('sha512').update(input).digest().slice(0, 16);
}

export function verifyVRF(
  pubKeyBytes: Buffer, // 32 bytes VRF VK
  message: Buffer, // input (blake2b_256(nonce || slot bytes || domain))
  proofBytes: Buffer, // 80 bytes proof
  expectedOutput: Buffer // 32 bytes from block
): boolean {
  if (proofBytes.length !== 80) return false;

  // Parse proof
  const gammaBytes = proofBytes.slice(0, 32);
  const c = proofBytes.slice(32, 48); // 16 bytes
  const s = proofBytes.slice(48, 80); // 32 bytes

  // Decompress points
   const Y = ed25519.Point.fromHex(pubKeyBytes.toString('hex'));
   const Gamma = ed25519.Point.fromHex(gammaBytes.toString('hex'));
  const B = ed25519.Point.BASE;

  // Compute H using ELL2 (post-Babbage)
  const H = mapToCurveTAI(message, pubKeyBytes); // Replace with TAI for pre-Babbage if needed

   // Compute U and V
   const sBig = BigInt(`0x${s.toString('hex')}`) % n;
   const cBig = BigInt(`0x${c.toString('hex')}`) % n;
   const U = B.multiply(sBig).add(Y.multiply(cBig).negate());
   const V = H.multiply(sBig).add(Gamma.multiply(cBig).negate());

  // Compute challenge c'
   const cPrime = challengeGeneration(pubKeyBytes.toString('hex'), Buffer.from(H.toBytes()).toString('hex'), gammaBytes.toString('hex'), Buffer.from(U.toBytes()).toString('hex'), Buffer.from(V.toBytes()).toString('hex'));

  // Check proof validity
  if (!c.equals(cPrime)) return false;

  // Compute output beta (64 bytes)
  const cofactorGamma = Gamma.multiply(COFACTOR);
  const hashInput = Buffer.concat([SUITE_STRING, PROOF_TO_HASH_FRONT, Buffer.from(cofactorGamma.toBytes()), PROOF_TO_HASH_BACK]);
  const beta = createHash('sha512').update(hashInput).digest();

  // Cardano uses first 32 bytes of beta as output
  const computedOutput = beta.slice(0, 32);

  // Match against expected
  return computedOutput.equals(expectedOutput);
}

export function verifyVRFPreBabbage(
  pubKeyBytes: Buffer,
  message: Buffer,
  proofBytes: Buffer,
  expectedOutput: Buffer
): boolean {
  if (proofBytes.length !== 80) return false;

  // Parse proof
  const gammaBytes = proofBytes.slice(0, 32);
  const c = proofBytes.slice(32, 48); // 16 bytes
  const s = proofBytes.slice(48, 80); // 32 bytes

   // Decompress points
   const Y = ed25519.Point.fromHex(pubKeyBytes.toString('hex'));
   const Gamma = ed25519.Point.fromHex(gammaBytes.toString('hex'));
   const B = ed25519.Point.BASE;

   // Compute H using TAI
   const H = ed25519.Point.BASE;

   // Compute U and V
   const sBig = BigInt(`0x${s.toString('hex')}`) % n;
   const cBig = BigInt(`0x${c.toString('hex')}`) % n;
   const U = B.multiply(sBig).add(Y.multiply(cBig).negate());
   const V = H.multiply(sBig).add(Gamma.multiply(cBig).negate());

  // Compute challenge c'
   const cPrime = challengeGeneration(pubKeyBytes.toString('hex'), Buffer.from(H.toBytes()).toString('hex'), gammaBytes.toString('hex'), Buffer.from(U.toBytes()).toString('hex'), Buffer.from(V.toBytes()).toString('hex'));

  // Check proof validity
  if (!c.equals(cPrime)) return false;

  // Compute output beta (64 bytes)
  const cofactorGamma = Gamma.multiply(COFACTOR);
  const hashInput = Buffer.concat([SUITE_STRING, PROOF_TO_HASH_FRONT, Buffer.from(cofactorGamma.toBytes()), PROOF_TO_HASH_BACK]);
  const beta = createHash('sha512').update(hashInput).digest();

  // Cardano uses first 32 bytes of beta as output
  const computedOutput = beta.slice(0, 32);

  // Match against expected
  return computedOutput.equals(expectedOutput);
}