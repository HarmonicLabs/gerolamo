/**
 * Pure-TS Mithril crypto path.
 *
 * Stage 1: cert shape parse (AVK + multi_signature hex→JSON).
 * Stage 2: STM crypto prep (G1/G2 decode + millerLoop plumbing).
 * Stage 3: Merkle batch_proof structural validate.
 * Stage 4: Merkle batch path root verify (Blake2b-256; rootVerified may be true).
 * Stage 5a: STM preliminary (lottery + bounds + k; preliminaryOk may be true).
 * Stage 5b: BLS multi-sig aggregate verify (aggregateOk may be true; n=1 identity proven).
 * Stage 5c: certificate-chain walk (chainOk only when genesis reached + Ed25519).
 * Stage 5d: Certificate::try_compute_hash content-hash (contentHashOk may be true).
 *
 * verified / pureTsStmImplemented / match stay false until dual-run crypto agree.
 * WASM remains source of truth for certificate-chain verification.
 *
 * See docs/phase-4-pure-ts-crypto-research.md
 */

export {
    hexJsonDecode,
    numberArrayToBytes,
    parseAndValidateCertificate,
    validateAgainstGoldenVector,
    type PureTsAggregateVerificationKey,
    type PureTsAvkMtCommitment,
    type PureTsBatchProof,
    type PureTsCertParseResult,
    type PureTsMsSignatureEntry,
    type PureTsMultiSignature,
    type PureTsParsedCertificate,
    type PureTsStmSignatureLeaf,
} from "./cert";

export {
    prepareStmCrypto,
    tryDecodeCurvePoint,
    validateStmCryptoPrep,
    evaluateDenseMapping,
    isLotteryWon,
    buildStmMessagePrime,
    extractStmParameters,
    preliminaryVerifyStm,
    preliminaryVerifyFromParsed,
    BLS_MIN_SIG_DST,
    blake2b128ToScalarLe,
    hashMsgToG1,
    blsMinSigVerify,
    aggregateBlsSignatures,
    verifyBlsAggregate,
    verifyStmAggregate,
    verifyStmAggregateFromParsed,
    type PureTsDecodedG1,
    type PureTsDecodedG2,
    type PureTsStmCryptoPrepResult,
    type PureTsStmEntryPrep,
    type PureTsStmPreliminaryResult,
    type PureTsStmAggregateResult,
    type StmParameters,
} from "./stm";

export {
    blake2b256,
    concatenationLeafBytes,
    concatenationLeafHash,
    expectedMerklePathLen,
    extractConcatenationLeafFromMsEntry,
    leafHashesFromMultiSignature,
    merkleParent,
    merkleSibling,
    validateBatchProofStructural,
    validateMerkleStructuralGolden,
    verifyBatchProofWithRoot,
    verifyMerkleBatchRoot,
    type MerkleBatchRootVerifyResult,
    type PureTsMerkleValidateResult,
} from "./merkle";

export {
    PROTOCOL_MESSAGE_PART_KEY_ORDER,
    normalizeProtocolMessageParts,
    computeProtocolMessageHash,
    verifySignedMessageMatchesProtocolMessage,
    certificateMatchMessage,
    certificateMatchOwnProtocolMessage,
    computeCardanoDatabaseMessage,
    verifyCardanoDatabaseMessageMatch,
    decodeGenesisVkey,
    decodeGenesisSignature,
    isGenesisCertificate,
    isStandardCertificate,
    verifyEpochChaining,
    verifyAvkChaining,
    verifyParamsChaining,
    verifyStructuralLink,
    verifyStandardCertificateIntegrity,
    verifyGenesisCertificate,
    createAggregatorCertificateFetcher,
    walkCertificateChain,
    walkTipWithPredecessor,
    DEFAULT_CHAIN_MAX_DEPTH,
    type ProtocolMessageParts,
    type CertificateMatchMessageResult,
    type ProtocolMessageJson,
    type ComputeCardanoDatabaseMessageResult,
    type VerifyCardanoDatabaseMessageMatchResult,
    type StructuralLinkResult,
    type StandardCertIntegrityResult,
    type GenesisCertVerifyResult,
    type CertificateFetcher,
    type ChainStepResult,
    type PureTsChainWalkResult,
} from "./chain";

export {
    parseRfc3339Nanos,
    computeProtocolParametersHash,
    computeStakePartyHash,
    computeCertificateMetadataHash,
    feedSignedEntityType,
    tryComputeCertificateHash,
    verifyCertificateContentHash,
    type CertificateMetadataHashInput,
    type TryComputeCertificateHashResult,
} from "./certHash";
