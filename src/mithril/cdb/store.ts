/**
 * cardano-database v2 artifact store, now @harmoniclabs/mithril-ts/node.
 *
 * Gerolamo keeps only its five-digit stem helper; the store itself (paths, snapshot and
 * certificate reads) is the library's `ArtifactStore` over the same on-disk layout:
 *
 *   <root>/cardano-database-download/immutable/NNNNN.tar.zst
 *   <root>/cardano-database-download/digests/<stem>.tar.zst
 *   <root>/snapshots/<snapshot hash>.json
 *   <root>/certificates/<certificate hash>.json
 *   <root>/digest-cache-<source id>.json
 */

export { ArtifactStore, DOWNLOAD_DIR, type StoredSnapshot } from "@harmoniclabs/mithril-ts/node";

export const pad5 = (n: number): string => String(n).padStart(5, "0");
