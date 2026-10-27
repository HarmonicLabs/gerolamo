/**
 * LMDB binding for the ledger store (docs/PLAN_LMDB_LEDGER.md phase 1), grown from the read-only
 * prototype in scripts/lmdb-ffi.ts: environment with named databases, read and write
 * transactions, get/put/del, and cursor range scans. Values are copied out of the map before a
 * transaction ends, so nothing points into LMDB memory after it. Write transactions are
 * serialised by a promise chain on our side (LMDB allows one writer per environment).
 *
 * Bun FFI over liblmdb (system `liblmdb.so`, `ldconfig`'s entry, or --lmdb-lib / config lmdbLib). The library is opened
 * on first use, after the settings are resolved.
 */
import { settings } from "../config/settings";
import { CString, dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
/** Raw pointers travel as numbers; the FFI signatures want `Pointer`. */
const P = (n: number): Pointer => n as unknown as Pointer;
import { existsSync, mkdirSync } from "node:fs";

const MDB_RDONLY = 0x20000;
const MDB_NOTLS = 0x200000;
const MDB_CREATE = 0x40000;
const MDB_NOTFOUND = -30798;
const MDB_KEYEXIST = -30799;
const MDB_MAP_FULL = -30792;
// cursor ops
const MDB_FIRST = 0, MDB_LAST = 6, MDB_NEXT = 8, MDB_PREV = 12, MDB_SET_RANGE = 17;

function findLib(): string {
    const candidates = [
        settings().lmdbLib,
        "/usr/lib/x86_64-linux-gnu/liblmdb.so",
        "/usr/lib/liblmdb.so",
        "/usr/lib64/liblmdb.so",
        "/usr/lib/x86_64-linux-gnu/liblmdb.so.0",
        "/usr/local/lib/liblmdb.so",
        "/opt/homebrew/lib/liblmdb.dylib",
    ].filter((x): x is string => !!x);
    for (const c of candidates) if (existsSync(c)) return c;
    // the dynamic linker's cache (Debian and Ubuntu images put it under a multiarch directory)
    try {
        const out = Bun.spawnSync(["ldconfig", "-p"]).stdout.toString();
        const m = /liblmdb\.so(?:\.\d+)*\s.*=>\s*(\S+)/.exec(out);
        if (m && existsSync(m[1]!)) return m[1]!;
    } catch { /* no ldconfig */ }
    throw new Error("liblmdb not found; pass --lmdb-lib <path to liblmdb.so> (or config lmdbLib)");
}

const openLib = () => dlopen(findLib(), {
    mdb_env_create: { args: [FFIType.ptr], returns: FFIType.int },
    mdb_env_set_mapsize: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.int },
    mdb_env_set_maxdbs: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.int },
    mdb_env_open: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.int },
    mdb_env_close: { args: [FFIType.ptr], returns: FFIType.void },
    mdb_env_sync: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
    mdb_txn_begin: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.int },
    mdb_txn_commit: { args: [FFIType.ptr], returns: FFIType.int },
    mdb_txn_abort: { args: [FFIType.ptr], returns: FFIType.void },
    mdb_dbi_open: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.int },
    mdb_get: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
    mdb_put: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.int },
    mdb_del: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
    mdb_drop: { args: [FFIType.ptr, FFIType.u32, FFIType.int], returns: FFIType.int },
    mdb_cursor_open: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.int },
    mdb_cursor_close: { args: [FFIType.ptr], returns: FFIType.void },
    mdb_cursor_get: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.int },
    mdb_stat: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.int },
    mdb_strerror: { args: [FFIType.int], returns: FFIType.ptr },
});
let opened: ReturnType<typeof openLib> | null = null;
/** liblmdb, opened on first use (so --lmdb-lib, resolved at startup, is honoured). */
const lib = new Proxy({} as ReturnType<typeof openLib>, { get: (_t, p) => (opened ??= openLib())[p as keyof ReturnType<typeof openLib>] });


function check(rc: number, what: string): void {
    if (rc !== 0) throw new Error(`${what}: ${new CString(lib.symbols.mdb_strerror(rc) as Pointer).toString()} (${rc})`);
}

