/**
 * Mithril cardano-database digests of this node's own immutable files, served to light clients (light query
 * request 10). Gerolamo's chunk files are byte-identical to cardano-node's, so their SHA-256 digests are the ones
 * the Mithril aggregator lists and its certificates sign (docs/parity/mithril.md). A browser node checks the list
 * against the certified Merkle root, so it never has to trust this node: it only saves the aggregator download
 * (10 MB on preview, sent slowly).
 *
 * Hashing all of preview's immutable files takes a minute or so; it runs once in the background (started by the
 * first light-query hello) and is kept in a DigestCache next to the database (size and mtime keyed, so it stays
 * valid across restarts). Until the cache covers a requested range the answer is "not ready" and the client goes
 * to the aggregator. New chunks (one every ~72 min on preview) are hashed on demand.
 */
import { dirname, join } from "node:path";
import { computeImmutableDigests, DigestCache, lastCompletedImmutable, listImmutableFiles, type ImmutableFileInfo } from "../../mithril/cdb/digests";
import { logger } from "../../utils/logger";

const log = logger.child("n2n.digests");

/** Immutable file numbers per request (three files each). */
export const DIGESTS_MAX_FILES = 2000;
/** Files hashed inline for one request; more than that waits for the background warm-up. */
const INLINE_HASH_LIMIT = 30;
const LISTING_TTL_MS = 60_000;

export interface DigestPage { from: number; to: number; entries: Array<{ name: string; digest: string }> }

export class ImmutableDigests {
    private cache: Promise<DigestCache> | null = null;
    private listing: { at: number; files: ImmutableFileInfo[]; last: number | null } | null = null;
    private warming: Promise<void> | null = null;

    constructor(readonly immutableDir: string, readonly cachePath: string | null = join(dirname(dirname(immutableDir)), "digest-cache-immutable.json")) {}

    private loadCache(): Promise<DigestCache> {
        return (this.cache ??= DigestCache.load(this.cachePath));
    }

    private list(): { files: ImmutableFileInfo[]; last: number | null } {
        if (!this.listing || Date.now() - this.listing.at > LISTING_TTL_MS) {
            const files = listImmutableFiles(this.immutableDir);
            this.listing = { at: Date.now(), files, last: lastCompletedImmutable(files) };
        }
        return this.listing;
    }

    /** The newest complete immutable file number (the highest on disk is still being written). */
    lastComplete(): number | null { return this.list().last; }

    /** Hash every complete immutable file not in the cache yet, in the background (once at a time). */
    warm(): Promise<void> {
        if (this.warming) return this.warming;
        this.warming = (async () => {
            const cache = await this.loadCache();
            const { files, last } = this.list();
            if (last == null) return;
            const t0 = performance.now();
            const todo = files.filter((f) => f.number <= last && cache.get(f) == null);
            if (!todo.length) return;
            log.info(`hashing ${todo.length} immutable file(s) for Mithril digests`);
            const step = 300;
            for (let i = 0; i < todo.length; i += step) {
                const part = todo.slice(i, i + step);
                await computeImmutableDigests(this.immutableDir, { from: part[0]!.number, to: part[part.length - 1]!.number }, { cache, files: files.filter((f) => f.number >= part[0]!.number && f.number <= part[part.length - 1]!.number) });
                if ((i / step) % 20 === 19) await cache.save();
                await new Promise((r) => setTimeout(r, 0));
            }
            await cache.save();
            log.info(`Mithril digests ready: ${todo.length} file(s) hashed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        })().catch((e) => { log.warn(`digest warm-up failed: ${(e as Error).message}`); }).finally(() => { this.warming = null; });
        return this.warming;
    }

    /**
     * Digests of immutable files numbered from..to (clamped to the last complete one), or null when they are not
     * ready yet (the warm-up is started) or the range is empty.
     */
    async page(from: number, to: number): Promise<DigestPage | null> {
        const { files, last } = this.list();
        if (last == null || from > last) return null;
        const end = Math.min(to, last, from + DIGESTS_MAX_FILES - 1);
        const cache = await this.loadCache();
        const inRange = files.filter((f) => f.number >= from && f.number <= end);
        const missing = inRange.filter((f) => cache.get(f) == null).length;
        if (missing > INLINE_HASH_LIMIT) { void this.warm(); return null; }
        const digests = await computeImmutableDigests(this.immutableDir, { from, to: end }, { cache, files: inRange });
        if (missing) void cache.save();
        return { from, to: end, entries: digests.map((d) => ({ name: d.immutable_file_name, digest: d.digest })) };
    }
}

const providers = new Map<string, ImmutableDigests>();
/** One provider per immutable directory, shared by every light-query connection. */
export function immutableDigestsFor(immutableDir: string): ImmutableDigests {
    let p = providers.get(immutableDir);
    if (!p) { p = new ImmutableDigests(immutableDir); providers.set(immutableDir, p); }
    return p;
}
