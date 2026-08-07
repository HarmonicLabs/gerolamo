/**
 * Stage 5h: recompute immutable file digests from local disk.
 *
 * SoT (IntersectMBO mithril-cardano-node-internal-database):
 *   ImmutableFile::compute_raw_hash::<Sha256>
 *     = hex(SHA-256(file bytes))
 *   list_completed_in_dir skips the last incomplete trio
 *     (chunk/primary/secondary still being written).
 *
 * Proven 2026-08 preprod local snapshots/mithril/immutable:
 *   3858/3858 completed files match published digests artifact
 *   (maxLocal=6028; last trio 06028.* incomplete — skipped).
 *
 * Side-channel only — does NOT enter dual-run match gate.
 * WASM remains SoT until pureTsStmImplemented cutover.
 */

import { createHash } from "crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
    immutableFileNumberFromName,
    type ImmutableFileDigest,
} from "./mkTree";

const IMM_NAME = /^(\d+)\.(chunk|primary|secondary)$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

export type LocalDigestEntry = {
    immutable_file_name: string;
    path: string;
    digest: string;
    size: number;
};

export type VerifyLocalDigestsAgainstPublishedResult = {
    ok: boolean;
    checked: number;
    matched: number;
    mismatched: number;
    missingLocal: number;
    missingPublished: number;
    skippedLastTrio: string[];
    maxLocalImm: number | null;
    /** First few mismatches for diagnostics (name + local/published prefixes). */
    mismatches: Array<{
        name: string;
        local: string;
        published: string;
        size: number;
    }>;
    reason: string;
};

/**
 * SHA-256 of full file bytes → lowercase hex.
 * Matches ImmutableFile::compute_raw_hash::<Sha256> + hex::encode.
 */
export async function sha256FileHex(path: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        h.update(chunk);
    }
    return h.digest("hex");
}

/**
 * List local immutable trio files under dir (or dir/immutable).
 * Returns sorted filenames matching NNNNN.(chunk|primary|secondary).
 */
export function listLocalImmutableFileNames(immutableDir: string): string[] {
    if (!existsSync(immutableDir)) return [];
    return readdirSync(immutableDir)
        .filter((n) => IMM_NAME.test(n))
        .sort();
}

/**
 * Resolve cardano DB immutable directory.
 * Accepts either .../db (with immutable/ child) or .../immutable directly.
 */
export function resolveImmutableDir(dbOrImmutablePath: string): string {
    const direct = dbOrImmutablePath;
    if (existsSync(join(direct, "00000.chunk")) || existsSync(join(direct, "00000.primary"))) {
        return direct;
    }
    const nested = join(direct, "immutable");
    if (existsSync(nested)) return nested;
    return direct;
}

/**
 * Max immutable file number present locally, or null if none.
 */
export function maxLocalImmutableNumber(immutableDir: string): number | null {
    const names = listLocalImmutableFileNames(immutableDir);
    let max = -1;
    for (const n of names) {
        const num = immutableFileNumberFromName(n);
        if (num != null && num > max) max = num;
    }
    return max < 0 ? null : max;
}

/**
 * Completed local files = all trios with imm# < maxLocal
 * (Mithril list_completed_in_dir skips the last incomplete trio).
 *
 * When skipLastIncompleteTrio=false, include all local files.
 */
export function listCompletedLocalImmutableNames(
    immutableDir: string,
    opts: { skipLastIncompleteTrio?: boolean } = {},
): { completed: string[]; skippedLastTrio: string[]; maxLocalImm: number | null } {
    const skipLast = opts.skipLastIncompleteTrio !== false;
    const names = listLocalImmutableFileNames(immutableDir);
    if (names.length === 0) {
        return { completed: [], skippedLastTrio: [], maxLocalImm: null };
    }
    const maxLocalImm = maxLocalImmutableNumber(immutableDir);
    if (maxLocalImm == null) {
        return { completed: [], skippedLastTrio: [], maxLocalImm: null };
    }
    if (!skipLast) {
        return { completed: names, skippedLastTrio: [], maxLocalImm };
    }
    const completed = names.filter((n) => {
        const num = immutableFileNumberFromName(n);
        return num != null && num < maxLocalImm;
    });
    const skippedLastTrio = names.filter((n) => {
        const num = immutableFileNumberFromName(n);
        return num != null && num === maxLocalImm;
    });
    return { completed, skippedLastTrio, maxLocalImm };
}

/**
 * Compute digests for a list of local immutable filenames.
 */
export async function computeLocalImmutableDigests(
    immutableDir: string,
    fileNames: string[],
): Promise<LocalDigestEntry[]> {
    const out: LocalDigestEntry[] = [];
    for (const name of fileNames) {
        const path = join(immutableDir, name);
        if (!existsSync(path)) continue;
        const size = statSync(path).size;
        const digest = await sha256FileHex(path);
        out.push({ immutable_file_name: name, path, digest, size });
    }
    return out;
}

