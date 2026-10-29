/**
 * Cardano database v2 digests and Merkle root: Gerolamo's names over the
 * @harmoniclabs/mithril-ts primitives (`mkTree.ts` core, `digests.ts`/`files.ts` node part).
 *
 * The legacy Gerolamo copies of listImmutableFiles / DigestCache / computeImmutableDigests /
 * sha256File / MkTree are gone; this file keeps the helper names Gerolamo's produce, certify
 * and bootstrap glue call.
 */

import {
    bytesToHex,
    cardanoDatabaseSnapshotHash,
    digestsFileStem as libDigestsFileStem,
    MkTree,
    protocolMessageHash,
    type Certificate,
    type ImmutableFileDigest,
} from "@harmoniclabs/mithril-ts";
import {
    computeImmutableDigests as libComputeImmutableDigests,
    DigestCache,
    lastCompletedImmutable,
    listImmutableFiles,
    sha256File,
    type ComputeDigestsOptions,
    type ImmutableFileInfo,
} from "@harmoniclabs/mithril-ts/node";

export type DigestEntry = ImmutableFileDigest;

export { DigestCache, lastCompletedImmutable, listImmutableFiles, sha256File };
export type { ComputeDigestsOptions, ImmutableFileInfo };

const IMMUTABLE_FILE = /^(\d{5,})\.(chunk|primary|secondary)$/;

/** Digests of every immutable file numbered `from..=to` (library node part; same contract). */
export function computeImmutableDigests(
    immutableDir: string,
    range: { from: number; to: number },
    opts: ComputeDigestsOptions = {},
): Promise<DigestEntry[]> {
    return libComputeImmutableDigests(immutableDir, range, opts);
}

/** MKTree root (hex) over the digests, in the order given (leaf = UTF-8 of the hex digest). */
export function cardanoDbMerkleRoot(digests: readonly DigestEntry[]): string {
    if (digests.length === 0) throw new Error("no digests");
    const mmr = new MkTree();
    const enc = new TextEncoder();
    for (const d of digests) {
        if (!/^[0-9a-f]{64}$/.test(d.digest)) throw new Error(`bad digest for ${d.immutable_file_name}`);
        mmr.push(enc.encode(d.digest));
    }
    return bytesToHex(mmr.root());
}

/**
 * Digests from a published digests list, keeping files numbered <= beacon, ordered by file name
 * (mithril-client `download_and_verify_digests`; the library's `certifiedDigests`).
 */
export function filterDigestsForBeacon(list: readonly DigestEntry[], beacon: number): DigestEntry[] {
    const byName = new Map<string, string>();
    for (const d of list) {
        const m = IMMUTABLE_FILE.exec(d.immutable_file_name);
        if (!m || Number(m[1]) > beacon) continue;
        byName.set(d.immutable_file_name, String(d.digest).toLowerCase());
    }
    return [...byName.keys()].sort().map((name) => ({ immutable_file_name: name, digest: byName.get(name)! }));
}

/** True when `merkleRoot` is what the certificate signed (`Certificate::match_message`). */
export function certificateSignsCardanoDbRoot(cert: Certificate, merkleRoot: string): boolean {
    if (cert.signature.kind !== "multi" || cert.signature.signedEntityType.type !== "CardanoDatabase") return false;
    const pm = new Map(cert.protocolMessage);
    pm.set("cardano_database_merkle_root", merkleRoot);
    return protocolMessageHash(pm) === cert.signedMessage;
}

/** CardanoDatabaseSnapshot::compute_hash (library core). */
export function cardanoDbSnapshotHash(epoch: number | bigint, merkleRoot: string): string {
    return cardanoDatabaseSnapshotHash(epoch, merkleRoot);
}

/** `{network}-e{epoch}-i{immutable}.digests` (aggregator digests file name, without extension). */
export function digestsFileStem(network: string, epoch: number | bigint, immutable: number): string {
    return libDigestsFileStem(network, epoch, immutable);
}
