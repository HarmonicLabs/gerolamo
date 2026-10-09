/**
 * Gerolamo Mithril client — pure-TS verify + download, external bin optional.
 *
 * Spec role: https://mithril.network/doc/mithril/advanced/mithril-network/client
 * Research: docs/mithril-native-client-research.md
 *
 * Honesty:
 *   - Production cert verify = HTTP aggregator + pure-TS Stages 1–5d (`--engine ts`)
 *   - `--engine bin` shells out to the external mithril-client (bulk restore)
 *   - Download/extract = TS HTTP + fzstd + tar-stream
 *   - No WASM dependency: the IOG client was removed after pure-TS dual-run soaks
 */

export type {
    MithrilBeacon,
    MithrilBootstrapOptions,
    MithrilBootstrapResult,
    MithrilCdbListItem,
    MithrilCdbSnapshot,
    MithrilCertificate,
    MithrilEngine,
    MithrilLocation,
    MithrilNetwork,
    MithrilNetworkConfig,
} from "./types";

export {
    fetchGenesisVkey,
    networkConfig,
    selectSnapshot,
} from "./client";

export {
    createTsMithrilClient,
    type TsMithrilClient,
} from "./httpClient";

// Certificate chain verification (port of mithril-common / mithril-stm).
export { parseCertificate, computeCertificateHash, protocolMessageHash, type Certificate } from "./verify/certificate";
export { verifyCertificateChain, verifyStandardCertificate, verifyGenesisCertificate as verifyGenesisCertificateStrict, aggregatorCertificateRetriever, decodeGenesisVerificationKey, type ChainVerifyResult } from "./verify/verifier";
export { verifyConcatenationProof } from "./verify/stm";

// cardano-database v2 artifacts: produce, certify, serve.
export { produceCardanoDatabaseSnapshot } from "./cdb/produce";
export { produceCertifiedSnapshot } from "./cdb/certify";
export { createMithrilArtifactHandler } from "./cdb/server";
export { ArtifactStore } from "./cdb/store";

export {
    ancillaryUrlFromSnapshot,
    downloadAncillary,
    downloadImmutableChunk,
    downloadImmutableRange,
    downloadToFile,
    extractTarZstFromFile,
    extractTarZstToDir,
    FZSTD_MAX_BYTES,
    findAncillaryLedgerDir,
    findImmutableDir,
    hasCompleteImmutableTrio,
    immutableTemplateFromSnapshot,
    locationTemplate,
    padImmutableNo,
    resolveMithrilClientBin,
    runMithrilClientBin,
} from "./download";

export {
    cryptoInventory,
    pureTsFullChainStagesOk,
    pureTsVerifyCertificateChain,
    type CryptoInventory,
    type PureTsVerifyResult,
    type PureTsVerifyOptions,
} from "./dualRun";

export {
    parseAndValidateCertificate,
    validateAgainstGoldenVector,
    hexJsonDecode,
    numberArrayToBytes,
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
    expectedMerklePathLen,
    validateBatchProofStructural,
    validateMerkleStructuralGolden,
    verifyBatchProofWithRoot,
    verifyMerkleBatchRoot,
    blake2b256,
    concatenationLeafBytes,
    concatenationLeafHash,
    extractConcatenationLeafFromMsEntry,
    leafHashesFromMultiSignature,
    merkleParent,
    merkleSibling,
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
    type PureTsCertParseResult,
    type PureTsParsedCertificate,
    type PureTsStmCryptoPrepResult,
    type PureTsStmEntryPrep,
    type PureTsStmPreliminaryResult,
    type PureTsStmAggregateResult,
    type StmParameters,
    type PureTsMerkleValidateResult,
    type MerkleBatchRootVerifyResult,
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
    tryComputeCertificateHash,
    verifyCertificateContentHash,
    computeCertificateMetadataHash,
    computeProtocolParametersHash,
    parseRfc3339Nanos,
    feedSignedEntityType,
    ENTITY_TYPE_MITHRIL_STAKE_DISTRIBUTION,
    ENTITY_TYPE_CARDANO_STAKE_DISTRIBUTION,
    ENTITY_TYPE_CARDANO_TRANSACTIONS,
    ENTITY_TYPE_CARDANO_DATABASE,
    ENTITY_TYPE_CARDANO_BLOCKS_TRANSACTIONS,
    type TryComputeCertificateHashResult,
    type CertificateMetadataHashInput,
    MKTREE_GOLDEN_ROOT_HEX,
    MKTREE_GOLDEN_LEAVES,
    blake2s256,
    mkTreeLeafFromHexDigestString,
    mkTreeLeafFromUtf8,
    getPeakMap,
    getPeaks,
    bagRhsPeaks,
    MkTreeMmr,
    computeMkTreeRootFromLeaves,
    verifyMkTreeGoldenRoot,
    immutableFileNumberFromName,
    filterImmutableDigests,
    computeCardanoDatabaseMerkleRootFromDigests,
    verifyCardanoDatabaseMerkleRootFromDigests,
    type ImmutableFileDigest,
    type ComputeMkTreeRootResult,
    type VerifyCardanoDatabaseMerkleRootResult,
    sha256FileHex,
    listLocalImmutableFileNames,
    resolveImmutableDir,
    maxLocalImmutableNumber,
    listCompletedLocalImmutableNames,
    computeLocalImmutableDigests,
    verifyLocalDigestsAgainstPublished,
    type LocalDigestEntry,
    type VerifyLocalDigestsAgainstPublishedResult,
} from "./pureTs";

export { runMithrilBootstrap } from "./bootstrap";

export {
    countMithrilCertificates,
    ensureCertificatesTable,
    persistMithrilCertificate,
    persistMithrilCertificates,
    type MithrilCertVerdict,
} from "./certStore";
