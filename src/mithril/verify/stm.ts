/**
 * Mithril STM multi-signature verification (concatenation proof), ported from mithril-stm
 * `ConcatenationProof::verify` and its helpers:
 *
 * 1. msgp = msg || avk.root (the AVK Merkle commitment root appended to the signed bytes).
 * 2. For every signature and every lottery index: index <= m, and the lottery is won for the
 *    signer's stake (dense mapping H("map" || msgp || index_le_u64 || sigma), exact rational check).
 * 3. All indices are unique and there are at least k of them.
 * 4. The signers' registration entries (vk || stake) are members of the AVK Merkle tree
 *    (batch path, Blake2b-256).
 * 5. The BLS aggregate signature verifies (Blake2b-128 weighted aggregation of vks and sigmas,
 *    then e(sig, g2) == e(H_G1(msgp), vk) with the empty hash-to-curve DST, as blst min_sig).
 *
 * The wire form is the "JSON hex" encoding the aggregator publishes. Signatures and keys are
 * decoded with subgroup and non-identity checks (blst `sig_validate(true)` / `key_validate`).
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { blake2b } from "@noble/hashes/blake2b";

import { asByteArray, asU64, byteArrayJson, bytesEqual, decodeJsonHex, isObject } from "./json";
import { isLotteryWon } from "./lottery";

export type StmParameters = { k: bigint; m: bigint; phiF: number };

export type AggregateVerificationKey = {
    root: Uint8Array; // 32 bytes, Blake2b-256 Merkle root of the registration entries
    nrLeaves: number;
    totalStake: bigint;
};

export type StmSignatureEntry = {
    sigma: Uint8Array; // 48 bytes, compressed G1
    indexes: bigint[];
    signerIndex: bigint;
    vk: Uint8Array; // 96 bytes, compressed G2
    stake: bigint;
};

export type ConcatenationProof = {
    signatures: StmSignatureEntry[];
    batchProof: { values: Uint8Array[]; indices: number[] };
};

export class StmVerificationError extends Error {
    constructor(readonly code: string, message: string) {
        super(`${code}: ${message}`);
        this.name = "StmVerificationError";
    }
}

const fail = (code: string, message: string): never => {
    throw new StmVerificationError(code, message);
};

// ---------------------------------------------------------------------------
// Decoding (JSON hex) and canonical re-encoding (serde_json field order)
// ---------------------------------------------------------------------------

function checkHasherNull(v: unknown, label: string): void {
    if (v !== null && v !== undefined) fail("SerializationError", `${label}.hasher must be null`);
}

export function parseAggregateVerificationKeyJson(doc: unknown): AggregateVerificationKey {
    if (!isObject(doc) || !isObject(doc.mt_commitment)) fail("SerializationError", "AVK: missing mt_commitment");
    const mt = (doc as { mt_commitment: Record<string, unknown> }).mt_commitment;
    checkHasherNull(mt.hasher, "AVK.mt_commitment");
    const nr = asU64(mt.nr_leaves, "AVK.nr_leaves");
    if (nr > BigInt(Number.MAX_SAFE_INTEGER)) fail("SerializationError", "AVK.nr_leaves too large");
    return {
        root: asByteArray(mt.root, 32, "AVK.root"),
        nrLeaves: Number(nr),
        totalStake: asU64((doc as Record<string, unknown>).total_stake, "AVK.total_stake"),
    };
}

export function parseAggregateVerificationKey(hex: string): AggregateVerificationKey {
    return parseAggregateVerificationKeyJson(decodeJsonHex(hex));
}

/** serde_json encoding of the AVK, as `to_json_hex` produces it before hex. */
export function aggregateVerificationKeyJson(avk: AggregateVerificationKey): string {
    return `{"mt_commitment":{"root":${byteArrayJson(avk.root)},"nr_leaves":${avk.nrLeaves},"hasher":null},"total_stake":${avk.totalStake}}`;
}

