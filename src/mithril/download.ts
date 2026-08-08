/**
 * Mithril Cardano DB immutable chunk download (HTTP + pure-TS zstd/tar).
 *
 * Proven layout (preprod CDN):
 *   GET .../immutable/00000.tar.zst
 *   → tar contains immutable/00000.{chunk,primary,secondary}
 *
 * WASM client lists/verifies only — multi-GB unpack stays here or external bin.
 * Extract path:
 *   - Small packs: fzstd + tar-stream (pure-TS, no system tools)
 *   - Large packs (ancillary ~400MB+): disk-backed system `zstd -d` then
 *     tar-stream (or system tar). Bun cannot pipe child stdio streams.
 *
 * Memory note: fzstd.decompress loads one archive into heap — fine for MB
 * immutable packs; fails on preprod ancillary (~394MB compressed / ~970MB tar).
 */

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
    access,
    constants as fsConstants,
    mkdir,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { decompress } from "fzstd";
import { extract as tarExtract } from "tar-stream";

import type { MithrilCdbSnapshot, MithrilLocation } from "./types";

/** Prefer system zstd when compressed size exceeds this (fzstd heap + large-frame issues). */
export const FZSTD_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB
export function padImmutableNo(n: number): string {
    return n.toString().padStart(5, "0");
}

/** Extract cloud template URL string from a location entry. */
export function locationTemplate(loc: MithrilLocation): string | null {
    const u = loc.uri;
    if (typeof u === "string" && u.includes("{immutable_file_number}")) {
        return u;
    }
    if (u && typeof u === "object") {
        const t = u.Template || u.template;
        if (typeof t === "string" && t.includes("{immutable_file_number}")) {
            return t;
        }
        // plain URI without template (digests)
        if (typeof t === "string") return t;
    }
    if (typeof u === "string") return u;
    return null;
}

export function immutableTemplateFromSnapshot(
    snap: MithrilCdbSnapshot,
): string {
    const locs = snap.immutables?.locations ?? [];
    for (const loc of locs) {
        const t = locationTemplate(loc);
        if (t && t.includes("{immutable_file_number}")) return t;
    }
    // Fallback known CDN pattern (preprod/mainnet release)
    const net = (snap.network || "preprod").toLowerCase();
    const mode = net === "mainnet" ? "release-mainnet" : "release-preprod";
    return `https://storage.googleapis.com/cdn.aggregator.${mode}.api.mithril.network/cardano-database/immutable/{immutable_file_number}.tar.zst`;
}

/**
 * Stream-download URL to a file (avoids buffering entire body in JS heap).
 */
