/**
 * Client side of a cardano-database v2 restore, as mithril-client does it
 * (`InternalArtifactProver::download_and_verify_digests` and `verify_cardano_database`):
 *
 * 1. Download the snapshot's digests list, keep the files numbered <= the certified beacon,
 *    build the MKTree root and check that the (already chain-verified) certificate signed it.
 * 2. Hash the downloaded immutable files and compare each one with its certified digest.
 *
 * The library is stricter on one point: every immutable file found in the directory is checked,
 * not only the requested range, because the whole directory may become the node's block store.
 * A file the digests do not cover is reported as non-verifiable; the ancillary archive's last
 * trio is covered by its signed manifest instead (`extraDigests`).
 */

export {
    describeVerification,
    fetchDigestList,
    fetchVerifiedDigests,
    parseDigestList,
    verifyImmutableFiles,
    type DigestsFetch,
    type ImmutableVerification,
    type VerifiedDigests,
} from "@harmoniclabs/mithril-ts/node";