export function avkEquals(a: AggregateVerificationKey, b: AggregateVerificationKey): boolean {
    return a.nrLeaves === b.nrLeaves && a.totalStake === b.totalStake && bytesEqual(a.root, b.root);
}

export function parseConcatenationProof(hex: string): ConcatenationProof {
    const doc = decodeJsonHex(hex);
    if (!isObject(doc) || !Array.isArray(doc.signatures) || !isObject(doc.batch_proof)) {
        fail("SerializationError", "multi-signature: expected {signatures, batch_proof} (only the concatenation proof is supported)");
    }
    const d = doc as { signatures: unknown[]; batch_proof: Record<string, unknown> };
    const signatures = d.signatures.map((e, i): StmSignatureEntry => {
        const label = `signatures[${i}]`;
        if (!Array.isArray(e) || e.length !== 2) fail("SerializationError", `${label}: expected [sig, reg_party]`);
        const [sig, reg] = e as [unknown, unknown];
        if (!isObject(sig)) fail("SerializationError", `${label}: signature is not an object`);
        const s = sig as Record<string, unknown>;
        if (!Array.isArray(s.indexes)) fail("SerializationError", `${label}.indexes: not an array`);
        if (!Array.isArray(reg) || reg.length !== 2) fail("SerializationError", `${label}: reg_party must be [vk, stake]`);
        const [vk, stake] = reg as [unknown, unknown];
        return {
            sigma: asByteArray(s.sigma, 48, `${label}.sigma`),
            indexes: (s.indexes as unknown[]).map((x, j) => asU64(x, `${label}.indexes[${j}]`)),
            signerIndex: asU64(s.signer_index, `${label}.signer_index`),
            vk: asByteArray(vk, 96, `${label}.vk`),
            stake: asU64(stake, `${label}.stake`),
        };
    });
    const bp = d.batch_proof;
    checkHasherNull(bp.hasher, "batch_proof");
    if (!Array.isArray(bp.values) || !Array.isArray(bp.indices)) fail("SerializationError", "batch_proof: values/indices missing");
    const values = (bp.values as unknown[]).map((v, i) => asByteArray(v, 32, `batch_proof.values[${i}]`));
    const indices = (bp.indices as unknown[]).map((v, i) => {
        const n = asU64(v, `batch_proof.indices[${i}]`);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail("SerializationError", "batch_proof index too large");
        return Number(n);
    });
    return { signatures, batchProof: { values, indices } };
}

