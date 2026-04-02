/**
 * Unit tests for lmdb-ffi.ts and dump-lmdb-utxo.ts
 * Run: bun test scripts/lmdb-ffi.test.ts
 */
import { describe, test, expect } from "bun:test";
import { iterateLmdb } from "./lmdb-ffi.ts";
import { existsSync } from "fs";

const LMDB_DIR = new URL("../db/tmp/snapshots/118971022_lmdb/tables/", import.meta.url).pathname;
const TVAR_PATH = new URL("../db/ledger/118971022/tables/tvar", import.meta.url).pathname;
const hasLmdbData = existsSync(LMDB_DIR + "/data.mdb");
const hasTvarData = existsSync(TVAR_PATH);

// ─── FFI Library Tests ───

describe("lmdb-ffi", () => {
    test("iterateLmdb throws on nonexistent directory", () => {
        expect(() => {
            iterateLmdb("/nonexistent/path", () => {});
        }).toThrow("mdb_env_open");
    });

    test("iterateLmdb throws on empty string path", () => {
        expect(() => {
            iterateLmdb("", () => {});
        }).toThrow();
    });
});

describe("lmdb-ffi with real data", () => {
    test.skipIf(!hasLmdbData)("discovers databases", () => {
        let dbNames: string[] = [];
        try {
            const result = iterateLmdb(LMDB_DIR, () => {
                throw new Error("STOP"); // stop after first entry
            });
            dbNames = result.databases;
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
            // Databases are discovered before iteration, but we lost the return value.
            // Re-run without throwing to just get db names.
        }
        // If caught, re-discover
        if (dbNames.length === 0) {
            let count = 0;
            const names = new Set<string>();
            try {
                iterateLmdb(LMDB_DIR, (entry) => {
                    names.add(entry.dbName);
                    count++;
                    if (count >= 5) throw new Error("STOP");
                });
            } catch (e: any) {
                if (e.message !== "STOP") throw e;
            }
            dbNames = [...names];
        }
        expect(dbNames.length).toBeGreaterThan(0);
    });

    test.skipIf(!hasLmdbData)("reads _dbstate and utxo databases", () => {
        const dbNames = new Set<string>();
        let count = 0;
        try {
            iterateLmdb(LMDB_DIR, (entry) => {
                dbNames.add(entry.dbName);
                count++;
                if (count >= 10) throw new Error("STOP");
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        expect(dbNames.has("_dbstate")).toBe(true);
        expect(dbNames.has("utxo")).toBe(true);
    });

    test.skipIf(!hasLmdbData)("_dbstate has exactly 1 entry", () => {
        let dbStateCount = 0;
        try {
            iterateLmdb(LMDB_DIR, (entry) => {
                if (entry.dbName === "_dbstate") dbStateCount++;
                // Stop once we hit utxo entries
                if (entry.dbName === "utxo") throw new Error("STOP");
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        expect(dbStateCount).toBe(1);
    });

    test.skipIf(!hasLmdbData)("UTxO keys are 34 bytes (txhash + output index)", () => {
        let checked = 0;
        try {
            iterateLmdb(LMDB_DIR, (entry) => {
                if (entry.dbName === "utxo") {
                    expect(entry.key.length).toBe(34);
                    expect(entry.value.length).toBeGreaterThan(0);
                    checked++;
                    if (checked >= 100) throw new Error("STOP");
                }
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        expect(checked).toBe(100);
    });

    test.skipIf(!hasLmdbData)("output index is little-endian (values are small integers)", () => {
        const indices: number[] = [];
        let count = 0;
        try {
            iterateLmdb(LMDB_DIR, (entry) => {
                if (entry.dbName === "utxo") {
                    const outputIndex = entry.key[32] | (entry.key[33] << 8);
                    indices.push(outputIndex);
                    count++;
                    if (count >= 1000) throw new Error("STOP");
                }
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        // With LE, most output indices should be < 100 (typical Cardano UTxOs)
        const smallIndices = indices.filter(i => i < 100);
        expect(smallIndices.length).toBeGreaterThan(indices.length * 0.8);
        // With BE (the old bug), most would be multiples of 256
        const multiplesOf256 = indices.filter(i => i > 0 && i % 256 === 0);
        expect(multiplesOf256.length).toBeLessThan(indices.length * 0.1);
    });

    test.skipIf(!hasLmdbData)("callback receives valid Uint8Array data", () => {
        let checked = false;
        try {
            iterateLmdb(LMDB_DIR, (entry) => {
                expect(entry.key).toBeInstanceOf(Uint8Array);
                expect(entry.value).toBeInstanceOf(Uint8Array);
                expect(entry.dbName).toBeTypeOf("string");
                expect(entry.dbName.length).toBeGreaterThan(0);
                checked = true;
                throw new Error("STOP");
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        expect(checked).toBe(true);
    });

    test.skipIf(!hasLmdbData)("onProgress callback fires for large datasets", () => {
        const progressCalls: { db: string; count: number }[] = [];
        let totalCount = 0;
        try {
            iterateLmdb(LMDB_DIR, () => {
                totalCount++;
                if (totalCount >= 100005) throw new Error("STOP");
            }, {
                onProgress: (db, count) => progressCalls.push({ db, count }),
            });
        } catch (e: any) {
            if (e.message !== "STOP") throw e;
        }
        // Should have at least 1 progress call
        expect(progressCalls.length).toBeGreaterThanOrEqual(1);
        // _dbstate has only 1 entry, so its final progress is count=1
        // utxo should trigger at 100000
        const utxoProgress = progressCalls.find(p => p.db === "utxo" && p.count === 100000);
        expect(utxoProgress).toBeDefined();
    });
});

// ─── CborReader Tests (decode-tvar.ts internals) ───

describe("decode-tvar CborReader", () => {
    // We test the CBOR reader by importing it — but it's a class inside decode-tvar.ts
    // so we test via the file output instead

    test.skipIf(!hasTvarData)("tvar file exists and is large", () => {
        const stat = Bun.file(TVAR_PATH);
        expect(stat.size).toBeGreaterThan(100 * 1024 * 1024); // > 100 MB
    });

    test.skipIf(!hasTvarData)("tvar starts with CBOR array header", async () => {
        const file = Bun.file(TVAR_PATH);
        const header = new Uint8Array(await file.slice(0, 3).arrayBuffer());
        // array(1) = 0x81, then map(indefinite) = 0xbf
        expect(header[0]).toBe(0x81); // CBOR array(1)
        expect(header[1]).toBe(0xbf); // CBOR indefinite-length map
    });
});

// ─── Output Format Tests ───

describe("NDJSON output format", () => {
    const OUTPUT_FILE = new URL("./output/lmdb-utxo.ndjson", import.meta.url).pathname;
    const hasOutput = existsSync(OUTPUT_FILE);

    test.skipIf(!hasOutput)("output file is valid NDJSON", async () => {
        const file = Bun.file(OUTPUT_FILE);
        // Read first 10 lines
        const text = await file.slice(0, 10000).text();
        const lines = text.split("\n").filter(l => l.trim());
        for (const line of lines.slice(0, 10)) {
            const parsed = JSON.parse(line);
            expect(parsed).toBeDefined();
            expect(parsed.rawKey).toBeTypeOf("string");
        }
    });

    test.skipIf(!hasOutput)("UTxO entries have correct fields", async () => {
        const file = Bun.file(OUTPUT_FILE);
        const text = await file.slice(0, 50000).text();
        // Only parse complete lines (last line may be truncated by slice)
        const lines = text.split("\n").filter(l => l.trim());
        lines.pop(); // drop potentially truncated last line
        let utxoCount = 0;
        for (const line of lines) {
            const entry = JSON.parse(line);
            if (entry.db === "utxo") {
                expect(entry.txHash).toBeTypeOf("string");
                expect(entry.txHash.length).toBe(64); // 32 bytes hex
                expect(entry.outputIndex).toBeTypeOf("number");
                expect(entry.outputIndex).toBeGreaterThanOrEqual(0);
                expect(entry.outputIndex).toBeLessThan(65536);
                utxoCount++;
            }
        }
        expect(utxoCount).toBeGreaterThan(0);
    });
});
