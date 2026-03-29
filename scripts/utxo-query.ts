/**
 * utxo-query.ts — Browser-side UTxO query engine over IndexedDB
 *
 * Provides search, lookup, pagination, and analytics over the UTxO set
 * stored by BootstrapClient. Browser-only: uses IndexedDB cursors.
 */

import type { StoredUtxo } from "./bootstrap-client.ts";

// ── Types ──

export interface UtxoQueryResult {
    entries: StoredUtxo[];
    total: number;
    hasMore: boolean;
    nextCursor?: string;
}

export interface SizeBucket {
    label: string;
    min: number;
    max: number;
    count: number;
    percentage: number;
}

export interface TopTxHash {
    txHash: string;
    outputCount: number;
}

export interface UtxoStats {
    totalEntries: number;
    totalSizeBytes: number;
    avgSizeBytes: number;
    minSizeBytes: number;
    maxSizeBytes: number;
    sizeDistribution: SizeBucket[];
    topTxHashes: TopTxHash[];
}

export interface StatsProgress {
    scanned: number;
    total: number;
    phase: string;
}

// ── Constants ──

const UTXO_STORE = "utxo";

const SIZE_BUCKETS: { label: string; min: number; max: number }[] = [
    { label: "0-50B", min: 0, max: 50 },
    { label: "50-100B", min: 50, max: 100 },
    { label: "100-200B", min: 100, max: 200 },
    { label: "200-500B", min: 200, max: 500 },
    { label: "500B-1KB", min: 500, max: 1024 },
    { label: "1-5KB", min: 1024, max: 5120 },
    { label: "5KB+", min: 5120, max: Infinity },
];

// ── Query Engine ──

export class UtxoQueryEngine {
    constructor(private db: IDBDatabase) {}

    /** Lookup all outputs for a given transaction hash */
    getByTxHash(txHash: string): Promise<StoredUtxo[]> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const index = tx.objectStore(UTXO_STORE).index("txHash");
            const req = index.getAll(txHash);
            req.onsuccess = () => resolve(req.result as StoredUtxo[]);
            req.onerror = () => reject(req.error);
        });
    }

    /** Lookup a specific UTxO by txHash and output index */
    getByRef(txHash: string, outputIndex: number): Promise<StoredUtxo | null> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const req = tx.objectStore(UTXO_STORE).get(`${txHash}:${outputIndex}`);
            req.onsuccess = () => resolve((req.result as StoredUtxo) ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    /** Paginated cursor iteration */
    list(options?: {
        pageSize?: number;
        cursor?: string;
        direction?: IDBCursorDirection;
    }): Promise<UtxoQueryResult> {
        const pageSize = options?.pageSize ?? 50;
        const startKey = options?.cursor;
        const direction = options?.direction ?? "next";

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const store = tx.objectStore(UTXO_STORE);

            // Get total count
            const countReq = store.count();
            let total = 0;
            countReq.onsuccess = () => { total = countReq.result; };

            const range = startKey ? IDBKeyRange.lowerBound(startKey, true) : undefined;
            const cursorReq = store.openCursor(range, direction);
            const entries: StoredUtxo[] = [];

            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || entries.length >= pageSize) {
                    resolve({
                        entries,
                        total,
                        hasMore: !!cursor,
                        nextCursor: cursor ? (cursor.key as string) : undefined,
                    });
                    return;
                }
                entries.push(cursor.value as StoredUtxo);
                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
        });
    }

    /** Search by partial tx hash prefix (scans index, returns first matches) */
    searchByPrefix(prefix: string, limit = 20): Promise<StoredUtxo[]> {
        const lower = prefix;
        const upper = prefix + "\uffff";

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const index = tx.objectStore(UTXO_STORE).index("txHash");
            const range = IDBKeyRange.bound(lower, upper, false, true);
            const req = index.openCursor(range);
            const results: StoredUtxo[] = [];
            const seen = new Set<string>();

            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) {
                    resolve(results);
                    return;
                }
                const entry = cursor.value as StoredUtxo;
                if (!seen.has(entry.id)) {
                    seen.add(entry.id);
                    results.push(entry);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Compute analytics over the entire UTxO set */
    computeStats(onProgress?: (p: StatsProgress) => void): Promise<UtxoStats> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(UTXO_STORE, "readonly");
            const store = tx.objectStore(UTXO_STORE);

            const countReq = store.count();
            let totalEntries = 0;
            countReq.onsuccess = () => { totalEntries = countReq.result; };

            const cursorReq = store.openCursor();
            let totalSize = 0;
            let minSize = Infinity;
            let maxSize = 0;
            let scanned = 0;
            const bucketCounts = new Array(SIZE_BUCKETS.length).fill(0);
            const txHashCounts = new Map<string, number>();

            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) {
                    // Finalize
                    const sizeDistribution: SizeBucket[] = SIZE_BUCKETS.map((b, i) => ({
                        ...b,
                        count: bucketCounts[i],
                        percentage: totalEntries > 0 ? (bucketCounts[i] / totalEntries) * 100 : 0,
                    }));

                    const sortedTx = [...txHashCounts.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([txHash, outputCount]) => ({ txHash, outputCount }));

                    resolve({
                        totalEntries: scanned,
                        totalSizeBytes: totalSize,
                        avgSizeBytes: scanned > 0 ? Math.round(totalSize / scanned) : 0,
                        minSizeBytes: minSize === Infinity ? 0 : minSize,
                        maxSizeBytes: maxSize,
                        sizeDistribution,
                        topTxHashes: sortedTx,
                    });
                    return;
                }

                const entry = cursor.value as StoredUtxo;
                const sz = entry.size;
                totalSize += sz;
                if (sz < minSize) minSize = sz;
                if (sz > maxSize) maxSize = sz;

                for (let i = 0; i < SIZE_BUCKETS.length; i++) {
                    if (sz >= SIZE_BUCKETS[i].min && sz < SIZE_BUCKETS[i].max) {
                        bucketCounts[i]++;
                        break;
                    }
                }

                txHashCounts.set(entry.txHash, (txHashCounts.get(entry.txHash) ?? 0) + 1);
                scanned++;

                if (onProgress && scanned % 50000 === 0) {
                    onProgress({ scanned, total: totalEntries, phase: "scanning" });
                }

                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
        });
    }
}
