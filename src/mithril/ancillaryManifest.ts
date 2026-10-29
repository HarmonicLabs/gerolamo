/**
 * Mithril ancillary archive (`ancillary_manifest.json`): now @harmoniclabs/mithril-ts.
 *
 * The library checks the manifest signature with strict Ed25519 (Gerolamo's old check used
 * `verifyEd25519Signature_sync`, which accepts malleable signatures) and verifies every file.
 */

import { ANCILLARY_VKEYS, ancillaryManifestHash, parseAncillaryManifest, verifyAncillaryManifestSignature, type AncillaryManifest } from "@harmoniclabs/mithril-ts";
import { ancillaryImmutableDigests, sha256File, verifyAncillaryDir, type AncillaryVerification as LibVerification } from "@harmoniclabs/mithril-ts/node";

export type { AncillaryManifest };
export { ANCILLARY_VKEYS, ancillaryImmutableDigests, sha256File };

/** mithril `AncillaryFilesManifest::compute_hash` (paths in byte order). */
export function manifestHash(m: AncillaryManifest): Uint8Array {
    return ancillaryManifestHash(m);
}

/** The manifest signature against an ancillary verification key. */
export function verifyManifestSignature(m: AncillaryManifest, vkeyRaw: string): boolean {
    return verifyAncillaryManifestSignature(m, vkeyRaw);
}

export interface AncillaryVerification { ok: boolean; files: number; signatureOk: boolean; errors: string[] }

/** Verify every listed file under `baseDir` and the manifest signature against the network key. */
export async function verifyAncillary(baseDir: string, vkeyRaw: string, log?: (m: string) => void): Promise<AncillaryVerification> {
    const v: LibVerification = await verifyAncillaryDir(baseDir, vkeyRaw, log);
    return { ok: v.ok, files: v.files, signatureOk: v.signatureOk, errors: v.errors };
}

export { parseAncillaryManifest };
