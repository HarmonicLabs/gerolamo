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
import { iterateLmdb, type LmdbEntry } from "./lmdb-ffi.ts";

const args = process.argv.slice(2);
const DB_DIR = args[0]
    ? args[0]
    : new URL("../db/tmp/snapshots/118971022_lmdb/tables/", import.meta.url).pathname;
const PORT = parseInt(args[1] || "3040", 10);

function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString("hex");
}

// Cached info (computed once on first /info request)
let cachedInfo: { databases: string[]; totalEntries: number } | null = null;

function getSnapshotInfo(): { databases: string[]; totalEntries: number } {
    let total = 0;
    const dbs = new Set<string>();
    try {
        iterateLmdb(DB_DIR, (entry) => {
            dbs.add(entry.dbName);
            total++;
        }, {
            onProgress: () => {},
        });
    } catch (e: any) {
        console.error("LMDB scan error:", e.message);
    }
    return { databases: [...dbs], totalEntries: total };
}

function formatUtxoEntry(key: Uint8Array, value: Uint8Array): string {
    const txHash = toHex(key.subarray(0, 32));
    const outputIndex = key[32] | (key[33] << 8); // little-endian
    const valueCbor = toHex(value);
    return JSON.stringify({ txHash, outputIndex, valueCbor });
}

function formatGenericEntry(dbName: string, key: Uint8Array, value: Uint8Array): string {
    return JSON.stringify({
        db: dbName,
        key: toHex(key),
        value: toHex(value),
    });
}

type StreamFilter = "utxo" | "all";

function createLmdbStream(
    filter: StreamFilter,
    from: number = 0,
    limit: number = Infinity,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cancelled = false;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            queueMicrotask(() => {
                let utxoIndex = 0;
                let streamed = 0;

                try {
                    iterateLmdb(DB_DIR, (entry) => {
                        if (cancelled) throw new Error("CANCELLED");
                        if (streamed >= limit) throw new Error("LIMIT");

                        if (filter === "utxo") {
                            // Only stream UTxO entries (34-byte keys)
                            if (entry.dbName !== "utxo" || entry.key.length !== 34) return;

                            if (utxoIndex < from) {
                                utxoIndex++;
                                return;
                            }
                            utxoIndex++;

                            const line = formatUtxoEntry(entry.key, entry.value) + "\n";
                            controller.enqueue(encoder.encode(line));
                            streamed++;
                        } else {
                            // Stream everything
                            if (entry.key.length === 34 && entry.dbName === "utxo") {
                                const line = formatUtxoEntry(entry.key, entry.value) + "\n";
                                controller.enqueue(encoder.encode(line));
                            } else {
                                const line = formatGenericEntry(entry.dbName, entry.key, entry.value) + "\n";
                                controller.enqueue(encoder.encode(line));
                            }
                            streamed++;
                        }
                    }, {
                        onProgress: (db, count) => {
                            const progress = JSON.stringify({ _progress: true, db, count }) + "\n";
                            controller.enqueue(encoder.encode(progress));
                        },
                    });
                } catch (e: any) {
                    if (e.message !== "CANCELLED" && e.message !== "LIMIT") {
                        const errLine = JSON.stringify({ _error: e.message }) + "\n";
                        controller.enqueue(encoder.encode(errLine));
                    }
                }

                const done = JSON.stringify({ _done: true, totalStreamed: streamed }) + "\n";
                controller.enqueue(encoder.encode(done));
                controller.close();
            });
        },
        cancel() {
            cancelled = true;
        },
    });
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

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
                cachedInfo = getSnapshotInfo();
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

            const stream = createLmdbStream(filter, from, limit);
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
