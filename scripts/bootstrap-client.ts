/**
 * bootstrap-client.ts — Browser-side IndexedDB bootstrap client
 *
 * Streams UTxO entries from the Gerolamo stream server and stores them
 * in IndexedDB for offline querying. Supports resume, batched writes,
 * and progress tracking.
 *
 * Browser-only: uses Web APIs (fetch, ReadableStream, IndexedDB).
 * No Bun/Node APIs.
 */

// ── Types ──

export interface StoredUtxo {
    /** Composite key: txHash:outputIndex */
    id: string;
    txHash: string;
    outputIndex: number;
    /** Raw CBOR hex of the value */
    valueCbor: string;
    /** Byte length of the value */
    size: number;
}

export interface BootstrapMeta {
    key: string;
    serverUrl: string;
    totalReceived: number;
    totalExpected: number | null;
    lastUpdated: number;
    status: "idle" | "streaming" | "paused" | "complete" | "error";
    errorMessage?: string;
}

export interface BootstrapProgress {
    received: number;
    expected: number | null;
    bytesReceived: number;
    entriesPerSecond: number;
    elapsed: number;
    eta: number | null;
    status: BootstrapMeta["status"];
}

export type ProgressCallback = (progress: BootstrapProgress) => void;

// ── Constants ──

const DB_NAME = "gerolamo-utxo";
const DB_VERSION = 1;
const UTXO_STORE = "utxo";
const META_STORE = "meta";
const META_KEY = "bootstrap-state";

// ── IndexedDB Helpers ──

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(UTXO_STORE)) {
                const store = db.createObjectStore(UTXO_STORE, { keyPath: "id" });
                store.createIndex("txHash", "txHash", { unique: false });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: "key" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
    });
}

function idbPut<T>(db: IDBDatabase, store: string, value: T): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function idbCount(db: IDBDatabase, store: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbBatchPut(db: IDBDatabase, store: string, items: StoredUtxo[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        for (const item of items) {
            os.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function idbClear(db: IDBDatabase, store: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const req = tx.objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// ── Bootstrap Client ──

export class BootstrapClient {
    private db: IDBDatabase | null = null;

    async open(): Promise<void> {
        this.db = await openDB();
    }

    getDB(): IDBDatabase {
        if (!this.db) throw new Error("Database not open. Call open() first.");
        return this.db;
    }

    async getState(): Promise<BootstrapMeta | null> {
        const meta = await idbGet<BootstrapMeta>(this.getDB(), META_STORE, META_KEY);
        return meta ?? null;
    }

    async getStoredCount(): Promise<number> {
        return idbCount(this.getDB(), UTXO_STORE);
    }

    async clear(): Promise<void> {
        await idbClear(this.getDB(), UTXO_STORE);
        await idbClear(this.getDB(), META_STORE);
    }

    async stream(
        serverUrl: string,
        options?: {
            onProgress?: ProgressCallback;
            batchSize?: number;
            signal?: AbortSignal;
            fresh?: boolean;
        }
    ): Promise<void> {
        const db = this.getDB();
        const batchSize = options?.batchSize ?? 1000;
        const onProgress = options?.onProgress;

        // Fresh start or resume
        if (options?.fresh) {
            await this.clear();
        }

        const storedCount = await this.getStoredCount();
        let totalExpected: number | null = null;

        // Fetch total count for progress
        try {
            const infoUrl = serverUrl.replace(/\/+$/, "") + "/api/info";
            const infoRes = await fetch(infoUrl);
            if (infoRes.ok) {
                const info = await infoRes.json();
                totalExpected = info.totalEntries ?? null;
            }
        } catch { /* non-critical */ }

        const streamUrl = `${serverUrl.replace(/\/+$/, "")}/api/stream/utxo?from=${storedCount}`;

        // Update state
        await idbPut<BootstrapMeta>(db, META_STORE, {
            key: META_KEY,
            serverUrl,
            totalReceived: storedCount,
            totalExpected,
            lastUpdated: Date.now(),
            status: "streaming",
        });

        const t0 = Date.now();
        let bytesReceived = 0;
        let received = storedCount;
        let batch: StoredUtxo[] = [];

        const flushBatch = async () => {
            if (batch.length === 0) return;
            await idbBatchPut(db, UTXO_STORE, batch);
            batch = [];

            // Save progress
            await idbPut<BootstrapMeta>(db, META_STORE, {
                key: META_KEY,
                serverUrl,
                totalReceived: received,
                totalExpected,
                lastUpdated: Date.now(),
                status: "streaming",
            });
        };

        const emitProgress = () => {
            if (!onProgress) return;
            const elapsed = Date.now() - t0;
            const entriesSinceStart = received - storedCount;
            const rate = elapsed > 100 ? (entriesSinceStart / elapsed) * 1000 : 0;
            const remaining = totalExpected ? totalExpected - received : null;
            const eta = rate > 0 && remaining !== null ? (remaining / rate) * 1000 : null;
            onProgress({
                received,
                expected: totalExpected,
                bytesReceived,
                entriesPerSecond: Math.round(rate),
                elapsed,
                eta: eta !== null ? Math.round(eta) : null,
                status: "streaming",
            });
        };

        try {
            const res = await fetch(streamUrl, { signal: options?.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            if (!res.body) throw new Error("No response body");

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                bytesReceived += value.byteLength;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop()!;

                for (const line of lines) {
                    if (!line.trim()) continue;
                    let obj: any;
                    try { obj = JSON.parse(line); } catch { continue; }

                    // Control messages
                    if (obj._progress || obj._done || obj._error) continue;

                    // UTxO entry
                    if (obj.txHash) {
                        batch.push({
                            id: `${obj.txHash}:${obj.outputIndex}`,
                            txHash: obj.txHash,
                            outputIndex: obj.outputIndex,
                            valueCbor: obj.valueCbor,
                            size: obj.valueCbor ? obj.valueCbor.length / 2 : 0,
                        });
                        received++;

                        if (batch.length >= batchSize) {
                            await flushBatch();
                            emitProgress();
                        }
                    }
                }
            }

            // Flush remaining
            await flushBatch();

            // Mark complete
            await idbPut<BootstrapMeta>(db, META_STORE, {
                key: META_KEY,
                serverUrl,
                totalReceived: received,
                totalExpected,
                lastUpdated: Date.now(),
                status: "complete",
            });

            if (onProgress) {
                const elapsed = Date.now() - t0;
                const entriesSinceStart = received - storedCount;
                const rate = elapsed > 100 ? (entriesSinceStart / elapsed) * 1000 : 0;
                onProgress({
                    received,
                    expected: totalExpected,
                    bytesReceived,
                    entriesPerSecond: Math.round(rate),
                    elapsed,
                    eta: 0,
                    status: "complete",
                });
            }
        } catch (e: any) {
            if (e.name === "AbortError") {
                await flushBatch();
                await idbPut<BootstrapMeta>(db, META_STORE, {
                    key: META_KEY,
                    serverUrl,
                    totalReceived: received,
                    totalExpected,
                    lastUpdated: Date.now(),
                    status: "paused",
                });
                if (onProgress) {
                    onProgress({
                        received,
                        expected: totalExpected,
                        bytesReceived,
                        entriesPerSecond: 0,
                        elapsed: Date.now() - t0,
                        eta: null,
                        status: "paused",
                    });
                }
            } else {
                await idbPut<BootstrapMeta>(db, META_STORE, {
                    key: META_KEY,
                    serverUrl,
                    totalReceived: received,
                    totalExpected,
                    lastUpdated: Date.now(),
                    status: "error",
                    errorMessage: e.message,
                });
                throw e;
            }
        }
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