export async function downloadToFile(
    url: string,
    destPath: string,
): Promise<number> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} downloading ${url}`);
    }
    if (!res.body) {
        throw new Error(`Empty body for ${url}`);
    }
    // Bun/Node ReadableStream → Node stream (double-cast: DOM vs node stream types diverge)
    const nodeReadable = Readable.fromWeb(
        res.body as unknown as import("stream/web").ReadableStream,
    );
    await pipeline(nodeReadable, createWriteStream(destPath));
    const file = Bun.file(destPath);
    return file.size;
}

function hasSystemZstd(): boolean {
    try {
        const r = spawnSync("zstd", ["--version"], {
            encoding: "utf8",
            timeout: 5_000,
        });
        return r.status === 0;
    } catch {
        return false;
    }
}

/**
 * Stream tar entries from a Readable into root. Rejects path traversal.
 * Used by both pure-TS (in-memory tar) and disk-backed (file stream) paths.
 */
async function extractTarStreamToDir(
    tarReadable: Readable,
    root: string,
): Promise<string[]> {
    const rootAbs = resolve(root);
    const written: string[] = [];

    await new Promise<void>((resolveExtract, rejectExtract) => {
        const ex = tarExtract();
        let settled = false;
        const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            rejectExtract(err instanceof Error ? err : new Error(String(err)));
        };
        const done = () => {
            if (settled) return;
            settled = true;
            resolveExtract();
        };

        ex.on("entry", (header, stream, next) => {
            const type = header.type as string | undefined;
            const isFile =
                type === "file" ||
                type === "File" ||
                type === "0" ||
                type === undefined ||
                type === null;

            if (!isFile || !header.name) {
                stream.resume();
                stream.on("end", () => next());
                stream.on("error", fail);
                return;
            }

            // normalize + reject traversal
            const rel = header.name.replace(/^\.?\//, "");
            if (
                rel.includes("..") ||
                rel.startsWith("/") ||
                rel.includes("\0")
            ) {
                stream.resume();
                fail(new Error(`Refusing unsafe tar path: ${header.name}`));
                return;
            }
            const dest = resolve(rootAbs, rel);
            if (dest !== rootAbs && !dest.startsWith(rootAbs + "/")) {
                stream.resume();
                fail(new Error(`Refusing path escape: ${header.name}`));
                return;
            }

            void (async () => {
                try {
                    await mkdir(dirname(dest), { recursive: true });
                    const out = createWriteStream(dest);
                    await pipeline(stream, out);
                    written.push(rel);
                    next();
                } catch (e) {
                    fail(e);
                }
            })();
        });
        ex.on("finish", done);
        ex.on("error", fail);
        tarReadable.on("error", fail);
        tarReadable.pipe(ex);
    });

    return written;
}

/**
 * Disk-backed extract: system `zstd -d` → temp .tar → tar-stream into root.
 * Two-step (no Bun child stdio pipes). Prefer for large ancillary archives.
 */
export async function extractTarZstFromFile(
    zstPath: string,
    root: string,
    opts?: { log?: (msg: string) => void },
): Promise<string[]> {
    const log = opts?.log ?? (() => {});
    const zstAbs = resolve(zstPath);
    if (!existsSync(zstAbs)) {
        throw new Error(`extractTarZstFromFile: missing ${zstAbs}`);
    }
    if (!hasSystemZstd()) {
        throw new Error(
            "extractTarZstFromFile: system zstd not found (needed for large archives)",
        );
    }

    const tarPath = zstAbs.replace(/\.zst$/i, "") + ".tmp.tar";
    // If input is foo.tar.zst → foo.tar.tmp.tar is ugly; prefer sibling .tar
    const tarOut = zstAbs.endsWith(".tar.zst")
        ? zstAbs.slice(0, -4) // strip .zst → .tar
        : tarPath;

    try {
        log(`  system zstd -d ${zstAbs} → ${tarOut}`);
        const dec = spawnSync(
            "zstd",
            ["-d", "-f", "-o", tarOut, zstAbs],
            {
                encoding: "utf8",
                // large ancillary ~1GB tar; give room
                timeout: 600_000,
                maxBuffer: 16 * 1024 * 1024,
            },
        );
        if (dec.status !== 0) {
            throw new Error(
                `zstd -d failed (status=${dec.status}): ${dec.stderr || dec.stdout || "no output"}`,
            );
        }
        if (!existsSync(tarOut)) {
            throw new Error(`zstd -d produced no tar at ${tarOut}`);
        }

        log(`  tar-stream extract ${tarOut} → ${root}`);
        const written = await extractTarStreamToDir(
            createReadStream(tarOut),
            root,
        );
        return written;
    } finally {
        await rm(tarOut, { force: true }).catch(() => {});
    }
}

/**
 * Decompress .tar.zst and extract file entries under root.
 *
 * - In-memory fzstd path for small buffers (immutable chunks).
 * - Falls back to message if fzstd fails — callers with a file path should
 *   use extractTarZstFromFile instead for large archives.
 * Rejects path traversal outside root.
 */
export async function extractTarZstToDir(
    zstBytes: Uint8Array,
    root: string,
): Promise<string[]> {
    let tarBytes: Uint8Array;
    try {
        tarBytes = decompress(zstBytes);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
            `fzstd decompress failed (${msg}). ` +
                `For large archives use extractTarZstFromFile (system zstd disk path).`,
        );
    }
    return extractTarStreamToDir(
        Readable.from([Buffer.from(tarBytes)]),
        root,
    );
}

/** True when immutable/{padded}.{chunk,primary,secondary} all exist. */
export async function hasCompleteImmutableTrio(
    downloadDir: string,
    chunkNo: number,
): Promise<{ complete: boolean; immutableDir: string | null }> {
    const root = resolve(downloadDir);
    const immutableDir = await findImmutableDir(root);
    if (!immutableDir) return { complete: false, immutableDir: null };
    const padded = padImmutableNo(chunkNo);
    const expected = [
        `${padded}.chunk`,
        `${padded}.primary`,
        `${padded}.secondary`,
    ];
    for (const name of expected) {
        if (!existsSync(join(immutableDir, name))) {
            return { complete: false, immutableDir };
        }
    }
    return { complete: true, immutableDir };
}

/**
 * Download one immutable file number and extract into downloadDir.
 * Returns path to immutable dir (…/immutable).
 * When skipIfPresent (default true), reuses a complete on-disk trio.
 */
export async function downloadImmutableChunk(opts: {
    template: string;
    chunkNo: number;
    downloadDir: string;
    /** Keep .tar.zst after extract (default false). */
    keepArchive?: boolean;
    /** Skip GET+extract when trio already on disk (default true). */
    skipIfPresent?: boolean;
    log?: (msg: string) => void;
}): Promise<{ immutableDir: string; files: string[]; skipped: boolean }> {
    const log = opts.log ?? (() => {});
    const padded = padImmutableNo(opts.chunkNo);
    const root = resolve(opts.downloadDir);
    await mkdir(root, { recursive: true });

    const skipIfPresent = opts.skipIfPresent !== false;
    if (skipIfPresent) {
        const existing = await hasCompleteImmutableTrio(root, opts.chunkNo);
        if (existing.complete && existing.immutableDir) {
            log(`  skip chunk ${padded} (trio present)`);
            return {
                immutableDir: existing.immutableDir,
                files: [
                    `${padded}.chunk`,
                    `${padded}.primary`,
                    `${padded}.secondary`,
                ],
                skipped: true,
            };
        }
    }

    const url = opts.template.replaceAll("{immutable_file_number}", padded);
    const archivesDir = join(root, ".mithril-archives");
    await mkdir(archivesDir, { recursive: true });
    const zstPath = join(archivesDir, `${padded}.tar.zst`);

    log(`GET ${url}`);
    const bytes = await downloadToFile(url, zstPath);
    log(`  saved ${zstPath} (${bytes} bytes)`);

    log(`  pure-TS fzstd+tar-stream extract → ${root}`);
    const zstBuf = new Uint8Array(await Bun.file(zstPath).arrayBuffer());
    const written = await extractTarZstToDir(zstBuf, root);
    log(`  extracted ${written.length} entries`);

    if (!opts.keepArchive) {
        await rm(zstPath, { force: true });
    }

    const immutableDir = await findImmutableDir(root);
    if (!immutableDir) {
        throw new Error(
            `After extract of ${padded}, no immutable/ dir under ${root}`,
        );
    }

    const expected = [
        `${padded}.chunk`,
        `${padded}.primary`,
        `${padded}.secondary`,
    ];
    const names = await readdir(immutableDir);
    const missing = expected.filter((e) => !names.includes(e));
    if (missing.length) {
        throw new Error(
            `Chunk ${padded} missing files in ${immutableDir}: ${missing.join(", ")}`,
        );
    }

    return { immutableDir, files: expected, skipped: false };
}

/**
 * Download a range of immutable chunks [from, to] inclusive.
 * Default skipIfPresent=true resumes without re-fetching complete trios.
 */
export async function downloadImmutableRange(opts: {
    snapshot: MithrilCdbSnapshot;
    downloadDir: string;
    fromChunk: number;
    toChunk: number;
    /** Skip complete on-disk trios (default true). */
    skipIfPresent?: boolean;
    log?: (msg: string) => void;
}): Promise<{
    immutableDir: string;
    downloaded: number[];
    skipped: number[];
}> {
    const template = immutableTemplateFromSnapshot(opts.snapshot);
    const maxBeacon =
        opts.snapshot.beacon?.immutable_file_number ?? opts.toChunk;
    const from = Math.max(0, opts.fromChunk);
    const to = Math.min(maxBeacon, opts.toChunk);
    if (from > to) {
        throw new Error(
            `Invalid chunk range from=${from} to=${to} (beacon max=${maxBeacon})`,
        );
    }

    const downloaded: number[] = [];
    const skipped: number[] = [];
    let immutableDir = "";
    const skipIfPresent = opts.skipIfPresent !== false;
    for (let n = from; n <= to; n++) {
        const r = await downloadImmutableChunk({
            template,
            chunkNo: n,
            downloadDir: opts.downloadDir,
            skipIfPresent,
            log: opts.log,
        });
        immutableDir = r.immutableDir;
        if (r.skipped) skipped.push(n);
        else downloaded.push(n);
    }
    return { immutableDir, downloaded, skipped };
}

/**
 * Resolve ancillary download URL from snapshot detail.
 * Preprod shape: ancillary.locations[0].uri = plain HTTPS .tar.zst (not a template).
 */
export function ancillaryUrlFromSnapshot(snap: MithrilCdbSnapshot): string | null {
    const locs = snap.ancillary?.locations ?? [];
    for (const loc of locs) {
        const t = locationTemplate(loc);
        if (!t) continue;
        // plain URL (typical) or template — ancillary is usually a single archive
        if (t.startsWith("http://") || t.startsWith("https://")) return t;
    }
    return null;
}

/**
 * Download + extract ancillary archive into downloadDir.
 *
 * Honesty:
 *   - Does NOT apply UTxO (A2 blocked) — only lands files for probeAncillaryLedger
 *   - Archive ~394MB compressed / ~970MB tar — uses disk-backed system zstd
 *     (fzstd fails on this size; Bun cannot pipe child stdio)
 *   - Prefer --include-ancillary only when you have disk headroom
 */
export async function downloadAncillary(opts: {
    snapshot: MithrilCdbSnapshot;
    downloadDir: string;
    /** Keep .tar.zst after extract (default false). */
    keepArchive?: boolean;
    log?: (msg: string) => void;
}): Promise<{ ancillaryDir: string; url: string; bytes: number }> {
    const log = opts.log ?? (() => {});
    const url = ancillaryUrlFromSnapshot(opts.snapshot);
    if (!url) {
        throw new Error(
            "Snapshot has no ancillary.locations URL — cannot --include-ancillary",
        );
    }

    const root = resolve(opts.downloadDir);
    await mkdir(root, { recursive: true });
    const archivesDir = join(root, ".mithril-archives");
    await mkdir(archivesDir, { recursive: true });

    const base =
        url.split("/").pop()?.replace(/\.tar\.zst$/i, "") || "ancillary";
    const zstPath = join(archivesDir, `${base}.tar.zst`);

    // Reuse on-disk archive if present and non-empty (avoid re-download)
    let bytes = 0;
    if (existsSync(zstPath)) {
        const existing = Bun.file(zstPath);
        bytes = existing.size;
        if (bytes > 0) {
            log(`  reuse on-disk ancillary ${zstPath} (${bytes} bytes)`);
        }
    }
    if (bytes === 0) {
        log(`GET ancillary ${url}`);
        bytes = await downloadToFile(url, zstPath);
        log(`  saved ${zstPath} (${bytes} bytes)`);
    }

    // Large archive: disk-backed system zstd → tar-stream (no fzstd heap)
    log(`  system zstd + tar-stream extract ancillary → ${root}`);
    const written = await extractTarZstFromFile(zstPath, root, { log });
    log(`  extracted ${written.length} ancillary entries`);

    if (!opts.keepArchive) {
        await rm(zstPath, { force: true });
    }

    const ancillaryDir = await findAncillaryLedgerDir(root);
    if (!ancillaryDir) {
        throw new Error(
            `After ancillary extract, no ledger/ dir under ${root}. ` +
                `Sample entries: ${written.slice(0, 8).join(", ")}`,
        );
    }
    log(`  ancillary ledger dir: ${ancillaryDir}`);
    return { ancillaryDir, url, bytes };
}

/** Find ledger/ (ancillary NewEpochState tree) under download root. */
export async function findAncillaryLedgerDir(
    root: string,
): Promise<string | null> {
    const candidates = [
        resolve(root, "ledger"),
        resolve(root, "db", "ledger"),
        resolve(root, "ancillary", "ledger"),
    ];
    for (const c of candidates) {
        try {
            await access(c, fsConstants.R_OK);
            const names = await readdir(c);
            // expect numeric slot dirs and/or state/meta
            if (
                names.some((n) => /^\d+$/.test(n)) ||
                names.includes("state") ||
                names.includes("meta")
            ) {
                return c;
            }
        } catch {
            /* try next */
        }
    }
    // one-level walk for nested layouts
    try {
        const top = await readdir(root, { withFileTypes: true });
        for (const ent of top) {
            if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
            if (ent.name === "immutable" || ent.name === ".mithril-archives") {
                continue;
            }
            const found = await findAncillaryLedgerDir(resolve(root, ent.name));
            if (found) return found;
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** Find db/immutable under downloadDir (mithril-client + our extract layout). */
export async function findImmutableDir(root: string): Promise<string | null> {
    const candidates = [
        resolve(root, "db", "immutable"),
        resolve(root, "immutable"),
        resolve(root, "db"),
    ];
    for (const c of candidates) {
        try {
            await access(c, fsConstants.R_OK);
            const names = await readdir(c);
            if (
                names.some(
                    (n) =>
                        /\.(chunk|primary|secondary)$/.test(n) ||
                        /^\d+$/.test(n),
                )
            ) {
                if (c.endsWith("/db") || c.endsWith("\\db")) {
                    const imm = resolve(c, "immutable");
                    try {
                        await access(imm, fsConstants.R_OK);
                        return imm;
                    } catch {
                        /* fall through */
                    }
                }
                return c;
            }
        } catch {
            /* try next */
        }
    }
    // one-level walk
    try {
        const top = await readdir(root, { withFileTypes: true });
        for (const ent of top) {
            if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
            const found = await findImmutableDir(resolve(root, ent.name));
            if (found) return found;
        }
    } catch {
        /* ignore */
    }
    return null;
}

export function resolveMithrilClientBin(explicit?: string): string | null {
    if (explicit && existsSync(explicit)) return explicit;
    const envPath = process.env.MITHRIL_CLIENT;
    if (envPath && existsSync(envPath)) return envPath;
    const pathEnv = process.env.PATH || "";
    for (const dir of pathEnv.split(":")) {
        const candidate = resolve(dir, "mithril-client");
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export async function runMithrilClientBin(opts: {
    clientBin: string;
    aggregator: string;
    genesisKey: string;
    digest: string;
    downloadDir: string;
    log?: (msg: string) => void;
}): Promise<void> {
    const log = opts.log ?? console.log;
    const env = {
        ...process.env,
        AGGREGATOR_ENDPOINT: opts.aggregator,
        GENESIS_VERIFICATION_KEY: opts.genesisKey,
    };
    const tryArgs = [
        [
            "cardano-db",
            "download",
            opts.digest,
            "--download-dir",
            opts.downloadDir,
        ],
        [
            "cardano-db",
            "snapshot",
            "download",
            opts.digest,
            "--download-dir",
            opts.downloadDir,
        ],
    ];
    let lastCode = 1;
    for (const args of tryArgs) {
        log(`Running: ${opts.clientBin} ${args.join(" ")}`);
        lastCode = await new Promise<number>((resolveExit, reject) => {
            const child = spawn(opts.clientBin, args, {
                cwd: opts.downloadDir,
                env,
                stdio: "inherit",
            });
            child.on("error", reject);
            child.on("close", (code) => resolveExit(code ?? 1));
        });
        if (lastCode === 0) return;
        log(`  exit ${lastCode}; trying fallback argv…`);
    }
    throw new Error(
        `mithril-client exited ${lastCode}. Check aggregator/genesis and client version.`,
    );
}
