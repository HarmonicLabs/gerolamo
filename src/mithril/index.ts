/**
 * Gerolamo Mithril client — verification core is @harmoniclabs/mithril-ts; Gerolamo keeps
 * bootstrap into its own stores, the ledger-state import and the artifact/serve glue.
 *
 * Spec role: https://mithril.network/doc/mithril/advanced/mithril-network/client
 * Research: docs/mithril-native-client-research.md
 *
 * Honesty:
 *   - Production cert verify = HTTP aggregator + the library's chain walk
 *   - `--engine bin` shells out to the external mithril-client (bulk restore)
 *   - Download/extract = TS HTTP + fzstd + tar-stream
 *   - No WASM dependency
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

// Certificate model, hashes and chain verification (was src/mithril/verify + pureTs).
export {
    cardanoDatabaseMessageMatches,
    CertificateError,
    computeCertificateHash,
    decodeKeyBytes,
    metadataHash,
    parseCertificate,
    phiFFixed,
    protocolMessageHash,
    protocolParametersHash,
    PROTOCOL_MESSAGE_PART_KEY_ORDER,
    rfc3339Nanos,
    type Certificate,
    type CertificateMetadata,
    type ProtocolMessage,
    type SignedEntityType,
} from "./verify/certificate";
export {
    aggregatorCertificateRetriever,
    decodeGenesisVerificationKey,
    ed25519VerifyStrict,
    verifyCertificateChain,
    verifyGenesisCertificate,
    verifyGenesisCertificate as verifyGenesisCertificateStrict,
    verifyStandardCertificate,
    verifyStandardCertificateIntegrity,
    type CertificateRetriever,
    type ChainHop,
    type ChainVerifyOptions,
    type ChainVerifyResult,
} from "./verify/verifier";
export {
    verifyConcatenationProof,
    type AggregateVerificationKey,
    type ConcatenationProof,
    type StmParameters,
    type StmVerifyStats,
} from "./verify/stm";
export { isLotteryWon } from "./verify/lottery";
export { ANCILLARY_VKEYS } from "./ancillaryManifest";

// cardano-database v2 artifacts: produce, certify, serve (Gerolamo glue over the library node part).
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

export { runMithrilBootstrap } from "./bootstrap";

export {
    countMithrilCertificates,
    ensureCertificatesTable,
    persistMithrilCertificate,
    persistMithrilCertificates,
    type MithrilCertVerdict,
} from "./certStore";