const EMPTY_SCRATCH = new Uint8Array(1);
/** MDB_val is { size_t mv_size; void *mv_data } — 16 bytes on 64-bit. */
class Val {
    readonly buf = new BigUint64Array(2);
    private keep: Uint8Array | null = null; // keeps the pointed-to bytes alive
    set(bytes: Uint8Array): this {
        // A zero-length array has no address to take: point at a one-byte scratch buffer with size 0.
        const src = bytes.byteLength === 0 ? EMPTY_SCRATCH : bytes;
        this.keep = src;
        this.buf[0] = BigInt(bytes.byteLength);
        this.buf[1] = BigInt(ptr(src) as unknown as number);
        return this;
    }
    get ptr(): number { return ptr(this.buf); }
    /** Copy the bytes LMDB points at (valid only while the transaction lives). */
    read(): Uint8Array {
        const size = Number(this.buf[0]!), data = Number(this.buf[1]!);
        if (size === 0) return new Uint8Array(0);
        return new Uint8Array(toArrayBuffer(P(data), 0, size).slice(0));
    }
}

export interface LmdbEnvOptions {
    /** Map size in bytes (virtual; default 64 GiB). */
    mapSize?: number;
    maxDbs?: number;
    readOnly?: boolean;
}

export class LmdbEnv {
    private env: number;
    private readonly dbis = new Map<string, number>();
    private writeChain: Promise<unknown> = Promise.resolve();
    readonly path: string;
    readonly readOnly: boolean;
    private closed = false;

    private constructor(path: string, env: number, readOnly: boolean) {
        this.path = path;
        this.env = env;
        this.readOnly = readOnly;
    }

    static open(path: string, opts: LmdbEnvOptions = {}): LmdbEnv {
        if (!opts.readOnly) mkdirSync(path, { recursive: true });
        const envPtrBuf = new BigUint64Array(1);
        check(lib.symbols.mdb_env_create(ptr(envPtrBuf)), "mdb_env_create");
        const env = Number(envPtrBuf[0]);
        check(lib.symbols.mdb_env_set_mapsize(P(env), BigInt(opts.mapSize ?? 64 * 1024 ** 3)), "mdb_env_set_mapsize");
        check(lib.symbols.mdb_env_set_maxdbs(P(env), opts.maxDbs ?? 64), "mdb_env_set_maxdbs");
        const pathBuf = Buffer.from(path + "\0", "utf8");
        const flags = MDB_NOTLS | (opts.readOnly ? MDB_RDONLY : 0);
        const rc = lib.symbols.mdb_env_open(P(env), ptr(pathBuf), flags, 0o644);
        if (rc !== 0) { lib.symbols.mdb_env_close(P(env)); check(rc, `mdb_env_open ${path}`); }
        return new LmdbEnv(path, env, !!opts.readOnly);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        lib.symbols.mdb_env_close(P(this.env));
    }

    /** Named database handle (created on first use in a write transaction). */
    dbi(name: string, txn: LmdbTxn): number {
        const hit = this.dbis.get(name);
        if (hit !== undefined) return hit;
        const out = new Uint32Array(1);
        const nameBuf = Buffer.from(name + "\0", "utf8");
        const rc = lib.symbols.mdb_dbi_open(P(txn.ptr), ptr(nameBuf), txn.readOnly ? 0 : MDB_CREATE, ptr(out));
        if (rc === MDB_NOTFOUND) return -1; // read txn on a database that does not exist yet
        check(rc, `mdb_dbi_open ${name}`);
        this.dbis.set(name, out[0]!);
        txn.openedDbis.push(name);
        return out[0]!;
    }

    /** Handles opened inside a transaction that is then aborted are closed by LMDB: drop them from the cache. */
    forgetDbis(names: string[]): void {
        for (const n of names) this.dbis.delete(n);
    }

    beginRead(): LmdbTxn {
        return LmdbTxn.begin(this, this.env, true);
    }