/** serde_json encoding of the concatenation proof, as `to_json_hex` produces it before hex. */
export function concatenationProofJson(p: ConcatenationProof): string {
    const sigs = p.signatures.map(
        (s) =>
            `[{"sigma":${byteArrayJson(s.sigma)},"indexes":[${s.indexes.join(",")}],"signer_index":${s.signerIndex}},[${byteArrayJson(s.vk)},${s.stake}]]`,
    );
    const values = p.batchProof.values.map(byteArrayJson).join(",");
    return `{"signatures":[${sigs.join(",")}],"batch_proof":{"values":[${values}],"indices":[${p.batchProof.indices.join(",")}],"hasher":null}}`;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function u64le(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
}

function u64be(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, false);
    return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

const blake2b256 = (...parts: Uint8Array[]): Uint8Array => blake2b(concat(...parts), { dkLen: 32 });

/** BlsSignature::evaluate_dense_mapping. */
export function evaluateDenseMapping(sigma: Uint8Array, msgp: Uint8Array, index: bigint): Uint8Array {
    return blake2b(concat(new TextEncoder().encode("map"), msgp, u64le(index), sigma), { dkLen: 64 });
}

/** RegistrationEntryForConcatenation bytes: vk (96) || stake (u64 BE). */
export function registrationLeafBytes(vk: Uint8Array, stake: bigint): Uint8Array {
    return concat(vk, u64be(stake));
}

type G1 = ReturnType<typeof bls.G1.ProjectivePoint.fromHex>;
type G2 = ReturnType<typeof bls.G2.ProjectivePoint.fromHex>;

/** Compressed G1 signature with blst `sig_validate(true)` semantics: on curve, in G1, not identity. */
export function decodeSignature(bytes: Uint8Array): G1 {
    let p: G1;
    try {
        p = bls.G1.ProjectivePoint.fromHex(bytes);
    } catch (e) {
        return fail("SignatureInvalid", `sigma does not decode: ${(e as Error).message}`);
    }
    // fromHex already rejected points off the curve or outside the prime-order subgroup.
    if (p.is0()) fail("SignatureInvalid", "sigma is the identity");
    return p;
}

/** Compressed G2 verification key with blst `key_validate` semantics. */
export function decodeVerificationKey(bytes: Uint8Array): G2 {
    let p: G2;
    try {
        p = bls.G2.ProjectivePoint.fromHex(bytes);
    } catch (e) {
        return fail("VerificationKeyInvalid", `vk does not decode: ${(e as Error).message}`);
    }
    if (p.is0()) fail("VerificationKeyInvalid", "vk is the identity");
    return p;
}

const EMPTY_DST = new Uint8Array(0);

/** BlsSignature::aggregate: (vk, sig) for one signer, else the Blake2b-128 weighted sums. */
export function aggregateBls(vks: G2[], sigs: G1[], sigBytes: Uint8Array[]): { vk: G2; sig: G1 } {
    if (vks.length !== sigs.length || vks.length === 0) fail("AggregateSignatureInvalid", "empty or mismatched aggregation");
    if (vks.length < 2) return { vk: vks[0]!, sig: sigs[0]! };
    const all = concat(...sigBytes);
    const scalars = vks.map((_, i) => {
        // hasher = Blake2b<U16>(sig_0 || ... || sig_n) then update(index as usize BE)
        const h = blake2b(concat(all, u64be(BigInt(i))), { dkLen: 16 });
        let s = 0n; // blst scalars are little-endian
        for (let j = 15; j >= 0; j--) s = (s << 8n) | BigInt(h[j]!);
        return s;
    });
    // Multi-scalar multiplication (Pippenger), as blst's p1_affines/p2_affines::mult.
    return { vk: bls.G2.ProjectivePoint.msm(vks, scalars), sig: bls.G1.ProjectivePoint.msm(sigs, scalars) };
}

/** blst min_sig `verify(false, msg, dst = [], aug = [], pk, false)`. */
export function blsVerify(msg: Uint8Array, vk: G2, sig: G1): boolean {
    if (vk.is0() || sig.is0()) return false;
    const h = bls.G1.hashToCurve(msg, { DST: EMPTY_DST } as never) as unknown as G1;
    // e(sig, g2) == e(H(msg), vk)  <=>  e(sig, -g2) * e(H(msg), vk) == 1
    const out = bls.pairingBatch([
        { g1: sig, g2: bls.G2.ProjectivePoint.BASE.negate() },
        { g1: h, g2: vk },
    ]);
    return bls.fields.Fp12.eql(out, bls.fields.Fp12.ONE);
}

// ---------------------------------------------------------------------------
// Merkle batch path (MerkleTreeBatchCommitment::verify_leaves_membership_from_batch_path)
// ---------------------------------------------------------------------------

const parent = (i: number): number => Math.floor((i - 1) / 2);
const sibling = (i: number): number => (i % 2 === 1 ? i + 1 : i - 1);

export function verifyBatchPath(root: Uint8Array, nrLeaves: number, leaves: Uint8Array[], proof: { values: Uint8Array[]; indices: number[] }): boolean {
    if (leaves.length !== proof.indices.length || leaves.length === 0) return false;
    for (let i = 1; i < proof.indices.length; i++) if (proof.indices[i - 1]! > proof.indices[i]!) return false; // must be sorted
    let pow2 = 1;
    while (pow2 < nrLeaves) pow2 *= 2;
    const nrNodes = pow2 + nrLeaves - 1;
    let ordered = proof.indices.map((i) => pow2 + i - 1);
    let idx = ordered[0]!;
    let hashes = leaves.map((l) => blake2b256(l));
    const values = proof.values.slice();
    const zeroLeaf = blake2b256(new Uint8Array([0]));
    while (idx > 0) {
        const newHashes: Uint8Array[] = [];
        const newIndices: number[] = [];
        idx = parent(idx);
        let i = 0;
        while (i < ordered.length) {
            newIndices.push(parent(ordered[i]!));
            if ((ordered[i]! & 1) === 0) {
                const v = values.shift();
                if (!v) return false;
                newHashes.push(blake2b256(v, hashes[i]!));
            } else {
                const sib = sibling(ordered[i]!);
                if (i < ordered.length - 1 && ordered[i + 1] === sib) {
                    newHashes.push(blake2b256(hashes[i]!, hashes[i + 1]!));
                    i++;
                } else if (sib < nrNodes) {
                    const v = values.shift();
                    if (!v) return false;
                    newHashes.push(blake2b256(hashes[i]!, v));
                } else {
                    newHashes.push(blake2b256(hashes[i]!, zeroLeaf));
                }
            }
            i++;
        }
        hashes = newHashes;
        ordered = newIndices;
    }
    return hashes.length === 1 && bytesEqual(hashes[0]!, root);
}

// ---------------------------------------------------------------------------
// ConcatenationProof::verify
// ---------------------------------------------------------------------------

export type StmVerifyStats = { signatures: number; indices: number; mode: "single" | "aggregate" };

/**
 * Verify a concatenation proof over `msg` (the certificate's `signed_message` as UTF-8 bytes).
 * Throws StmVerificationError with the mithril-stm error name on the first failed check.
 */
export function verifyConcatenationProof(msg: Uint8Array, avk: AggregateVerificationKey, params: StmParameters, proof: ConcatenationProof): StmVerifyStats {
    const msgp = concat(msg, avk.root);
    let nrIndices = 0;
    const unique = new Set<bigint>();
    for (const [si, s] of proof.signatures.entries()) {
        for (const index of s.indexes) {
            if (index > params.m) fail("IndexBoundFailed", `signature ${si}: index ${index} > m = ${params.m}`);
            const ev = evaluateDenseMapping(s.sigma, msgp, index);
            if (!isLotteryWon(params.phiF, ev, s.stake, avk.totalStake)) fail("LotteryLost", `signature ${si}: index ${index} did not win the lottery`);
        }
        for (const index of s.indexes) {
            unique.add(index);
            nrIndices++;
        }
    }
    if (nrIndices !== unique.size) fail("IndexNotUnique", "a lottery index is used twice");
    if (BigInt(nrIndices) < params.k) fail("NotEnoughSignatures", `${nrIndices} indices < k = ${params.k}`);

    const leaves = proof.signatures.map((s) => registrationLeafBytes(s.vk, s.stake));
    if (!verifyBatchPath(avk.root, avk.nrLeaves, leaves, proof.batchProof)) fail("BatchPathInvalid", "signers are not members of the AVK Merkle tree");

    const sigs = proof.signatures.map((s) => decodeSignature(s.sigma));
    const vks = proof.signatures.map((s) => decodeVerificationKey(s.vk));
    const agg = aggregateBls(vks, sigs, proof.signatures.map((s) => s.sigma));
    if (!blsVerify(msgp, agg.vk, agg.sig)) fail("SignatureInvalid", "aggregate BLS signature does not verify");
    return { signatures: proof.signatures.length, indices: nrIndices, mode: proof.signatures.length < 2 ? "single" : "aggregate" };
}
