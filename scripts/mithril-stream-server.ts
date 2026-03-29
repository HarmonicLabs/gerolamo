/**
 * mithril-stream-server.ts — HTTP server that streams Mithril LMDB snapshot data
 * to browser clients for node bootstrapping.
 *
 * Reads the LMDB snapshot via Bun FFI (lmdb-ffi.ts) and streams entries as
 * NDJSON over HTTP. The browser client can consume this stream to populate
 * IndexedDB and bootstrap a browser-based Cardano node.
 *
 * Endpoints:
 *   GET /info             — Snapshot metadata (db names, entry counts)
 *   GET /stream/utxo      — Stream all UTxO entries as NDJSON
 *   GET /stream/all       — Stream all entries (utxo + _dbstate) as NDJSON
 *   GET /stream/utxo?from=N&limit=M — Paginated UTxO streaming
 *
 * Each NDJSON line (UTxO):
 *   { "txHash": "ab12...", "outputIndex": 0, "valueCbor": "82a3..." }
 *
 * Usage:
 *   bun run scripts/mithril-stream-server.ts [lmdb-dir] [port]
 *   Default: db/tmp/snapshots/118971022_lmdb/tables/ on port 3040
 */
import {
    createLmdbStream,
    getSnapshotInfo,
    CORS_HEADERS,
    type StreamFilter,
} from "./lmdb-stream.ts";

const args = process.argv.slice(2);
const DB_DIR = args[0]
    ? args[0]
    : new URL("../db/tmp/snapshots/118971022_lmdb/tables/", import.meta.url).pathname;
const PORT = parseInt(args[1] || "3040", 10);

// Cached info (computed once on first /info request)
let cachedInfo: { databases: string[]; totalEntries: number } | null = null;

Bun.serve({
    port: PORT,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // GET /info — snapshot metadata
        if (url.pathname === "/info") {
            if (!cachedInfo) {
                console.log("Scanning LMDB for snapshot info...");
                cachedInfo = getSnapshotInfo(DB_DIR);
                console.log(`Scan complete: ${cachedInfo.totalEntries} entries across [${cachedInfo.databases.join(", ")}]`);
            }
            return Response.json({
                dbDir: DB_DIR,
                databases: cachedInfo.databases,
                totalEntries: cachedInfo.totalEntries,
            }, { headers: CORS_HEADERS });
        }

        // GET /stream/utxo or /stream/all
        if (url.pathname === "/stream/utxo" || url.pathname === "/stream/all") {
            const filter: StreamFilter = url.pathname === "/stream/utxo" ? "utxo" : "all";
            const from = parseInt(url.searchParams.get("from") || "0", 10);
            const limit = parseInt(url.searchParams.get("limit") || "0", 10) || Infinity;
            console.log(`Streaming ${filter} from=${from} limit=${limit === Infinity ? "all" : limit}`);

            const stream = createLmdbStream(DB_DIR, filter, from, limit);
            return new Response(stream, {
                headers: {
                    ...CORS_HEADERS,
                    "Content-Type": "application/x-ndjson",
                    "Cache-Control": "no-cache",
                },
            });
        }

        // Root — usage info
        return Response.json({
            name: "Gerolamo Mithril Bootstrap Stream Server",
            endpoints: {
                "/info": "GET — Snapshot metadata (db names, entry counts)",
                "/stream/utxo": "GET — Stream UTxO entries as NDJSON (params: from, limit)",
                "/stream/all": "GET — Stream all entries as NDJSON",
            },
            utxoFormat: {
                txHash: "32-byte hex tx hash",
                outputIndex: "little-endian output index",
                valueCbor: "raw value hex (Cardano compact encoding)",
            },
            controlMessages: {
                _progress: "{ _progress: true, db, count } — emitted every 100k entries",
                _done: "{ _done: true, totalStreamed } — final message",
                _error: "{ _error: message } — on error",
            },
        }, { headers: CORS_HEADERS });
    },
});

console.log(`Mithril Bootstrap Stream Server on http://localhost:${PORT}`);
console.log(`LMDB: ${DB_DIR}`);
console.log(`Endpoints: /info, /stream/utxo, /stream/all`);
