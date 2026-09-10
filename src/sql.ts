import { SQL } from "bun";
import { createSyncSqlClient } from "./sqlSync";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Shared SQLite SQL client for Gerolamo.
 *
 * Bun's default `import { sql } from "bun"` is Postgres. Gerolamo stores
 * chain state in SQLite (config.dbPath / DATABASE_URL / ./.live/test.db).
 *
 * Call `initSql(dbPath)` from start() before ensureInitialized().
 * `sql` resolves its connection per call, so initSql() is visible to all importers,
 * and HTTP GET handlers wrapped in `withReadOnlyConnection` use a second,
 * read-only connection that does not queue behind the applier's transactions.
 *
 * Default path is the live Mithril-populated DB (not ./ledger/gerolamo.db).
 */

function filenameFromEnvOrDefault(): string {
    const url = process.env.DATABASE_URL;
    if (url?.startsWith("sqlite://")) {
        // sqlite:///abs/path or sqlite://./relative
        return url.slice("sqlite://".length);
    }
    if (url?.startsWith("file:")) {
        return url.slice("file:".length);
    }
    return process.env.GEROLAMO_DB_PATH || "./.live/test.db";
}

/** Resolved absolute path of the open SQLite file (Bun SQL does not expose options.filename). */
let currentDbPath: string = resolve(filenameFromEnvOrDefault());

/**
 * The writer is the synchronous bun:sqlite client (src/sqlSync.ts) with the same tagged-template
 * surface — no query objects, no promise per statement, prepared statements cached. Default since
 * 2026-09-07 (2–3× faster on the applier's statement mix, ~25 % less apply time per block byte on
 * the preview replay); GEROLAMO_SYNC_SQL=0 falls back to Bun.SQL. The read-only API connection
 * stays on Bun.SQL either way.
 */
export const SYNC_SQL = process.env.GEROLAMO_SYNC_SQL !== "0";
function openSqlite(filename: string): SQL {
    const abs = resolve(filename);
    mkdirSync(dirname(abs), { recursive: true });
    currentDbPath = abs;
    if (SYNC_SQL) return createSyncSqlClient(abs) as unknown as SQL;
    return new SQL({ adapter: "sqlite", filename: abs });
}

/** The writer: every query outside a read-only context goes here. Reassigned by initSql(). */
let writer: SQL = openSqlite(filenameFromEnvOrDefault());

/**
 * Read-only companion connection for HTTP GET handlers (`withReadOnlyConnection`).
 * WAL gives it a consistent snapshot of the last commit without waiting for the
 * applier's long write transactions on the writer; opened lazily per DB file.
 */
let reader: SQL | null = null;
let readerPath: string | null = null;
const readContext = new AsyncLocalStorage<SQL>();

function readerFor(path: string): SQL {
    if (reader && readerPath === path) return reader;
    try {
        void (reader as any)?.close?.();
    } catch {
        /* ignore */
    }
    reader = new SQL({ adapter: "sqlite", filename: path, readonly: true } as any);
    readerPath = path;
    // A database still in rollback-journal mode blocks readers while a write is open: wait rather than fail.
    void reader.unsafe("PRAGMA busy_timeout = 10000").catch(() => {});
    return reader;
}

function currentSql(): SQL {
    return readContext.getStore() ?? writer;
}

/**
 * Shared client. A Proxy so that code inside `withReadOnlyConnection` reads
 * from the read-only connection while everything else (the applier, tests,
 * scripts) keeps the writer; the live binding semantics of the old `let`
 * export are preserved because every call resolves the connection at call time.
 */
/**
 * GEROLAMO_SQL_PROFILE=1: time every tagged-template statement on the shared client and
 * log the heaviest ones each minute. Bun's SQLite driver runs statements synchronously
 * when the query is awaited, so creation-to-settle ≈ execution time on the main thread.
 */
