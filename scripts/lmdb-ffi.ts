/**
 * lmdb-ffi.ts — Bun FFI bindings to liblmdb
 *
 * Provides direct in-process access to LMDB databases without spawning
 * a separate C binary. Uses Bun's native FFI (bun:ffi) to call liblmdb
 * functions via dlopen.
 */
import { dlopen, FFIType, ptr, toArrayBuffer, CString, suffix } from "bun:ffi";
import { existsSync } from "fs";
import { execSync } from "child_process";

// Resolve liblmdb.so path — search Nix store, env, and system paths
function findLibLmdb(): string {
    const candidates = [
        // Nix devenv profile paths (common in this project)
        "/nix/store/rhs6mg5fdmvmyk2z10wvx2553zsj9j4f-lmdb-0.9.35/lib/liblmdb.so",
        "/nix/store/3nx9lw1xvaj6byw6nii6rifgccfj7mcp-lmdb-0.9.35/lib/liblmdb.so",
        // System paths
        "/usr/lib/liblmdb.so",
        "/usr/lib/x86_64-linux-gnu/liblmdb.so",
        "/usr/local/lib/liblmdb.so",
    ];

    for (const path of candidates) {
        if (existsSync(path)) return path;
    }

    // Try finding via Nix store glob
    try {
        const found = execSync("find /nix/store -maxdepth 4 -name 'liblmdb.so' -not -path '*/devenv-profile/*' 2>/dev/null | head -1", { encoding: "utf-8" }).trim();
        if (found && existsSync(found)) return found;
    } catch { /* ignore */ }

    // Last resort: let the dynamic linker find it
    return `liblmdb.${suffix}`;
}

const LMDB_LIB_PATH = findLibLmdb();

// LMDB constants
const MDB_RDONLY = 0x20000;
const MDB_NOTLS = 0x200000;
const MDB_NOLOCK = 0x400000;
const MDB_FIRST = 0;
const MDB_NEXT = 8;
const MDB_SUCCESS = 0;
const MDB_NOTFOUND = -30798;

// Open liblmdb with all the functions we need
const lib = dlopen(LMDB_LIB_PATH, {
    mdb_env_create: {
        args: [FFIType.ptr], // MDB_env **env
        returns: FFIType.int,
    },
    mdb_env_set_mapsize: {
        args: [FFIType.ptr, FFIType.u64], // env, size_t
        returns: FFIType.int,
    },
    mdb_env_set_maxdbs: {
        args: [FFIType.ptr, FFIType.u32], // env, MDB_dbi
        returns: FFIType.int,
    },
    mdb_env_open: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], // env, path, flags, mode
        returns: FFIType.int,
    },
    mdb_env_close: {
        args: [FFIType.ptr], // env
        returns: FFIType.void,
    },
    mdb_txn_begin: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], // env, parent, flags, MDB_txn**
        returns: FFIType.int,
    },
    mdb_txn_abort: {
        args: [FFIType.ptr], // txn
        returns: FFIType.void,
    },
    mdb_dbi_open: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], // txn, name, flags, MDB_dbi*
        returns: FFIType.int,
    },
    mdb_cursor_open: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr], // txn, dbi, MDB_cursor**
        returns: FFIType.int,
    },
    mdb_cursor_close: {
        args: [FFIType.ptr], // cursor
        returns: FFIType.void,
    },
    mdb_cursor_get: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], // cursor, MDB_val* key, MDB_val* data, op
        returns: FFIType.int,
    },
    mdb_strerror: {
        args: [FFIType.int],
        returns: FFIType.ptr, // const char*
    },
});

function mdbError(rc: number): string {
    const strPtr = lib.symbols.mdb_strerror(rc);
    if (!strPtr) return `LMDB error ${rc}`;
    return new CString(strPtr) + ` (${rc})`;
}

function check(rc: number, context: string): void {
    if (rc !== MDB_SUCCESS) {
        throw new Error(`${context}: ${mdbError(rc)}`);
    }
}

// MDB_val is { mv_size: size_t, mv_data: void* } — 16 bytes on 64-bit
const MDB_VAL_SIZE = 16; // sizeof(MDB_val) on 64-bit: 8 (size_t) + 8 (pointer)

function readMdbVal(valBuf: Uint8Array, offset: number): { size: number; dataPtr: number } {
    const dv = new DataView(valBuf.buffer, valBuf.byteOffset + offset);
    // size_t (8 bytes LE) + void* (8 bytes LE) on x86_64
    const size = Number(dv.getBigUint64(0, true));
    const dataPtr = Number(dv.getBigUint64(8, true));
    return { size, dataPtr };
}

function readMdbValData(valBuf: Uint8Array, offset: number): Uint8Array {
    const { size, dataPtr } = readMdbVal(valBuf, offset);
    if (size === 0 || dataPtr === 0) return new Uint8Array(0);
    // Read data from the pointer
    return new Uint8Array(toArrayBuffer(dataPtr, 0, size));
}

export interface LmdbEntry {
    dbName: string;
    key: Uint8Array;
    value: Uint8Array;
}

/**
 * Open an LMDB environment and iterate all entries across all sub-databases.
 * Calls `callback` for each key-value pair.
 */
