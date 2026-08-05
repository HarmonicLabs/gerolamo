/**
 * Ancillary ledger loader / probe (Mithril Cardano DB snapshot).
 *
 * Phase 3 / A2 status (honest, preprod e305 layout proven 2026-08-05):
 * - Download: mithril-bootstrap --include-ancillary (or downloadAncillary)
 * - Extract large archive: extractTarZstFromFile (system zstd disk path;
 *   fzstd fails on ~394MB ancillary)
 * - On-disk layout under ledger/<slot>/:
 *     meta   — JSON text { backend, checksum, tablesCodecVersion }
 *     state  — CBOR NewEpochState-ish (~30MB) — parseable with Cbor.parse
 *     tables — single ~940MB FILE (NOT tables/tvar dir):
 *              CBOR [ indefinite-map ] of bstr(34) → bstr(value)
 *              meta.backend = "utxohd-mem", tablesCodecVersion = 1
 * - UTxO extract: still **blocked** — values are utxohd-mem codec v1 blobs,
 *   not plain TxOut CBOR. Streaming can count map entries; cannot decode
 *   addresses/amounts without the codec. No fake UTxO inserts.
 *
 * Density path remains: immutable chunks via processChunk / read-raw-chunks.
 */

import { join } from "node:path";
import { readdir, open } from "node:fs/promises";

import {
    Cbor,
    CborArray,
    CborMap,
    LazyCborArray,
    LazyCborMap,
} from "@harmoniclabs/cbor";

export type FileSniff = {
    size: number;
    exists: boolean;
    /** First N bytes as lowercase hex (empty if missing). */
    headHex: string;
    /** Best-effort format guess from magic / CBOR major type / JSON. */
    formatGuess: string;
};

export type LazyShape = {
    kind: string;
    indefinite?: boolean;
    length?: number;
    note?: string;
};

export type AncillaryMeta = {
    backend?: string;
    checksum?: number;
    tablesCodecVersion?: number;
    raw?: unknown;
};

export type AncillaryProbeResult = {
    ledgerPath: string;
    latestSlotDir: string | null;
    files: {
        state: FileSniff;
        meta: FileSniff;
        /**
         * UTxO table blob. Preprod e305: single file `tables` (~940MB).
         * Legacy path `tables/tvar` still probed as fallback.
         */
        tables: FileSniff;
        /** @deprecated alias of tables when only legacy tvar existed */
        tvar: FileSniff;
    };
    /** Top-level shape of `state` (never full unwrap of tables). */
    stateShape?: LazyShape;
    metaShape?: LazyShape;
    /** Parsed meta JSON when meta is JSON text. */
    metaJson?: AncillaryMeta | null;
    /** Always false until utxohd-mem codec + streaming adapter exist. */
    utxoExtracted: false;
    blockedReason: string;
};

const BLOCKED_REASON =
    "A2: utxohd-mem tablesCodecVersion=1 — `tables` is a ~940MB CBOR " +
    "indefinite map (bstr keys → opaque value blobs). Streaming can count " +
    "entries; cannot decode TxOut without codec. Density = immutable chunks " +
    "(processChunk / read-raw-chunks). No fake UTxO inserts.";

const EMPTY_SNIFF: FileSniff = {
    exists: false,
    size: 0,
    headHex: "",
    formatGuess: "missing",
};

function describeCborShape(obj: unknown): LazyShape {
    if (obj == null) return { kind: "null" };
    if (obj instanceof LazyCborArray) {
        return {
            kind: "LazyCborArray",
            indefinite: obj.indefinite,
            length: obj.array.length,
            note: "elements are raw byte slices (not expanded)",
        };
    }
    if (obj instanceof LazyCborMap) {
        return {
            kind: "LazyCborMap",
            indefinite: obj.indefinite,
            length: obj.map.length,
            note: "entries are raw k/v byte slices (not expanded)",
        };
    }
    if (obj instanceof CborArray) {
        return {
            kind: "CborArray",
            indefinite: obj.indefinite,
            length: obj.array.length,
            note: "full parse (state-sized only; never tables)",
        };
    }
    if (obj instanceof CborMap) {
        return {
            kind: "CborMap",
            indefinite: obj.indefinite,
            length: obj.map.length,
        };
    }
    const name =
        typeof obj === "object" && obj !== null && "constructor" in obj
            ? (obj as { constructor?: { name?: string } }).constructor?.name
            : typeof obj;
    return { kind: name || typeof obj };
}

