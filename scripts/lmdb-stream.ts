/**
 * lmdb-stream.ts — Shared LMDB streaming utilities
 *
 * Provides NDJSON streaming primitives used by both mithril-stream-server.ts
 * and gerolamo-explorer.ts. Reads LMDB data via lmdb-ffi.ts and exposes it
 * as Web ReadableStreams.
 */
import { iterateLmdb } from "./lmdb-ffi.ts";

// ── Formatting helpers ──

export function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString("hex");
}

export function formatUtxoEntry(key: Uint8Array, value: Uint8Array): string {
    const txHash = toHex(key.subarray(0, 32));
    const outputIndex = key[32] | (key[33] << 8); // little-endian
    const valueCbor = toHex(value);
    return JSON.stringify({ txHash, outputIndex, valueCbor });
}

export function formatGenericEntry(dbName: string, key: Uint8Array, value: Uint8Array): string {
    return JSON.stringify({
        db: dbName,
        key: toHex(key),
        value: toHex(value),
    });
}

// ── Stream types and factory ──

export type StreamFilter = "utxo" | "all";

export function createLmdbStream(
    dbDir: string,
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
                    iterateLmdb(dbDir, (entry) => {
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

// ── Snapshot info ──

export function getSnapshotInfo(dbDir: string): { databases: string[]; totalEntries: number } {
    let total = 0;
    const dbs = new Set<string>();
    try {
        iterateLmdb(dbDir, (entry) => {
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

// ── CORS headers ──

export const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
} as const;
