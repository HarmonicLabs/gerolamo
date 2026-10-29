/**
 * Produce cardano-database v2 artifacts (aggregator layout), now @harmoniclabs/mithril-ts/node.
 *
 * The archiver, digests archive and snapshot record are the library's producer over the same
 * layout; producing stays read-only on the source directory, and an uncertified snapshot is kept
 * but not listed (Gerolamo is not a registered Mithril signer).
 */

export {
    archivePresent,
    buildDigestsArchive,
    buildImmutableArchive,
    produceCardanoDatabaseSnapshot,
    ZSTD_LEVEL,
    type ProduceOptions,
    type ProduceResult,
} from "@harmoniclabs/mithril-ts/node";
