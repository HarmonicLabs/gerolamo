/**
 * JSON helpers for Mithril messages: now @harmoniclabs/mithril-ts's lossless JSON
 * (u64 stakes stay exact; portable bytes/hex helpers included).
 *
 * Was: Gerolamo's own parser. The library carries the same functions.
 */

export {
    asByteArray,
    asU64,
    byteArrayJson,
    bytesEqual,
    bytesToHex,
    decodeJsonHex,
    encodeJsonHex,
    hexToBytes,
    isObject,
    parseJsonLossless,
    stringifyJsonLossless,
} from "@harmoniclabs/mithril-ts";
