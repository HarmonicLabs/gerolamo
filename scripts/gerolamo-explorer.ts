#!/usr/bin/env bun
/**
 * gerolamo-explorer — CLI that launches the Mithril stream server
 * and serves the Bootstrap Explorer frontend on a single port.
 *
 * Usage:
 *   gerolamo-explorer [options]
 *
 * Options:
 *   --port <n>       Server port (default: 3040)
 *   --lmdb <path>    LMDB directory (default: db/tmp/snapshots/118971022_lmdb/tables/)
 *   --no-open        Don't auto-open browser
 *   --help           Show help
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import {
    createLmdbStream,
    getSnapshotInfo,
    CORS_HEADERS,
    type StreamFilter,
} from "./lmdb-stream.ts";

// ── CLI Args ──

const args = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { flags.help = true; continue; }
    if (args[i] === "--no-open") { flags.noOpen = true; continue; }
    if (args[i] === "--port" && args[i + 1]) { flags.port = args[++i]; continue; }
    if (args[i] === "--lmdb" && args[i + 1]) { flags.lmdb = args[++i]; continue; }
}

if (flags.help) {
    console.log(`
gerolamo-explorer — Mithril Bootstrap Explorer

Launches the LMDB stream server and serves the browser UI on a single port.

Usage:
  gerolamo-explorer [options]

Options:
  --port <n>       Server port (default: 3040)
  --lmdb <path>    LMDB snapshot directory
                   (default: db/tmp/snapshots/118971022_lmdb/tables/)
  --no-open        Don't auto-open browser
  -h, --help       Show this help

Endpoints:
  /                Browser UI (Bootstrap Explorer)
  /api/info        Snapshot metadata (JSON)
  /api/stream/utxo Stream UTxO entries as NDJSON (?from=N&limit=M)
  /api/stream/all  Stream all LMDB entries as NDJSON
`);
    process.exit(0);
}

const PORT = parseInt(flags.port as string) || 3040;
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DB_DIR = flags.lmdb
    ? resolve(flags.lmdb as string)
    : resolve(PROJECT_ROOT, "db/tmp/snapshots/118971022_lmdb/tables/");

// ── Validate LMDB ──

if (!existsSync(DB_DIR)) {
    console.error(`\x1b[31mError:\x1b[0m LMDB directory not found: ${DB_DIR}`);
    console.error(`\nDownload a Mithril snapshot first, or specify --lmdb <path>`);
    process.exit(1);
}

const dataMdb = resolve(DB_DIR, "data.mdb");
if (!existsSync(dataMdb)) {
    console.error(`\x1b[31mError:\x1b[0m No data.mdb found in ${DB_DIR}`);
    process.exit(1);
}

// ── Load HTML ──

const HTML_PATH = resolve(SCRIPT_DIR, "bootstrap-explorer.html");
let explorerHtml: string;
try {
    explorerHtml = readFileSync(HTML_PATH, "utf-8");
} catch {
    console.error(`\x1b[31mError:\x1b[0m bootstrap-explorer.html not found at ${HTML_PATH}`);
    process.exit(1);
}

// Patch the default server URL in the HTML to point to /api
explorerHtml = explorerHtml.replace(
    'value="http://localhost:3040"',
    `value=""`
);
explorerHtml = explorerHtml.replace(
    'value="/stream/utxo"',
    'value="/api/stream/utxo"'
);
explorerHtml = explorerHtml.replace(
    'value="/stream/all"',
    'value="/api/stream/all"'
);
explorerHtml = explorerHtml.replace(
    `$('serverUrl').value + '/info'`,
    `'/api/info'`
);

// ── Cached snapshot info ──

let cachedInfo: { databases: string[]; totalEntries: number } | null = null;

// ── Server ──

Bun.serve({
    port: PORT,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;

        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // ── Frontend ──

        if (path === "/" || path === "/index.html") {
            return new Response(explorerHtml, {
                headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
            });
        }

        // ── API: /api/info ──

        if (path === "/api/info") {
            if (!cachedInfo) {
                cachedInfo = getSnapshotInfo(DB_DIR);
            }
            return Response.json({ dbDir: DB_DIR, ...cachedInfo }, { headers: CORS_HEADERS });
        }

        // ── API: /api/stream/utxo | /api/stream/all ──

        if (path === "/api/stream/utxo" || path === "/api/stream/all") {
            const filter: StreamFilter = path === "/api/stream/utxo" ? "utxo" : "all";
            const from = parseInt(url.searchParams.get("from") || "0", 10);
            const limit = parseInt(url.searchParams.get("limit") || "0", 10) || Infinity;
            console.log(`  Stream ${filter} from=${from} limit=${limit === Infinity ? "all" : limit}`);

            return new Response(createLmdbStream(DB_DIR, filter, from, limit), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
            });
        }

        return new Response("Not found", { status: 404 });
    },
});

// ── Banner ──

const cyan = "\x1b[36m";
const red = "\x1b[31m";
const dim = "\x1b[2m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

console.log(`
${red}${bold}Gerolamo${reset} ${cyan}Bootstrap Explorer${reset}
${dim}─────────────────────────────────${reset}
  ${bold}UI${reset}      http://localhost:${PORT}/
  ${bold}API${reset}     http://localhost:${PORT}/api/info
  ${bold}Stream${reset}  http://localhost:${PORT}/api/stream/utxo
  ${bold}LMDB${reset}    ${dim}${DB_DIR}${reset}
${dim}─────────────────────────────────${reset}
`);

// ── Auto-open browser ──

if (!flags.noOpen) {
    try {
        // WSL
        if (existsSync("/proc/version")) {
            const proc = readFileSync("/proc/version", "utf-8");
            if (proc.toLowerCase().includes("microsoft")) {
                execSync(`explorer.exe "http://localhost:${PORT}/"`, { stdio: "ignore" });
            } else {
                execSync(`xdg-open "http://localhost:${PORT}/" 2>/dev/null || open "http://localhost:${PORT}/" 2>/dev/null`, { stdio: "ignore" });
            }
        }
    } catch {
        // silent — browser open is best-effort
    }
}
