/**
 * Gerolamo Mithril client — hybrid WASM verify + pure-TS download / external bin.
 *
 * Spec role: https://mithril.network/doc/mithril/advanced/mithril-network/client
 * Research: docs/mithril-native-client-research.md
 *
 * Honesty:
 *   - Cert chain verify = IOG @mithril-dev/mithril-client-wasm (not pure-TS crypto SoT)
 *   - Download/extract = TS HTTP + fzstd + tar-stream (no system zstd/tar)
 *   - Full multi-GB restore can still use --engine bin (external mithril-client)
 *   - Ancillary UTxO extract = A2 blocked (probe/download + tvar head scan only)
 *   - Phase 4 pure-TS = Stage 1–5c (shape/cryptoPrep/merkle/root/preliminary/aggregate/chainWalk);
 *     chainOk only when walk reaches genesis + Ed25519; match/implemented stay false
 *     WASM remains SoT for production cert-chain
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
    createMithrilClient,
    fetchGenesisVkey,
    networkConfig,
    selectSnapshot,
    type GerolamoMithrilClient,
} from "./client";

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
    immutableTemplateFromSnapshot,
    locationTemplate,
    padImmutableNo,
    resolveMithrilClientBin,
    runMithrilClientBin,
} from "./download";

export {
    cryptoInventory,
    dualRunCertificateChain,
    pureTsFullChainStagesOk,
    pureTsVerifyCertificateChain,
    type CryptoInventory,
    type DualRunVerifyResult,
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
    type TryComputeCertificateHashResult,
    type CertificateMetadataHashInput,
} from "./pureTs";

export { runMithrilBootstrap } from "./bootstrap";