export function iterateLmdb(
    dbDir: string,
    callback: (entry: LmdbEntry) => void,
    options?: { mapSize?: number; maxDbs?: number; onProgress?: (dbName: string, count: number) => void }
): { totalEntries: number; databases: string[] } {
    const mapSize = options?.mapSize ?? 2 * 1024 * 1024 * 1024; // 2 GB default
    const maxDbs = options?.maxDbs ?? 10;
    const onProgress = options?.onProgress;

    // Allocate pointers for out-params
    const envPtrBuf = new BigUint64Array(1);  // MDB_env*
    const txnPtrBuf = new BigUint64Array(1);  // MDB_txn*
    const cursorPtrBuf = new BigUint64Array(1); // MDB_cursor*
    const dbiBuf = new Uint32Array(1);        // MDB_dbi

    // Key and value MDB_val structs (16 bytes each on 64-bit)
    const keyValBuf = new Uint8Array(MDB_VAL_SIZE);
    const dataValBuf = new Uint8Array(MDB_VAL_SIZE);

    // Create env
    check(lib.symbols.mdb_env_create(ptr(envPtrBuf)), "mdb_env_create");
    const envPtr = Number(envPtrBuf[0]);

    check(lib.symbols.mdb_env_set_mapsize(envPtr, BigInt(mapSize)), "mdb_env_set_mapsize");
    check(lib.symbols.mdb_env_set_maxdbs(envPtr, maxDbs), "mdb_env_set_maxdbs");

    // Encode path as null-terminated C string
    const pathBuf = Buffer.from(dbDir + "\0", "utf-8");
    check(
        lib.symbols.mdb_env_open(envPtr, ptr(pathBuf), MDB_RDONLY | MDB_NOTLS | MDB_NOLOCK, 0o644),
        "mdb_env_open"
    );

    try {
        // Begin read-only transaction
        check(lib.symbols.mdb_txn_begin(envPtr, null, MDB_RDONLY, ptr(txnPtrBuf)), "mdb_txn_begin");
        const txnPtr = Number(txnPtrBuf[0]);

        try {
            // Open root (unnamed) DB to discover sub-databases
            check(lib.symbols.mdb_dbi_open(txnPtr, null, 0, ptr(dbiBuf)), "mdb_dbi_open(root)");
            const rootDbi = dbiBuf[0];

            check(lib.symbols.mdb_cursor_open(txnPtr, rootDbi, ptr(cursorPtrBuf)), "mdb_cursor_open(root)");
            const rootCursor = Number(cursorPtrBuf[0]);

            // Collect sub-database names
            const dbNames: string[] = [];
            let rc = lib.symbols.mdb_cursor_get(rootCursor, ptr(keyValBuf), ptr(dataValBuf), MDB_FIRST);
            while (rc === MDB_SUCCESS) {
                const keyData = readMdbValData(keyValBuf, 0);
                const name = new TextDecoder().decode(keyData);
                dbNames.push(name);
                rc = lib.symbols.mdb_cursor_get(rootCursor, ptr(keyValBuf), ptr(dataValBuf), MDB_NEXT);
            }
            lib.symbols.mdb_cursor_close(rootCursor);

            // Iterate each sub-database
            let totalEntries = 0;

            for (const dbName of dbNames) {
                const nameBuf = Buffer.from(dbName + "\0", "utf-8");
                const openRc = lib.symbols.mdb_dbi_open(txnPtr, ptr(nameBuf), 0, ptr(dbiBuf));
                if (openRc !== MDB_SUCCESS) {
                    console.error(`Skipping database ${dbName}: ${mdbError(openRc)}`);
                    continue;
                }
                const subDbi = dbiBuf[0];

                const cursorRc = lib.symbols.mdb_cursor_open(txnPtr, subDbi, ptr(cursorPtrBuf));
                if (cursorRc !== MDB_SUCCESS) {
                    console.error(`Skipping cursor for ${dbName}: ${mdbError(cursorRc)}`);
                    continue;
                }
                const cursor = Number(cursorPtrBuf[0]);

                let count = 0;
                rc = lib.symbols.mdb_cursor_get(cursor, ptr(keyValBuf), ptr(dataValBuf), MDB_FIRST);
                while (rc === MDB_SUCCESS) {
                    const key = readMdbValData(keyValBuf, 0);
                    const value = readMdbValData(dataValBuf, 0);

                    callback({ dbName, key, value });

                    count++;
                    totalEntries++;
                    if (onProgress && count % 100000 === 0) {
                        onProgress(dbName, count);
                    }

                    rc = lib.symbols.mdb_cursor_get(cursor, ptr(keyValBuf), ptr(dataValBuf), MDB_NEXT);
                }
                lib.symbols.mdb_cursor_close(cursor);

                if (onProgress) onProgress(dbName, count);
            }

            lib.symbols.mdb_txn_abort(txnPtr);
            return { totalEntries, databases: dbNames };
        } catch (e) {
            lib.symbols.mdb_txn_abort(txnPtr);
            throw e;
        }
    } finally {
        lib.symbols.mdb_env_close(envPtr);
    }
}