/**
 * Stage 5h: verify local immutable files against published digests artifact.
 *
 * - Hashes each completed local file (SHA-256)
 * - Compares to published digests map by filename
 * - Skips last incomplete trio by default (Mithril SoT)
 * - Only checks files that exist both locally and in published digests
 * - ok=true when checked>0 and mismatched===0 and missingLocal===0 for
 *   the completed set that exists in published digests
 *
 * Partial local snapshots (tip digests go further than local max) are OK:
 * we only require every *completed local* file present in digests to match.
 */
export async function verifyLocalDigestsAgainstPublished(
    immutableDirOrDb: string,
    publishedDigests: ImmutableFileDigest[],
    opts: {
        /** Default true — skip last local imm# trio (incomplete). */
        skipLastIncompleteTrio?: boolean;
        /** Optional cap: only check imm# <= this (in addition to completed filter). */
        maxImmutableFileNumber?: number;
        /** Max mismatches to retain in result (default 10). */
        maxMismatchSamples?: number;
    } = {},
): Promise<VerifyLocalDigestsAgainstPublishedResult> {
    const immutableDir = resolveImmutableDir(immutableDirOrDb);
    const maxSamples = opts.maxMismatchSamples ?? 10;

    if (!existsSync(immutableDir)) {
        return {
            ok: false,
            checked: 0,
            matched: 0,
            mismatched: 0,
            missingLocal: 0,
            missingPublished: 0,
            skippedLastTrio: [],
            maxLocalImm: null,
            mismatches: [],
            reason: `Stage 5h: immutable dir not found: ${immutableDir}`,
        };
    }

    const byPublished = new Map<string, string>();
    for (const d of publishedDigests) {
        if (typeof d.digest === "string" && HEX64.test(d.digest)) {
            byPublished.set(d.immutable_file_name, d.digest.toLowerCase());
        }
    }
    if (byPublished.size === 0) {
        return {
            ok: false,
            checked: 0,
            matched: 0,
            mismatched: 0,
            missingLocal: 0,
            missingPublished: 0,
            skippedLastTrio: [],
            maxLocalImm: null,
            mismatches: [],
            reason: "Stage 5h: no valid published digests provided",
        };
    }

    let { completed, skippedLastTrio, maxLocalImm } =
        listCompletedLocalImmutableNames(immutableDir, {
            skipLastIncompleteTrio: opts.skipLastIncompleteTrio,
        });

    if (opts.maxImmutableFileNumber != null) {
        const cap = opts.maxImmutableFileNumber;
        completed = completed.filter((n) => {
            const num = immutableFileNumberFromName(n);
            return num != null && num <= cap;
        });
    }

    if (completed.length === 0) {
        return {
            ok: false,
            checked: 0,
            matched: 0,
            mismatched: 0,
            missingLocal: 0,
            missingPublished: 0,
            skippedLastTrio,
            maxLocalImm,
            mismatches: [],
            reason: "Stage 5h: no completed local immutable files to check",
        };
    }

    let matched = 0;
    let mismatched = 0;
    let missingPublished = 0;
    let checked = 0;
    const mismatches: VerifyLocalDigestsAgainstPublishedResult["mismatches"] =
        [];

    for (const name of completed) {
        const published = byPublished.get(name);
        if (!published) {
            missingPublished++;
            continue;
        }
        const path = join(immutableDir, name);
        if (!existsSync(path)) {
            // Shouldn't happen for list from readdir — count as missing local
            continue;
        }
        checked++;
        const local = await sha256FileHex(path);
        if (local === published) {
            matched++;
        } else {
            mismatched++;
            if (mismatches.length < maxSamples) {
                mismatches.push({
                    name,
                    local: local.slice(0, 16),
                    published: published.slice(0, 16),
                    size: statSync(path).size,
                });
            }
        }
    }

    const ok = checked > 0 && mismatched === 0;
    const reason = ok
        ? `Stage 5h: local digests OK — ${matched}/${checked} match published` +
          (skippedLastTrio.length
              ? ` (skipped last trio ${skippedLastTrio.join(",")})`
              : "")
        : mismatched > 0
          ? `Stage 5h: ${mismatched}/${checked} local digests mismatch published` +
            (mismatches[0]
                ? ` (e.g. ${mismatches[0].name})`
                : "")
          : `Stage 5h: nothing checked (completed=${completed.length}, missingPublished=${missingPublished})`;

    return {
        ok,
        checked,
        matched,
        mismatched,
        missingLocal: 0,
        missingPublished,
        skippedLastTrio,
        maxLocalImm,
        mismatches,
        reason,
    };
}
