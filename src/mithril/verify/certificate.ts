/**
 * Mithril certificate model and hashing: re-exported from @harmoniclabs/mithril-ts.
 *
 * The library carries the port of mithril-common (`CertificateMessage` -> `Certificate`,
 * `Certificate::try_compute_hash`, `ProtocolMessage::compute_hash`) with the same
 * lossless parsing and strict decoding Gerolamo's copy had.
 */

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
    PROTOCOL_MESSAGE_PART_KEYS as PROTOCOL_MESSAGE_PART_KEY_ORDER,
    rfc3339Nanos,
    type Certificate,
    type CertificateMetadata,
    type ProtocolMessage,
    type SignedEntityType,
} from "@harmoniclabs/mithril-ts";
