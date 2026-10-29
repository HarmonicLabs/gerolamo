/**
 * Certify a locally produced cardano-database snapshot against Mithril: pick the aggregator's
 * snapshot for an immutable file number the local store has complete, verify its certificate
 * chain to the genesis key (keeping every certificate so the node can serve the chain), then let
 * the producer check that the local Merkle root and snapshot hash are the aggregator's own.
 *
 * Now @harmoniclabs/mithril-ts/node; Gerolamo's call sites keep their options
 * (`immutableDir`, `store`, `network`, `aggregator`, `genesisVkey`, `immutable`, `archiveRange`, `log`).
 */

export {
    findCertifiedTarget,
    produceCertifiedSnapshot,
    type CertifiedTarget,
    type FindCertifiedTargetOptions,
    type ProduceCertifiedOptions,
} from "@harmoniclabs/mithril-ts/node";
