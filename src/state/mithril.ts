/**
 * Ancillary ledger loader / probe (Mithril Cardano DB snapshot).
 *
 * Phase 3 status (honest):
 * - Download path: optional via mithril-bootstrap --include-ancillary
 * - Probe path: metadata + hex sniff + safe LazyCbor top of `state` / `meta`
 * - UTxO extract: still **blocked** — full `tables/tvar` (~800MB–1GB) OOMs;
 *   nested indefinite maps + deferred blobs are not a simple Object.keys walk
 *
 * Density path remains: immutable chunks via processChunk / read-raw-chunks.
 * Do not claim ancillary UTxO hydrate until a streaming UTxO adapter lands.
 */

import { join } from "node:path";
import { readdir, open } from "node:fs/promises";

import { Cbor, LazyCborArray, LazyCborMap } from "@harmoniclabs/cbor";

export type FileSniff = {
    size: number;
    exists: boolean;
    /** First N bytes as lowercase hex (empty if missing). */
    headHex: string;
    /** Best-effort format guess from magic / CBOR major type. */
    formatGuess: string;
};

export type LazyShape = {
    kind: string;
    indefinite?: boolean;
    length?: number;
    note?: string;
};

export type AncillaryProbeResult = {
    ledgerPath: string;
    latestSlotDir: string | null;
    files: {
        state: FileSniff;
        meta: FileSniff;
        tvar: FileSniff;
    };
    /** Top-level LazyCbor shape of `state` (never full unwrap of tvar). */
    stateShape?: LazyShape;
    metaShape?: LazyShape;
    /** Always false until streaming UTxO adapter exists. */
    utxoExtracted: false;
    blockedReason: string;
};

const BLOCKED_REASON =
    "A2: indefinite CBOR / large tables/tvar — use immutable chunk replay " +
    "(read-raw-chunks / processChunk) for density. No fake UTxO inserts.";

const EMPTY_SNIFF: FileSniff = {
    exists: false,
    size: 0,
    headHex: "",
    formatGuess: "missing",
};

function describeLazy(obj: unknown): LazyShape {
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
    const name =
        typeof obj === "object" && obj !== null && "constructor" in obj
            ? (obj as { constructor?: { name?: string } }).constructor?.name
            : typeof obj;
    return { kind: name || typeof obj };
}

