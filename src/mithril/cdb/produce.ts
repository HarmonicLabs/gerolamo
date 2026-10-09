/**
 * Produce cardano-database v2 artifacts from a chunk store (Gerolamo's own, or a cardano-node
 * `db/immutable`), in the aggregator's layout:
 *
 * - one `NNNNN.tar.zst` per immutable trio, holding `immutable/NNNNN.{chunk,primary,secondary}`;
 * - `<network>-e<epoch>-i<n>.digests.tar.zst` holding `<stem>.json`, the list of
 *   `{immutable_file_name, digest}` for every file numbered 0..=n;
 * - a snapshot record (hash, merkle root, beacon, sizes, certificate hash), written last.
 *
 * Producing is read-only on the source directory. "Certify" means: the computed Merkle root is
 * exactly what a real Mithril certificate signed for the same immutable file number, and that
 * certificate's chain verifies to the network's genesis key. Gerolamo is not a registered
 * signer, so it cannot sign a new root itself; an uncertified snapshot is kept but not listed.
 */

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { stringifyJsonLossless } from "../verify/json";
import type { Certificate } from "../verify/certificate";
import {
    cardanoDbMerkleRoot,
    cardanoDbSnapshotHash,
    certificateSignsCardanoDbRoot,
    computeImmutableDigests,
    DigestCache,
    digestsFileStem,
    listImmutableFiles,
    type DigestEntry,
} from "./digests";
import { ArtifactStore, pad5, type StoredSnapshot } from "./store";
import { buildTar, type TarEntry } from "./tar";

export const ZSTD_LEVEL = 9; // mithril-file-archiver default

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await Bun.write(tmp, data);
    await rename(tmp, path);
}

/** Build the `NNNNN.tar.zst` archive of one trio; the bytes archived must match `digests`. */
export async function buildImmutableArchive(immutableDir: string, n: number, digests: Map<string, string>, level = ZSTD_LEVEL): Promise<{ archive: Uint8Array; uncompressed: number }> {
    const entries: TarEntry[] = [];
    let uncompressed = 0;
    for (const ext of ["chunk", "primary", "secondary"]) {
        const name = `${pad5(n)}.${ext}`;
        const data = await Bun.file(`${immutableDir}/${name}`).bytes();
        const want = digests.get(name);
        const got = createHash("sha256").update(data).digest("hex");
        if (want !== undefined && got !== want) throw new Error(`${name} changed since it was digested (${got.slice(0, 12)} != ${want.slice(0, 12)})`);
        entries.push({ name: `immutable/${name}`, data });
        uncompressed += data.length;
    }
    const tar = buildTar(entries);
    return { archive: new Uint8Array(await Bun.zstdCompress(tar, { level })), uncompressed };
}

export type ProduceOptions = {
    immutableDir: string;
    store: ArtifactStore;
    network: string;
    beacon: { epoch: number; immutableFileNumber: number };
    /** The certificate that signs this snapshot (CardanoDatabase beacon). Its chain is stored too. */
    certificate?: Certificate;
    certificateChain?: Certificate[];
    /** Archives to build (default: all of 0..beacon). Digests always cover 0..beacon. */
    archiveRange?: { from: number; to: number };
    cardanoNodeVersion?: string;
    createdAt?: string;
    compressionLevel?: number;
    log?: (m: string) => void;
};

export type ProduceResult = {
    snapshot: StoredSnapshot;
    merkleRoot: string;
    certified: boolean;
    digests: DigestEntry[];
    archivesWritten: number;
    archivesReused: number;
    seconds: number;
};

