/**
 * Mithril Cardano DB immutable chunk download (HTTP + pure-TS zstd/tar).
 *
 * Proven layout (preprod CDN):
 *   GET .../immutable/00000.tar.zst
 *   → tar contains immutable/00000.{chunk,primary,secondary}
 *
 * WASM client lists/verifies only — multi-GB unpack stays here or external bin.
 * Extract path uses fzstd + tar-stream (no system zstd/tar required).
 *
 * Memory note: fzstd.decompress loads one chunk archive into heap.
 * Mithril immutable packs are ~MB-scale; streaming Decompress if that grows.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
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

/**
 * Pure-TS: decompress .tar.zst bytes and extract file entries under root.
 * Rejects path traversal outside root.
 */
export async function extractTarZstToDir(
    zstBytes: Uint8Array,
    root: string,
): Promise<string[]> {
    const tarBytes = decompress(zstBytes);
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
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer | Uint8Array) => {
                chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
            });
            stream.on("error", fail);
            stream.on("end", () => {
                void (async () => {
                    try {
                        const type = header.type as string | undefined;
                        const isFile =
                            type === "file" ||
                            type === "File" ||
                            type === "0" ||
                            type === undefined ||
                            type === null;
                        if (isFile && header.name) {
                            // normalize + reject traversal
                            const rel = header.name.replace(/^\.?\//, "");
                            if (
                                rel.includes("..") ||
                                rel.startsWith("/") ||
                                rel.includes("\0")
                            ) {
                                throw new Error(
                                    `Refusing unsafe tar path: ${header.name}`,
                                );
                            }
                            const dest = resolve(rootAbs, rel);
                            if (
                                dest !== rootAbs &&
                                !dest.startsWith(rootAbs + "/")
                            ) {
                                throw new Error(
                                    `Refusing path escape: ${header.name}`,
                                );
                            }
                            await mkdir(dirname(dest), { recursive: true });
                            const buf = Buffer.concat(chunks);
                            await writeFile(dest, buf);
                            written.push(rel);
                        } else {
                            // drain non-file entries
                            stream.resume();
                        }
                        next();
                    } catch (e) {
                        fail(e);
                    }
                })();
            });
        });
        ex.on("finish", done);
        ex.on("error", fail);

        const r = Readable.from([Buffer.from(tarBytes)]);
        r.on("error", fail);
        r.pipe(ex);
    });

    return written;
}

/**
 * Download one immutable file number and extract into downloadDir.
 * Returns path to immutable dir (…/immutable).
 */
export async function downloadImmutableChunk(opts: {
    template: string;
    chunkNo: number;
    downloadDir: string;
    /** Keep .tar.zst after extract (default false). */
    keepArchive?: boolean;
    log?: (msg: string) => void;
}): Promise<{ immutableDir: string; files: string[] }> {
    const log = opts.log ?? (() => {});
    const padded = padImmutableNo(opts.chunkNo);
    const url = opts.template.replaceAll("{immutable_file_number}", padded);
    const root = resolve(opts.downloadDir);
    await mkdir(root, { recursive: true });

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

    return { immutableDir, files: expected };
}

/**
 * Download a range of immutable chunks [from, to] inclusive.
 */
export async function downloadImmutableRange(opts: {
    snapshot: MithrilCdbSnapshot;
    downloadDir: string;
    fromChunk: number;
    toChunk: number;
    log?: (msg: string) => void;
}): Promise<{ immutableDir: string; downloaded: number[] }> {
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
    let immutableDir = "";
    for (let n = from; n <= to; n++) {
        const r = await downloadImmutableChunk({
            template,
            chunkNo: n,
            downloadDir: opts.downloadDir,
            log: opts.log,
        });
        immutableDir = r.immutableDir;
        downloaded.push(n);
    }
    return { immutableDir, downloaded };
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
 * Download + pure-TS extract ancillary archive into downloadDir.
 *
 * Honesty:
 *   - Does NOT apply UTxO (A2 blocked) — only lands files for probeAncillaryLedger
 *   - Archive can be ~1GB; download streams to disk; extract uses fzstd (heap load of tar)
 *   - Prefer --include-ancillary only when you have RAM/disk headroom
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

    log(`GET ancillary ${url}`);
    const bytes = await downloadToFile(url, zstPath);
    log(`  saved ${zstPath} (${bytes} bytes)`);

    // Extract into root; typical layout: ledger/<slot>/{state,meta,tables/…}
    log(`  pure-TS fzstd+tar-stream extract ancillary → ${root}`);
    const zstBuf = new Uint8Array(await Bun.file(zstPath).arrayBuffer());
    const written = await extractTarZstToDir(zstBuf, root);
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