const SQL_PROFILE = process.env.GEROLAMO_SQL_PROFILE === "1";
const sqlProfile = new Map<string, { n: number; ms: number; rows: number }>();
let sqlProfileLast = Date.now();
// Keyed by the template's strings array (stable identity per call site): joining and
// normalising the SQL text on every call put `join` + a regex on the hot path of the very
// profile being taken (20 % of a 2026-09-07 CPU profile was the profiler itself).
const sqlProfileKeys = new WeakMap<object, string>();
function sqlProfileKey(strings: unknown): string {
    if (Array.isArray(strings)) {
        const hit = sqlProfileKeys.get(strings);
        if (hit !== undefined) return hit;
        const key = (strings as string[]).join("?").replace(/\s+/g, " ").trim().slice(0, 110);
        sqlProfileKeys.set(strings, key);
        return key;
    }
    return String(strings).replace(/\s+/g, " ").trim().slice(0, 110);
}
function sqlProfileRecord(key: string, ms: number, rows: number): void {
    const e = sqlProfile.get(key) ?? { n: 0, ms: 0, rows: 0 };
    e.n++; e.ms += ms; e.rows += rows;
    sqlProfile.set(key, e);
    const now = Date.now();
    if (now - sqlProfileLast >= 60_000) {
        sqlProfileLast = now;
        const top = [...sqlProfile.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25);
        const total = [...sqlProfile.values()].reduce((a, e) => a + e.ms, 0);
        console.log(`[SQL PROFILE] ${Math.round(total)} ms in ${[...sqlProfile.values()].reduce((a, e) => a + e.n, 0)} statements since last report\n` +
            top.map(([k, e]) => `  ${Math.round(e.ms).toString().padStart(7)} ms ${e.n.toString().padStart(7)}x ${(e.ms / e.n).toFixed(3).padStart(8)} ms/call ${Math.round(e.rows / e.n).toString().padStart(6)} rows  ${k}`).join("\n"));
        sqlProfile.clear();
    }
}
function sqlProfileWrap(q: any, key: string, t0: number): any {
    if (!q || typeof q.then !== "function") return q;
    const origThen = q.then.bind(q);
    let done = false;
    const settle = (v: unknown) => { if (!done) { done = true; sqlProfileRecord(key, performance.now() - t0, Array.isArray(v) ? v.length : 0); } };
    q.then = (res?: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => origThen((v: unknown) => { settle(v); return res ? res(v) : v; }, (e: unknown) => { settle(null); if (rej) return rej(e); throw e; });
    return q;
}

export const sql: SQL = new Proxy(function sqlProxyTarget() {} as unknown as SQL, {
    apply(_t, _thisArg, args: unknown[]) {
        const c = currentSql();
        if (SQL_PROFILE) {
            const t0 = performance.now();
            return sqlProfileWrap(Reflect.apply(c as unknown as (...a: unknown[]) => unknown, c, args), sqlProfileKey(args[0]), t0);
        }
        return Reflect.apply(c as unknown as (...a: unknown[]) => unknown, c, args);
    },
    get(_t, prop) {
        const c = currentSql() as unknown as Record<PropertyKey, unknown>;
        const v = c[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
    },
    set(_t, prop, value) {
        (currentSql() as unknown as Record<PropertyKey, unknown>)[prop] = value;
        return true;
    },
    has(_t, prop) {
        return prop in (currentSql() as unknown as object);
    },
}) as SQL;

/** True while running inside `withReadOnlyConnection`. */
export function isReadOnlyContext(): boolean {
    return readContext.getStore() != null;
}

/**
 * Run `fn` with `sql` bound to the read-only connection. Only for code that
 * never writes (HTTP GET handlers): writes fail with "attempt to write a
 * readonly database". In-memory databases have no second connection, so `fn`
 * simply runs on the writer there.
 */
export function withReadOnlyConnection<T>(fn: () => Promise<T> | T): Promise<T> {
    if (currentDbPath === ":memory:" || currentDbPath.endsWith("/:memory:") || readContext.getStore()) {
        return Promise.resolve().then(fn);
    }
    return readContext.run(readerFor(currentDbPath), () => Promise.resolve().then(fn));
}

export function initSql(dbPath?: string): SQL {
    const filename = dbPath?.trim() || filenameFromEnvOrDefault();
    // Prefer closing previous connection if the API exists (best-effort).
    try {
        void (writer as any).close?.();
    } catch {
        /* ignore */
    }
    try {
        void (reader as any)?.close?.();
    } catch {
        /* ignore */
    }
    reader = null;
    readerPath = null;
    writer = openSqlite(filename);
    return sql;
}

/** Close the shared connections (checkpoints the WAL). Queries after this reject with "Connection closed". */
export async function closeSql(): Promise<void> {
    try {
        await (writer as any).close?.();
    } catch {
        /* already closed */
    }
    try {
        await (reader as any)?.close?.();
    } catch {
        /* already closed */
    }
    reader = null;
    readerPath = null;
}

export function getSqlFilename(): string {
    return currentDbPath;
}