/** Guess file format from first bytes — no full parse. */
export function guessFormatFromHead(head: Uint8Array): string {
    if (head.length === 0) return "empty";
    // JSON object/array text (meta is JSON, not CBOR)
    if (head[0] === 0x7b || head[0] === 0x5b) {
        // '{' or '['
        try {
            const s = Buffer.from(head).toString("utf8");
            if (s.trimStart().startsWith("{") || s.trimStart().startsWith("[")) {
                return "json_text";
            }
        } catch {
            /* fall through */
        }
    }
    // zstd magic: 28 B5 2F FD
    if (
        head.length >= 4 &&
        head[0] === 0x28 &&
        head[1] === 0xb5 &&
        head[2] === 0x2f &&
        head[3] === 0xfd
    ) {
        return "zstd";
    }
    // gzip
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        return "gzip";
    }
    // zlib (common 78 01 / 78 9c / 78 da)
    if (
        head.length >= 2 &&
        head[0] === 0x78 &&
        [0x01, 0x9c, 0xda].includes(head[1]!)
    ) {
        return "zlib";
    }
    // sqlite magic "SQLi" (full header is 16 bytes; 4-byte prefix is enough)
    if (
        head.length >= 4 &&
        head[0] === 0x53 &&
        head[1] === 0x51 &&
        head[2] === 0x4c &&
        head[3] === 0x69
    ) {
        return "sqlite";
    }
    // CBOR major type from first byte high 3 bits
    const major = head[0]! >> 5;
    const cborMajors = [
        "cbor_uint",
        "cbor_nint",
        "cbor_bytes",
        "cbor_text",
        "cbor_array",
        "cbor_map",
        "cbor_tag",
        "cbor_simple_float",
    ];
    const ai = head[0]! & 0x1f;
    const indef = ai === 31 ? "_indef" : "";
    if (major >= 0 && major <= 7) {
        return `${cborMajors[major]}${indef}`;
    }
    return `unknown_0x${head[0]!.toString(16).padStart(2, "0")}`;
}

/** Read first `n` bytes of a file for sniffing (no full load). */
export async function sniffFileHead(
    path: string,
    n = 64,
): Promise<{ exists: boolean; size: number; head: Uint8Array }> {
    try {
        const fh = await open(path, "r");
        try {
            const st = await fh.stat();
            const size = st.size;
            if (size === 0) {
                return { exists: true, size: 0, head: new Uint8Array(0) };
            }
            const buf = Buffer.alloc(Math.min(n, size));
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            return {
                exists: true,
                size,
                head: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead),
            };
        } finally {
            await fh.close();
        }
    } catch {
        return { exists: false, size: 0, head: new Uint8Array(0) };
    }
}

function toSniff(s: {
    exists: boolean;
    size: number;
    head: Uint8Array;
}): FileSniff {
    if (!s.exists) return { ...EMPTY_SNIFF };
    return {
        exists: true,
        size: s.size,
        headHex: Buffer.from(s.head).toString("hex"),
        formatGuess: guessFormatFromHead(s.head),
    };
}

/**
 * Resolve UTxO tables path under a slot dir.
 * Preprod e305: `tables` is a FILE. Legacy: `tables/tvar`.
 */
export async function resolveTablesPath(
    slotDir: string,
): Promise<{ path: string; kind: "tables" | "tables/tvar" | "missing" }> {
    const asFile = join(slotDir, "tables");
    const asTvar = join(slotDir, "tables", "tvar");
    const fileSniff = await sniffFileHead(asFile, 4);
    if (fileSniff.exists && fileSniff.size > 0) {
        // If `tables` is a directory, prefer tables/tvar inside it
        try {
            const names = await readdir(asFile);
            if (names.includes("tvar")) {
                return { path: asTvar, kind: "tables/tvar" };
            }
            // directory without tvar — still missing for our purposes
            return { path: asTvar, kind: "missing" };
        } catch {
            // not a directory → it's the tables FILE
            return { path: asFile, kind: "tables" };
        }
    }
    const tvarSniff = await sniffFileHead(asTvar, 4);
    if (tvarSniff.exists) return { path: asTvar, kind: "tables/tvar" };
    return { path: asFile, kind: "missing" };
}

/**
 * Probe ancillary ledger dir without loading full tables into UTxO.
 * Safe: hex sniff always; parse state under size cap; meta as JSON when text.
 */