    /** Run `fn` inside the single write transaction; commits on return, aborts on throw. Serialised. */
    write<T>(fn: (txn: LmdbTxn) => T): Promise<T> {
        if (this.readOnly) return Promise.reject(new Error("environment opened read-only"));
        const run = this.writeChain.then(() => {
            const txn = LmdbTxn.begin(this, this.env, false);
            try {
                const out = fn(txn);
                txn.commit();
                return out;
            } catch (err) {
                txn.abort();
                throw err;
            }
        });
        this.writeChain = run.catch(() => {});
        return run;
    }

    /**
     * Synchronous write transaction for single-threaded tools (importers): must not run while an
     * async `write` chain is in flight — LMDB allows one writer, and this one does not queue.
     */
    writeSync<T>(fn: (txn: LmdbTxn) => T): T {
        if (this.readOnly) throw new Error("environment opened read-only");
        const txn = LmdbTxn.begin(this, this.env, false);
        try { const out = fn(txn); txn.commit(); return out; } catch (err) { txn.abort(); throw err; }
    }

    /** Read helper: opens a read transaction, runs `fn`, ends it (committing keeps any handle it opened valid). */
    read<T>(fn: (txn: LmdbTxn) => T): T {
        const txn = this.beginRead();
        let ok = false;
        try { const out = fn(txn); ok = true; return out; } finally { if (ok) txn.commit(); else txn.abort(); }
    }

    sync(): void { check(lib.symbols.mdb_env_sync(P(this.env), 1), "mdb_env_sync"); }
}

export class LmdbTxn {
    private live = true;
    /** Database handles first opened in this transaction (invalid again if it aborts). */
    readonly openedDbis: string[] = [];
    private constructor(readonly env: LmdbEnv, readonly ptr: number, readonly readOnly: boolean) {}

    static begin(env: LmdbEnv, envPtr: number, readOnly: boolean): LmdbTxn {
        const out = new BigUint64Array(1);
        check(lib.symbols.mdb_txn_begin(P(envPtr), null, readOnly ? MDB_RDONLY : 0, ptr(out)), "mdb_txn_begin");
        return new LmdbTxn(env, Number(out[0]), readOnly);
    }

    commit(): void { if (!this.live) return; this.live = false; check(lib.symbols.mdb_txn_commit(P(this.ptr)), "mdb_txn_commit"); }
    abort(): void { if (!this.live) return; this.live = false; lib.symbols.mdb_txn_abort(P(this.ptr)); this.env.forgetDbis(this.openedDbis); }

    private db(name: string): number { return this.env.dbi(name, this); }

    get(name: string, key: Uint8Array): Uint8Array | undefined {
        const dbi = this.db(name);
        if (dbi < 0) return undefined;
        const k = new Val().set(key), v = new Val();
        const rc = lib.symbols.mdb_get(P(this.ptr), dbi, P(k.ptr), P(v.ptr));
        if (rc === MDB_NOTFOUND) return undefined;
        check(rc, "mdb_get");
        return v.read();
    }

    has(name: string, key: Uint8Array): boolean { return this.get(name, key) !== undefined; }

    put(name: string, key: Uint8Array, value: Uint8Array): void {
        if (this.readOnly) throw new Error("put in a read transaction");
        const dbi = this.db(name);
        const k = new Val().set(key), v = new Val().set(value);
        const rc = lib.symbols.mdb_put(P(this.ptr), dbi, P(k.ptr), P(v.ptr), 0);
        if (rc === MDB_MAP_FULL) throw new Error("LMDB map full: raise mapSize");
        if (rc === MDB_KEYEXIST) throw new Error("mdb_put: key exists");
        check(rc, "mdb_put");
    }

    /** Delete; returns false when the key was absent. */
    del(name: string, key: Uint8Array): boolean {
        if (this.readOnly) throw new Error("del in a read transaction");
        const dbi = this.db(name);
        if (dbi < 0) return false;
        const k = new Val().set(key);
        const rc = lib.symbols.mdb_del(P(this.ptr), dbi, P(k.ptr), null);
        if (rc === MDB_NOTFOUND) return false;
        check(rc, "mdb_del");
        return true;
    }

