/**
 * On-disk layout of a Gerolamo Mithril artifact store (cardano-database v2).
 *
 *   <root>/cardano-database-download/immutable/NNNNN.tar.zst    one archive per immutable trio
 *   <root>/cardano-database-download/digests/<stem>.tar.zst      digests list of one snapshot
 *   <root>/snapshots/<snapshot hash>.json                        snapshot record (written last)
 *   <root>/certificates/<certificate hash>.json                  certificate chain, as published
 *   <root>/digest-cache-<source id>.json                         digests already computed
 *
 * The download paths mirror the aggregator's `cardano-database-download` route, so the HTTP
 * server maps a URL path to a file without a lookup table.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseJsonLossless } from "../verify/json";

export const DOWNLOAD_DIR = "cardano-database-download";

export type StoredSnapshot = {
    hash: string;
    merkle_root: string;
    network: string;
    beacon: { epoch: number; immutable_file_number: number };
    /** Empty when no Mithril certificate signs this root. */
    certificate_hash: string;
    total_db_size_uncompressed: number;
    digests: { size_uncompressed: number; file: string };
    immutables: { average_size_uncompressed: number; archived: { from: number; to: number } };
    ancillary: { size_uncompressed: number };
    cardano_node_version: string;
    created_at: string;
    /** Where the chunks came from (not part of the aggregator message). */
    source: string;
};

export const pad5 = (n: number): string => String(n).padStart(5, "0");

export class ArtifactStore {
    readonly root: string;
    constructor(root: string) {
        this.root = resolve(root);
    }
    immutableArchive(n: number): string {
        return join(this.root, DOWNLOAD_DIR, "immutable", `${pad5(n)}.tar.zst`);
    }
    digestsArchive(file: string): string {
        return join(this.root, DOWNLOAD_DIR, "digests", file);
    }
    snapshotPath(hash: string): string {
        return join(this.root, "snapshots", `${hash}.json`);
    }
    certificatePath(hash: string): string {
        return join(this.root, "certificates", `${hash}.json`);
    }
    digestCachePath(sourceDir: string): string {
        return join(this.root, `digest-cache-${createHash("sha256").update(resolve(sourceDir)).digest("hex").slice(0, 16)}.json`);
    }

    async readSnapshot(hash: string): Promise<StoredSnapshot | null> {
        if (!/^[0-9a-f]{64}$/.test(hash)) return null;
        const f = Bun.file(this.snapshotPath(hash));
        return (await f.exists()) ? ((await f.json()) as StoredSnapshot) : null;
    }

    /** Snapshots, newest first (by immutable file number, then creation time). */
    async listSnapshots(): Promise<StoredSnapshot[]> {
        const dir = join(this.root, "snapshots");
        if (!existsSync(dir)) return [];
        const out: StoredSnapshot[] = [];
        for (const name of readdirSync(dir)) {
            if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
            try {
                out.push((await Bun.file(join(dir, name)).json()) as StoredSnapshot);
            } catch {
                /* partial write or foreign file: skip */
            }
        }
        out.sort((a, b) => b.beacon.immutable_file_number - a.beacon.immutable_file_number || b.created_at.localeCompare(a.created_at));
        return out;
    }

    /** Raw certificate JSON text as published by the aggregator, or null. */
    async readCertificateText(hash: string): Promise<string | null> {
        if (!/^[0-9a-f]{64}$/.test(hash)) return null;
        const f = Bun.file(this.certificatePath(hash));
        return (await f.exists()) ? await f.text() : null;
    }

    async listCertificates(): Promise<Record<string, unknown>[]> {
        const dir = join(this.root, "certificates");
        if (!existsSync(dir)) return [];
        const out: Record<string, unknown>[] = [];
        for (const name of readdirSync(dir)) {
            if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
            try {
                out.push(parseJsonLossless(await Bun.file(join(dir, name)).text()) as Record<string, unknown>);
            } catch {
                /* skip */
            }
        }
        return out;
    }
}