export async function probeAncillaryLedger(
    ledgerPath: string,
    opts: {
        maxParseBytes?: number;
        sniffBytes?: number;
        log?: (msg: string) => void;
    } = {},
): Promise<AncillaryProbeResult> {
    const log = opts.log ?? console.log;
    const maxParse = opts.maxParseBytes ?? 64 * 1024 * 1024; // 64 MiB soft cap
    const sniffN = opts.sniffBytes ?? 64;

    log(`Probing ancillary ledger at ${ledgerPath}…`);
    let dirs: string[] = [];
    try {
        dirs = await readdir(ledgerPath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Cannot read ledger path ${ledgerPath}: ${msg}`);
    }

    const slotDirs = dirs
        .map((d) => parseInt(d, 10))
        .filter((n) => Number.isFinite(n) && n >= 0);
    const latestSlot = slotDirs.length > 0 ? Math.max(...slotDirs) : null;
    const latestLedgerDirPath =
        latestSlot != null ? join(ledgerPath, String(latestSlot)) : null;

    if (!latestLedgerDirPath) {
        log("No numeric slot directories under ledger path");
        return {
            ledgerPath,
            latestSlotDir: null,
            files: {
                state: { ...EMPTY_SNIFF },
                meta: { ...EMPTY_SNIFF },
                tables: { ...EMPTY_SNIFF },
                tvar: { ...EMPTY_SNIFF },
            },
            utxoExtracted: false,
            blockedReason: BLOCKED_REASON + " (no slot dir)",
        };
    }

    log(`Using ledger snapshot dir: ${latestLedgerDirPath}`);

    const statePath = join(latestLedgerDirPath, "state");
    const metaPath = join(latestLedgerDirPath, "meta");
    const tablesRes = await resolveTablesPath(latestLedgerDirPath);

    const [stateSniff, metaSniff, tablesSniff] = await Promise.all([
        sniffFileHead(statePath, sniffN),
        sniffFileHead(metaPath, sniffN),
        sniffFileHead(tablesRes.path, sniffN),
    ]);

    const tables = toSniff(tablesSniff);
    const files = {
        state: toSniff(stateSniff),
        meta: toSniff(metaSniff),
        tables,
        // keep tvar alias for backward-compat consumers
        tvar: tables,
    };

    log(
        `Ancillary files: state=${files.state.exists}(${files.state.size},${files.state.formatGuess}) ` +
            `meta=${files.meta.exists}(${files.meta.size},${files.meta.formatGuess}) ` +
            `tables=${files.tables.exists}(${files.tables.size},${files.tables.formatGuess}) ` +
            `pathKind=${tablesRes.kind}`,
    );
    if (files.state.headHex)
        log(`  state head: ${files.state.headHex.slice(0, 32)}…`);
    if (files.meta.headHex) log(`  meta head: ${files.meta.headHex}`);
    if (files.tables.headHex)
        log(`  tables head: ${files.tables.headHex.slice(0, 32)}…`);

    const result: AncillaryProbeResult = {
        ledgerPath,
        latestSlotDir: latestLedgerDirPath,
        files,
        metaJson: null,
        utxoExtracted: false,
        blockedReason: BLOCKED_REASON,
    };

    // state: full Cbor.parse under size cap (parseLazy fails on this layout)
    if (files.state.exists && files.state.size > 0 && files.state.size <= maxParse) {
        try {
            const bytes = new Uint8Array(
                await Bun.file(statePath).arrayBuffer(),
            );
            const parsed = Cbor.parse(bytes);
            result.stateShape = describeCborShape(parsed);
            log(
                `state Cbor: kind=${result.stateShape.kind} ` +
                    `len=${result.stateShape.length ?? "?"} ` +
                    `indef=${result.stateShape.indefinite ?? "?"}`,
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.stateShape = {
                kind: "parse_error",
                note: `${msg} (formatGuess=${files.state.formatGuess})`,
            };
            log(`state Cbor probe failed: ${msg}`);
        }
    } else if (files.state.exists && files.state.size > maxParse) {
        result.stateShape = {
            kind: "skipped",
            note: `size ${files.state.size} > maxParseBytes ${maxParse}; sniff=${files.state.formatGuess}`,
        };
        log(result.stateShape.note!);
    }

    // meta: JSON text on preprod e305 (not CBOR)
    if (files.meta.exists && files.meta.size > 0 && files.meta.size <= maxParse) {
        try {
            const text = await Bun.file(metaPath).text();
            const trimmed = text.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                const j = JSON.parse(trimmed) as Record<string, unknown>;
                result.metaJson = {
                    backend:
                        typeof j.backend === "string" ? j.backend : undefined,
                    checksum:
                        typeof j.checksum === "number" ? j.checksum : undefined,
                    tablesCodecVersion:
                        typeof j.tablesCodecVersion === "number"
                            ? j.tablesCodecVersion
                            : undefined,
                    raw: j,
                };
                result.metaShape = {
                    kind: "json",
                    note: `backend=${result.metaJson.backend ?? "?"} codec=${result.metaJson.tablesCodecVersion ?? "?"}`,
                };
                log(
                    `meta JSON: backend=${result.metaJson.backend} ` +
                        `checksum=${result.metaJson.checksum} ` +
                        `tablesCodecVersion=${result.metaJson.tablesCodecVersion}`,
                );
            } else {
                const bytes = new Uint8Array(
                    await Bun.file(metaPath).arrayBuffer(),
                );
                const parsed = Cbor.parse(bytes);
                result.metaShape = describeCborShape(parsed);
                log(`meta Cbor: kind=${result.metaShape.kind}`);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.metaShape = {
                kind: "parse_error",
                note: `${msg} (formatGuess=${files.meta.formatGuess})`,
            };
            log(`meta probe failed: ${msg}`);
        }
    }

    if (files.tables.exists) {
        log(
            `tables present (${files.tables.size} bytes, sniff=${files.tables.formatGuess}, ` +
                `kind=${tablesRes.kind}) — NOT fully parsed (OOM + codec). ` +
                BLOCKED_REASON,
        );
    }

    console.warn("ANCILLARY UTxO EXTRACT BLOCKED: " + BLOCKED_REASON);

    return result;
}

// ---------------------------------------------------------------------------
// A2 scaffold — streaming tables *head* only. Never full unwrap. Never UTxO insert.
// ---------------------------------------------------------------------------

export type TablesHeadScanResult = {
    path: string;
    pathKind: "tables" | "tables/tvar" | "missing";
    exists: boolean;
    size: number;
    /** Bytes actually read (capped). */
    bytesRead: number;
    headHex: string;
    formatGuess: string;
    /**
     * Best-effort top-level CBOR major from first byte only.
     * Not a full parse — OOM-safe.
     */
    cborMajorHint: string | null;
    /**
     * Sample of map entries walked from a bounded head buffer.
     * null if structure not recognized. Never loads full file.
     */
    sample?: {
        /** Bytes of head buffer scanned. */
        scannedBytes: number;
        /** Map pairs successfully walked within the buffer. */
        entryCount: number;
        /** Mean bytes/entry in sample (heuristic). */
        bytesPerEntryApprox: number | null;
        /** Rough full-file entry estimate from sample density. */
        estimatedTotalEntries: number | null;
        /** First few key lengths / value lengths (diagnostics). */
        firstKeys: Array<{ keyLen: number; valueLen: number; keyHeadHex: string }>;
    };
    /** Always false until utxohd-mem codec adapter exists. */
    utxoExtracted: false;
    blockedReason: string;
};

/** @deprecated use TablesHeadScanResult */
export type TvarHeadScanResult = TablesHeadScanResult;

/** Minimal CBOR item header reader for streaming map walk (no full decode). */
function readCborHeader(
    buf: Buffer,
    off: number,
): {
    major: number;
    ai: number;
    len: number | null;
    next: number;
    err?: string;
} {
    if (off >= buf.length) return { major: -1, ai: 0, len: null, next: off, err: "eof" };
    const b = buf[off]!;
    const major = b >> 5;
    const ai = b & 0x1f;
    let pos = off + 1;
    let len: number | null = null;
    if (ai < 24) len = ai;
    else if (ai === 24) {
        if (pos >= buf.length) return { major, ai, len: null, next: pos, err: "eof" };
        len = buf[pos]!;
        pos += 1;
    } else if (ai === 25) {
        if (pos + 2 > buf.length) return { major, ai, len: null, next: pos, err: "eof" };
        len = buf.readUInt16BE(pos);
        pos += 2;
    } else if (ai === 26) {
        if (pos + 4 > buf.length) return { major, ai, len: null, next: pos, err: "eof" };
        len = buf.readUInt32BE(pos);
        pos += 4;
    } else if (ai === 27) {
        if (pos + 8 > buf.length) return { major, ai, len: null, next: pos, err: "eof" };
        const hi = buf.readUInt32BE(pos);
        const lo = buf.readUInt32BE(pos + 4);
        len = hi * 2 ** 32 + lo;
        pos += 8;
    } else if (ai === 31) {
        len = -1; // indefinite
    } else {
        return { major, ai, len: null, next: pos, err: `ai ${ai}` };
    }
    return { major, ai, len, next: pos };
}

/**
 * Walk a bounded head of the tables CBOR map and count complete key/value pairs.
 * Layout expected (preprod e305): array(1) → map_indef → (bstr key, bstr|tag+bstr value)* break
 * Never loads the full ~940MB file. Never decodes TxOut.
 */
export function sampleTablesMapFromHead(
    head: Uint8Array,
    fileSize: number,
): TablesHeadScanResult["sample"] {
    const buf = Buffer.from(head);
    if (buf.length < 2) return undefined;

    let off = 0;
    const top = readCborHeader(buf, off);
    if (top.err) return undefined;

    // Preprod e305: array(1) wrapping an indefinite map.
    // Also accept a bare map at the root.
    if (top.major === 4) {
        off = top.next;
        const mapHdr = readCborHeader(buf, off);
        if (mapHdr.err || mapHdr.major !== 5) return undefined;
        off = mapHdr.next;
    } else if (top.major === 5) {
        off = top.next;
    } else {
        return undefined;
    }

    const firstKeys: Array<{
        keyLen: number;
        valueLen: number;
        keyHeadHex: string;
    }> = [];
    let entryCount = 0;
    let lastOff = off;

    while (off < buf.length - 1) {
        const k = readCborHeader(buf, off);
        if (k.err) break;
        // break stop code for indefinite map
        if (k.major === 7 && k.ai === 31) {
            lastOff = k.next;
            break;
        }
        if (k.major !== 2 || k.len == null || k.len < 0) break; // expect definite bstr key
        const keyStart = k.next;
        const keyEnd = keyStart + k.len;
        if (keyEnd > buf.length) break; // incomplete in buffer
        const keyHeadHex = buf.subarray(keyStart, Math.min(keyStart + 8, keyEnd)).toString("hex");
        off = keyEnd;

        let v = readCborHeader(buf, off);
        if (v.err) break;
        // optional tag wrapping the value
        if (v.major === 6) {
            off = v.next;
            v = readCborHeader(buf, off);
            if (v.err) break;
        }
        if (v.major !== 2 || v.len == null || v.len < 0) break; // expect definite bstr value
        const valEnd = v.next + v.len;
        if (valEnd > buf.length) break; // incomplete
        off = valEnd;
        lastOff = off;
        entryCount++;
        if (firstKeys.length < 5) {
            firstKeys.push({
                keyLen: k.len,
                valueLen: v.len,
                keyHeadHex,
            });
        }
    }

    if (entryCount === 0) return undefined;
    const scannedBytes = lastOff;
    const bytesPerEntryApprox = Math.round(scannedBytes / entryCount);
    const estimatedTotalEntries =
        bytesPerEntryApprox > 0
            ? Math.round(fileSize / bytesPerEntryApprox)
            : null;

    return {
        scannedBytes,
        entryCount,
        bytesPerEntryApprox,
        estimatedTotalEntries,
        firstKeys,
    };
}

/**
 * Read a bounded head of the UTxO `tables` file for format diagnostics.
 * Never loads the full ~940MB file. Never extracts UTxO.
 *
 * Accepts either the tables file path or a legacy tables/tvar path.
 */
export async function streamTablesHead(
    tablesPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TablesHeadScanResult> {
    const maxBytes = opts.maxBytes ?? 256 * 1024; // 256 KiB sample default
    const sniff = await sniffFileHead(tablesPath, maxBytes);
    let cborMajorHint: string | null = null;
    if (sniff.exists && sniff.head.length > 0) {
        const major = sniff.head[0]! >> 5;
        const names = [
            "uint",
            "nint",
            "bstr",
            "tstr",
            "array",
            "map",
            "tag",
            "simple/float",
        ];
        cborMajorHint = names[major] ?? `major_${major}`;
        if ((sniff.head[0]! & 0x1f) === 31) {
            cborMajorHint += "_indef";
        }
        // common wrapper: array then indef map — peek second byte
        if (major === 4 && sniff.head.length > 1) {
            const m2 = sniff.head[1]! >> 5;
            const ai2 = sniff.head[1]! & 0x1f;
            if (m2 === 5) {
                cborMajorHint += ai2 === 31 ? "+map_indef" : "+map";
            }
        }
    }

    const sample =
        sniff.exists && sniff.head.length > 0
            ? sampleTablesMapFromHead(sniff.head, sniff.size)
            : undefined;

    // Infer path kind from path string
    let pathKind: TablesHeadScanResult["pathKind"] = "missing";
    if (sniff.exists) {
        pathKind = tablesPath.endsWith(`${join("tables", "tvar")}`) ||
            tablesPath.endsWith("tables/tvar")
            ? "tables/tvar"
            : "tables";
    }

    return {
        path: tablesPath,
        pathKind: sniff.exists ? pathKind : "missing",
        exists: sniff.exists,
        size: sniff.size,
        bytesRead: sniff.head.length,
        headHex: Buffer.from(sniff.head).toString("hex"),
        formatGuess: sniff.exists ? guessFormatFromHead(sniff.head) : "missing",
        cborMajorHint,
        sample,
        utxoExtracted: false,
        blockedReason: BLOCKED_REASON,
    };
}

/** @deprecated use streamTablesHead */
export async function streamTvarHead(
    tvarPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TablesHeadScanResult> {
    return streamTablesHead(tvarPath, opts);
}

/**
 * Locate latest slot dir under ledger path and scan `tables` head only.
 * Still utxoExtracted=false — codec not implemented.
 */
export async function scanAncillaryTablesHead(
    ledgerPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TablesHeadScanResult & { latestSlotDir: string | null }> {
    let dirs: string[] = [];
    try {
        dirs = await readdir(ledgerPath);
    } catch {
        return {
            path: join(ledgerPath, "tables"),
            pathKind: "missing",
            exists: false,
            size: 0,
            bytesRead: 0,
            headHex: "",
            formatGuess: "missing",
            cborMajorHint: null,
            utxoExtracted: false,
            blockedReason: BLOCKED_REASON + " (ledger path unreadable)",
            latestSlotDir: null,
        };
    }
    const slotDirs = dirs
        .map((d) => parseInt(d, 10))
        .filter((n) => Number.isFinite(n) && n >= 0);
    const latestSlot = slotDirs.length > 0 ? Math.max(...slotDirs) : null;
    const latestLedgerDirPath =
        latestSlot != null ? join(ledgerPath, String(latestSlot)) : null;
    if (!latestLedgerDirPath) {
        return {
            path: join(ledgerPath, "tables"),
            pathKind: "missing",
            exists: false,
            size: 0,
            bytesRead: 0,
            headHex: "",
            formatGuess: "missing",
            cborMajorHint: null,
            utxoExtracted: false,
            blockedReason: BLOCKED_REASON + " (no slot dir)",
            latestSlotDir: null,
        };
    }
    const resolved = await resolveTablesPath(latestLedgerDirPath);
    const scan = await streamTablesHead(resolved.path, opts);
    return {
        ...scan,
        pathKind: resolved.kind === "missing" ? scan.pathKind : resolved.kind,
        latestSlotDir: latestLedgerDirPath,
    };
}

/** @deprecated use scanAncillaryTablesHead */
export async function scanAncillaryTvarHead(
    ledgerPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TablesHeadScanResult & { latestSlotDir: string | null }> {
    return scanAncillaryTablesHead(ledgerPath, opts);
}

/**
 * CLI entry: probe only. Never inserts UTxO.
 * Kept name for backward compatibility with `load-ancillary` command.
 */
export async function loadLedgerStateFromAncilliary(ledgerPath: string) {
    const probe = await probeAncillaryLedger(ledgerPath);
    let tablesHead: TablesHeadScanResult | null = null;
    if (probe.latestSlotDir) {
        const resolved = await resolveTablesPath(probe.latestSlotDir);
        tablesHead = await streamTablesHead(resolved.path, {
            maxBytes: 256 * 1024,
        });
    }
    console.log(
        JSON.stringify(
            {
                utxoExtracted: probe.utxoExtracted,
                latestSlotDir: probe.latestSlotDir,
                files: probe.files,
                stateShape: probe.stateShape,
                metaShape: probe.metaShape,
                metaJson: probe.metaJson,
                tablesHead,
                // legacy alias
                tvarHead: tablesHead,
                blockedReason: probe.blockedReason,
            },
            null,
            2,
        ),
    );
    return probe;
}
