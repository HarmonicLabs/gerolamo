/**
 * Serve a Gerolamo artifact store over HTTP with the aggregator's cardano-database v2 routes, so
 * `mithril-bootstrap --aggregator http://<node>/mithril` (and other aggregator clients) can
 * restore from a Gerolamo node:
 *
 *   GET  {prefix}/                                       aggregator features
 *   GET  {prefix}/artifact/cardano-database              certified snapshots, newest first (max 20)
 *   GET  {prefix}/artifact/cardano-database/epoch/{e}    the same, for one epoch
 *   GET  {prefix}/artifact/cardano-database/digests      digests list of the newest snapshot
 *   GET  {prefix}/artifact/cardano-database/{hash}       snapshot detail with download locations
 *   GET  {prefix}/certificates                           stored certificates, newest first (max 20)
 *   GET  {prefix}/certificate/{hash}                     one certificate, exactly as Mithril published it
 *   GET  {prefix}/cardano-database-download/immutable/NNNNN.tar.zst
 *   GET  {prefix}/cardano-database-download/digests/<file>.tar.zst
 *   POST {prefix}/statistics/...                         accepted and ignored
 *
 * Certificates are self-verifying (the client walks them to the genesis key), so serving them
 * from the node's store is safe; so are the archives (the client checks every file against the
 * certified digests). The handler is framework free, `(req, url) => Response | null` with null
 * for paths outside the prefix.
 */

export {
    createMithrilArtifactHandler,
    MITHRIL_API_VERSION,
    snapshotMessage,
    type MithrilArtifactHandler,
    type MithrilArtifactServerOptions,
} from "@harmoniclabs/mithril-ts/node";