    /** Empty a database (keep the handle). */
    clear(name: string): void {
        const dbi = this.db(name);
        if (dbi < 0) return;
        check(lib.symbols.mdb_drop(P(this.ptr), dbi, 0), "mdb_drop");
    }

    /** Names of the environment's named databases: the keys of the unnamed main database (store-compare). */
    databaseNames(): string[] {
        const out = new Uint32Array(1);
        check(lib.symbols.mdb_dbi_open(P(this.ptr), null, 0, ptr(out)), "mdb_dbi_open (main)");
        const cur = new BigUint64Array(1);
        check(lib.symbols.mdb_cursor_open(P(this.ptr), out[0]!, ptr(cur)), "mdb_cursor_open");
        const names: string[] = [];
        try {
            const k = new Val(), v = new Val();
            let rc = lib.symbols.mdb_cursor_get(P(Number(cur[0])), P(k.ptr), P(v.ptr), MDB_FIRST);
            while (rc === 0) { names.push(new TextDecoder().decode(k.read()).replace(/\0+$/, "")); rc = lib.symbols.mdb_cursor_get(P(Number(cur[0])), P(k.ptr), P(v.ptr), MDB_NEXT); }
            if (rc !== MDB_NOTFOUND) check(rc, "mdb_cursor_get");
        } finally { lib.symbols.mdb_cursor_close(P(Number(cur[0]))); }
        return names;
    }

    /** Number of entries in a database. */
    count(name: string): number {
        const dbi = this.db(name);
        if (dbi < 0) return 0;
        const stat = new BigUint64Array(5); // MDB_stat: {u32 psize, u32 depth} = stat[0], then size_t branch, leaf, overflow, entries
        check(lib.symbols.mdb_stat(P(this.ptr), dbi, ptr(stat)), "mdb_stat");
        return Number(stat[4]!); // ms_entries
    }

    /**
     * Entries with key ≥ `from` (or from the first key), ascending, while `prefix` matches (when
     * given), at most `limit`. Keys and values are copied.
     */
    *range(name: string, opts: { from?: Uint8Array; prefix?: Uint8Array; limit?: number; reverse?: boolean } = {}): Generator<[Uint8Array, Uint8Array]> {
        const dbi = this.db(name);
        if (dbi < 0) return;
        const cur = new BigUint64Array(1);
        check(lib.symbols.mdb_cursor_open(P(this.ptr), dbi, ptr(cur)), "mdb_cursor_open");
        const cursor = Number(cur[0]);
        try {
            const k = new Val(), v = new Val();
            let rc: number;
            const start0 = opts.from ?? opts.prefix;
            const start = start0 && start0.length ? start0 : undefined; // LMDB rejects a zero-length key; an empty prefix means "everything"
            if (opts.reverse) rc = lib.symbols.mdb_cursor_get(P(cursor), P(k.ptr), P(v.ptr), MDB_LAST);
            else if (start) { k.set(start); rc = lib.symbols.mdb_cursor_get(P(cursor), P(k.ptr), P(v.ptr), MDB_SET_RANGE); }
            else rc = lib.symbols.mdb_cursor_get(P(cursor), P(k.ptr), P(v.ptr), MDB_FIRST);
            let n = 0;
            const limit = opts.limit ?? Infinity;
            while (rc === 0 && n < limit) {
                const key = k.read();
                if (opts.prefix && !startsWith(key, opts.prefix)) break;
                yield [key, v.read()];
                n++;
                rc = lib.symbols.mdb_cursor_get(P(cursor), P(k.ptr), P(v.ptr), opts.reverse ? MDB_PREV : MDB_NEXT);
            }
            if (rc !== 0 && rc !== MDB_NOTFOUND) check(rc, "mdb_cursor_get");
        } finally {
            lib.symbols.mdb_cursor_close(P(cursor));
        }
    }
}

function startsWith(key: Uint8Array, prefix: Uint8Array): boolean {
    if (key.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
    return true;
}