/** Guess file format from first bytes — no full parse. */
export function guessFormatFromHead(head: Uint8Array): string {
    if (head.length === 0) return "empty";
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
    if (head.length >= 2 && head[0] === 0x78 && [0x01, 0x9c, 0xda].includes(head[1]!)) {
        return "zlib";
    }
    // sqlite magic "SQLi" (full header is 16 bytes; 4-byte prefix is enough to distinguish)
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
    // Indefinite length marker: additional info = 31 (0x1f in low 5 bits)
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
 * Probe ancillary ledger dir without loading full tvar into UTxO tables.
 * Safe: hex sniff always; LazyCbor-parse small `state`/`meta` only under size cap.
 */
export async function probeAncillaryLedger(
    ledgerPath: string,
    opts: { maxParseBytes?: number; sniffBytes?: number; log?: (msg: string) => void } = {},
): Promise<AncillaryProbeResult> {
    const log = opts.log ?? console.log;
    const maxParse = opts.maxParseBytes ?? 64 * 1024 * 1024; // 64 MiB soft cap for state/meta only
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
    const latestSlot =
        slotDirs.length > 0 ? Math.max(...slotDirs) : null;
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
                tvar: { ...EMPTY_SNIFF },
            },
            utxoExtracted: false,
            blockedReason: BLOCKED_REASON + " (no slot dir)",
        };
    }

    log(`Using ledger snapshot dir: ${latestLedgerDirPath}`);

    const statePath = join(latestLedgerDirPath, "state");
    const metaPath = join(latestLedgerDirPath, "meta");
    const tvarPath = join(latestLedgerDirPath, "tables", "tvar");

    const [stateSniff, metaSniff, tvarSniff] = await Promise.all([
        sniffFileHead(statePath, sniffN),
        sniffFileHead(metaPath, sniffN),
        sniffFileHead(tvarPath, sniffN),
    ]);

    const files = {
        state: toSniff(stateSniff),
        meta: toSniff(metaSniff),
        tvar: toSniff(tvarSniff),
    };

    log(
        `Ancillary files: state=${files.state.exists}(${files.state.size},${files.state.formatGuess}) ` +
            `meta=${files.meta.exists}(${files.meta.size},${files.meta.formatGuess}) ` +
            `tvar=${files.tvar.exists}(${files.tvar.size},${files.tvar.formatGuess})`,
    );
    if (files.state.headHex) log(`  state head: ${files.state.headHex.slice(0, 32)}…`);
    if (files.meta.headHex) log(`  meta head: ${files.meta.headHex}`);
    if (files.tvar.headHex) log(`  tvar head: ${files.tvar.headHex.slice(0, 32)}…`);

    const result: AncillaryProbeResult = {
        ledgerPath,
        latestSlotDir: latestLedgerDirPath,
        files,
        utxoExtracted: false,
        blockedReason: BLOCKED_REASON,
    };

    // Safe LazyCbor probe of state/meta only — never full tvar
    if (files.state.exists && files.state.size > 0 && files.state.size <= maxParse) {
        try {
            const bytes = new Uint8Array(await Bun.file(statePath).arrayBuffer());
            const parsed = Cbor.parseLazy(bytes);
            result.stateShape = describeLazy(parsed);
            log(
                `state LazyCbor: kind=${result.stateShape.kind} ` +
                    `len=${result.stateShape.length ?? "?"} ` +
                    `indef=${result.stateShape.indefinite ?? "?"}`,
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.stateShape = {
                kind: "parse_error",
                note: `${msg} (formatGuess=${files.state.formatGuess})`,
            };
            log(`state LazyCbor probe failed: ${msg}`);
        }
    } else if (files.state.exists && files.state.size > maxParse) {
        result.stateShape = {
            kind: "skipped",
            note: `size ${files.state.size} > maxParseBytes ${maxParse}; sniff=${files.state.formatGuess}`,
        };
        log(result.stateShape.note!);
    }

    if (files.meta.exists && files.meta.size > 0 && files.meta.size <= maxParse) {
        try {
            const bytes = new Uint8Array(await Bun.file(metaPath).arrayBuffer());
            const parsed = Cbor.parseLazy(bytes);
            result.metaShape = describeLazy(parsed);
            log(
                `meta LazyCbor: kind=${result.metaShape.kind} ` +
                    `len=${result.metaShape.length ?? "?"}`,
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.metaShape = {
                kind: "parse_error",
                note: `${msg} (formatGuess=${files.meta.formatGuess})`,
            };
            log(`meta LazyCbor probe failed: ${msg}`);
        }
    }

    if (files.tvar.exists) {
        log(
            `tvar present (${files.tvar.size} bytes, sniff=${files.tvar.formatGuess}) — NOT parsed (OOM risk). ` +
                BLOCKED_REASON,
        );
    }

    console.warn("ANCILLARY UTxO EXTRACT BLOCKED: " + BLOCKED_REASON);

    return result;
}

// ---------------------------------------------------------------------------
// A2 scaffold — streaming tvar *head* only. Never full unwrap. Never UTxO insert.
// ---------------------------------------------------------------------------

export type TvarHeadScanResult = {
    path: string;
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
    /** Always false until streaming UTxO adapter exists. */
    utxoExtracted: false;
    blockedReason: string;
};

/**
 * Read a bounded head of `tables/tvar` for format diagnostics.
 * Never loads the full ~800MB–1GB file. Never extracts UTxO.
 */
export async function streamTvarHead(
    tvarPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TvarHeadScanResult> {
    const maxBytes = opts.maxBytes ?? 64;
    const sniff = await sniffFileHead(tvarPath, maxBytes);
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
    }
    return {
        path: tvarPath,
        exists: sniff.exists,
        size: sniff.size,
        bytesRead: sniff.head.length,
        headHex: Buffer.from(sniff.head).toString("hex"),
        formatGuess: sniff.exists
            ? guessFormatFromHead(sniff.head)
            : "missing",
        cborMajorHint,
        utxoExtracted: false,
        blockedReason: BLOCKED_REASON,
    };
}

/**
 * Locate latest slot dir under ledger path and scan `tables/tvar` head only.
 * Convenience wrapper for A2 diagnostics — still utxoExtracted=false.
 */
export async function scanAncillaryTvarHead(
    ledgerPath: string,
    opts: { maxBytes?: number } = {},
): Promise<TvarHeadScanResult & { latestSlotDir: string | null }> {
    let dirs: string[] = [];
    try {
        dirs = await readdir(ledgerPath);
    } catch {
        return {
            path: join(ledgerPath, "tables", "tvar"),
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
            path: join(ledgerPath, "tables", "tvar"),
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
    const tvarPath = join(latestLedgerDirPath, "tables", "tvar");
    const scan = await streamTvarHead(tvarPath, opts);
    return { ...scan, latestSlotDir: latestLedgerDirPath };
}

/**
 * CLI entry: probe only. Never inserts UTxO.
 * Kept name for backward compatibility with `load-ancillary` command.
 */
export async function loadLedgerStateFromAncilliary(ledgerPath: string) {
    const probe = await probeAncillaryLedger(ledgerPath);
    let tvarHead: TvarHeadScanResult | null = null;
    if (probe.latestSlotDir) {
        tvarHead = await streamTvarHead(
            join(probe.latestSlotDir, "tables", "tvar"),
        );
    }
    console.log(
        JSON.stringify(
            {
                utxoExtracted: probe.utxoExtracted,
                latestSlotDir: probe.latestSlotDir,
                files: probe.files,
                stateShape: probe.stateShape,
                metaShape: probe.metaShape,
                tvarHead,
                blockedReason: probe.blockedReason,
            },
            null,
            2,
        ),
    );
    return probe;
}