export async function produceCardanoDatabaseSnapshot(o: ProduceOptions): Promise<ProduceResult> {
    const t0 = performance.now();
    const log = o.log ?? (() => {});
    const n = o.beacon.immutableFileNumber;
    const files = listImmutableFiles(o.immutableDir);
    const cache = await DigestCache.load(o.store.digestCachePath(o.immutableDir));
    await mkdir(o.store.root, { recursive: true });
    log(`digesting immutable files 0..${n} of ${o.immutableDir}`);
    const digests = await computeImmutableDigests(o.immutableDir, { from: 0, to: n }, {
        cache,
        files,
        onProgress: (done, total) => log(`  digests ${done}/${total}`),
    });
    await cache.save();
    const merkleRoot = cardanoDbMerkleRoot(digests);
    log(`merkle root ${merkleRoot} over ${digests.length} files`);

    let certified = false;
    if (o.certificate) {
        const c = o.certificate;
        const set = c.signature.kind === "multi" ? c.signature.signedEntityType : null;
        if (!set || set.type !== "CardanoDatabase") throw new Error(`certificate ${c.hash} does not sign a cardano database snapshot`);
        if (set.immutableFileNumber !== BigInt(n) || set.epoch !== BigInt(o.beacon.epoch)) {
            throw new Error(`certificate ${c.hash} signs beacon e${set.epoch}/i${set.immutableFileNumber}, not e${o.beacon.epoch}/i${n}`);
        }
        if (!certificateSignsCardanoDbRoot(c, merkleRoot)) {
            throw new Error(`computed merkle root ${merkleRoot} is not the root certificate ${c.hash} signed (${c.protocolMessage.get("cardano_database_merkle_root")})`);
        }
        certified = true;
        log(`certificate ${c.hash} signs this root`);
    }

    // Aggregator rule (compute_immutable_files_total_uncompressed_size): trios 1..=n, trio 0 excluded.
    let total = 0;
    for (const f of files) if (f.number >= 1 && f.number <= n) total += f.size;
    const digestMap = new Map(digests.map((d) => [d.immutable_file_name, d.digest]));

    const from = Math.max(0, o.archiveRange?.from ?? 0);
    const to = Math.min(n, o.archiveRange?.to ?? n);
    let written = 0;
    let reused = 0;
    for (let i = from; i <= to; i++) {
        const path = o.store.immutableArchive(i);
        if (await Bun.file(path).exists()) {
            reused++;
            continue;
        }
        const { archive } = await buildImmutableArchive(o.immutableDir, i, digestMap, o.compressionLevel);
        await writeAtomic(path, archive);
        written++;
        if (written % 1000 === 0) log(`  archives written ${written} (at ${pad5(i)})`);
    }
    log(`archives ${from}..${to}: ${written} written, ${reused} already present`);

    const stem = digestsFileStem(o.network, o.beacon.epoch, n);
    const digestsJson = JSON.stringify(digests);
    const digestsTar = buildTar([{ name: `${stem}.json`, data: new TextEncoder().encode(digestsJson) }]);
    const digestsFile = `${stem}.tar.zst`;
    await writeAtomic(o.store.digestsArchive(digestsFile), new Uint8Array(await Bun.zstdCompress(digestsTar, { level: o.compressionLevel ?? ZSTD_LEVEL })));

    for (const c of o.certificateChain ?? (o.certificate ? [o.certificate] : [])) {
        const p = o.store.certificatePath(c.hash);
        if (!(await Bun.file(p).exists())) await writeAtomic(p, stringifyJsonLossless(c.raw));
    }

    const snapshot: StoredSnapshot = {
        hash: cardanoDbSnapshotHash(o.beacon.epoch, merkleRoot),
        merkle_root: merkleRoot,
        network: o.network,
        beacon: { epoch: o.beacon.epoch, immutable_file_number: n },
        certificate_hash: certified ? o.certificate!.hash : "",
        total_db_size_uncompressed: total,
        digests: { size_uncompressed: new TextEncoder().encode(digestsJson).length, file: digestsFile },
        immutables: { average_size_uncompressed: n > 0 ? Math.floor(total / n) : 0, archived: { from, to } },
        ancillary: { size_uncompressed: 0 },
        cardano_node_version: o.cardanoNodeVersion ?? "",
        created_at: o.createdAt ?? new Date().toISOString(),
        source: o.immutableDir,
    };
    // Written last: a snapshot is listed only once all its files are in place.
    await writeAtomic(o.store.snapshotPath(snapshot.hash), JSON.stringify(snapshot, null, 1));
    return { snapshot, merkleRoot, certified, digests, archivesWritten: written, archivesReused: reused, seconds: (performance.now() - t0) / 1000 };
}

/** Archived range actually present on disk for a snapshot (the record says what was built). */
export async function archivePresent(store: ArtifactStore, n: number): Promise<boolean> {
    try {
        return (await stat(store.immutableArchive(n))).isFile();
    } catch {
        return false;
    }
}
