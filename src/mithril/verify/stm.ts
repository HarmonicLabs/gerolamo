/**
 * Mithril STM multi-signature verification (concatenation proof): re-exported from
 * @harmoniclabs/mithril-ts, whose `verifyConcatenationProof` carries the port of mithril-stm
 * (lottery, AVK membership, BLS aggregate pairing).
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { StmVerificationError } from "@harmoniclabs/mithril-ts";

export {
    aggregateVerificationKeyJson,
    avkEquals,
    concatenationProofJson,
    evaluateDenseMapping,
    parseAggregateVerificationKey,
    parseAggregateVerificationKeyJson,
    parseConcatenationProof,
    registrationLeafBytes,
    StmVerificationError,
    verifyBatchPath,
    verifyConcatenationProof,
    type AggregateVerificationKey,
    type ConcatenationProof,
    type StmParameters,
    type StmSignatureEntry,
    type StmVerifyStats,
} from "@harmoniclabs/mithril-ts";

/** Compressed G1 signature with blst `sig_validate(true)` semantics: on curve, in G1, not identity. */
export function decodeSignature(bytes: Uint8Array) {
    let p: ReturnType<typeof bls.G1.ProjectivePoint.fromHex>;
    try {
        p = bls.G1.ProjectivePoint.fromHex(bytes);
    } catch (e) {
        throw new StmVerificationError("SignatureInvalid", `sigma does not decode: ${(e as Error).message}`);
    }
    if (p.is0()) throw new StmVerificationError("SignatureInvalid", "sigma is the identity");
    return p;
}

/** Compressed G2 verification key with blst `key_validate` semantics. */
export function decodeVerificationKey(bytes: Uint8Array) {
    let p: ReturnType<typeof bls.G2.ProjectivePoint.fromHex>;
    try {
        p = bls.G2.ProjectivePoint.fromHex(bytes);
    } catch (e) {
        throw new StmVerificationError("VerificationKeyInvalid", `vk does not decode: ${(e as Error).message}`);
    }
    if (p.is0()) throw new StmVerificationError("VerificationKeyInvalid", "vk is the identity");
    return p;
}
