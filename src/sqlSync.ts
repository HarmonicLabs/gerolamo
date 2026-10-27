/**
 * Synchronous SQLite client with the tagged-template surface Gerolamo uses on `sql`
 * (`await sql\`…\``, `.values()`, `${sql(list)}` IN-list / multi-row expansion, `sql.begin(cb)`,
 * `sql.unsafe(text, params)`, `close()`), backed by `bun:sqlite` prepared statements.
 *
 * Why: Bun's `SQL` client wraps every statement in a query object and a promise and
 * re-parses the tagged template on each call — about 9 % of the applier thread on a fast
 * sync (profile 2026-09-07), on top of the statement itself. SQLite is synchronous; this
 * client runs the statement when the query is first consumed (`await`, `.values()`), or on
 * the next microtask if nobody consumes it (fire-and-forget statements still run), and hands
 * back already-resolved thenables, so `await` at the call sites stays legal and cheap.
 *
 * The default writer since 2026-09-07 (`--no-sync-sql` selects Bun.SQL, see sql.ts); the
 * read-only API connection is unchanged.
 */
import { Database, type Statement } from "bun:sqlite";

type Param = string | number | bigint | boolean | Uint8Array | null;

/** `sql(list)` inside a template: expands to `(?, ?, …)` (or `(?, ?), (?, ?)` for rows). */
class Fragment {
    constructor(readonly value: unknown) {}
}

function toParam(v: unknown): Param {
    if (v === undefined) return null;
    if (v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "bigint") {
        // bun:sqlite binds bigint as INTEGER only within 64 bits; the schema stores larger
        // amounts as text, which is what callers pass for those already.
        return v >= -(1n << 63n) && v < (1n << 63n) ? v : v.toString();
    }
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === "number" || typeof v === "string") return v;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

function expandFragment(f: Fragment, text: string[], params: Param[]): void {
    const v = f.value;
    if (Array.isArray(v)) {
        if (v.length === 0) { text.push("(NULL)"); return; } // IN (NULL) matches nothing, like Bun.SQL's empty list
        if (Array.isArray(v[0])) {
            // rows: (a, b), (c, d)
            const rows: string[] = [];
            for (const row of v as unknown[][]) {
                rows.push(`(${row.map(() => "?").join(", ")})`);
                for (const x of row) params.push(toParam(x));
            }
            text.push(rows.join(", "));
            return;
        }
        // Long lists as one JSON parameter: `IN (?, ?, …)` with a different length per call is a
        // different statement text each time — the per-block DELETE and the rules pre-read carry
        // hundreds of refs, so every block re-prepared a huge statement and thrashed the cache.
        if (v.length > JSON_LIST_MIN && v.every((x) => typeof x === "string" || typeof x === "number")) {
            text.push("(SELECT value FROM json_each(?))");
            params.push(JSON.stringify(v));
            return;
        }
        text.push(`(${v.map(() => "?").join(", ")})`);
        for (const x of v) params.push(toParam(x));
        return;
    }
    if (v && typeof v === "object") {
        // object: "col1", "col2" … VALUES (?, ?) is not used by Gerolamo; treat as one row of values
        const vals = Object.values(v as Record<string, unknown>);
        text.push(`(${vals.map(() => "?").join(", ")})`);
        for (const x of vals) params.push(toParam(x));
        return;
    }
    text.push("?");
    params.push(toParam(v));
}

export interface SyncSqlClient {
    (strings: TemplateStringsArray, ...values: unknown[]): SyncQuery;
    (fragment: unknown): Fragment;
    unsafe(text: string, params?: unknown[]): SyncQuery;
    begin<T>(cb: (tx: SyncSqlClient) => Promise<T> | T): Promise<T>;
    close(): Promise<void>;
    /** True while a `begin` callback runs. */
    readonly inTransaction: boolean;
    readonly filename: string;
    /** The underlying bun:sqlite handle (tests, maintenance). */
    readonly database: Database;
}

type Mode = "all" | "values";

/**
 * Result of a statement: a thenable resolving to the rows (objects), with `.values()` for
 * positional rows. Executes once, at first consumption or on the next microtask.
 */
export class SyncQuery implements PromiseLike<any[]> {
    private done = false;
    private result: any[] | undefined;
    private error: unknown;
    constructor(private readonly exec: (mode: Mode) => any[], private readonly text: string) {
        queueMicrotask(() => { if (!this.done) { try { this.run("all"); } catch { /* reported to the first consumer, or lost like a fire-and-forget Bun.SQL query */ } } });
    }
    private run(mode: Mode): any[] {
        if (this.done) { if (this.error !== undefined) throw this.error; return this.result!; }
        this.done = true;
        try {
            this.result = this.exec(mode);
            return this.result;
        } catch (err) {
            this.error = err;
            throw err;
        }
    }
    then<R1 = any[], R2 = never>(onfulfilled?: ((v: any[]) => R1 | PromiseLike<R1>) | null, onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
        let rows: any[];
        try { rows = this.run("all"); } catch (err) { return Promise.reject(err).then(onfulfilled as any, onrejected); }
        return Promise.resolve(rows).then(onfulfilled as any, onrejected);
    }
    catch<R = never>(onrejected?: ((e: unknown) => R | PromiseLike<R>) | null): Promise<any[] | R> { return this.then(undefined, onrejected); }
    finally(onfinally?: (() => void) | null): Promise<any[]> { return this.then().finally(onfinally); }
    /** Positional rows (`stmt.values`). */
    values(): Promise<any[][]> {
        try { return Promise.resolve(this.run("values") as any[][]); } catch (err) { return Promise.reject(err); }
    }
    raw(): Promise<any[][]> { return this.values(); }
    execute(): Promise<any[]> { return this.then(); }
    toString(): string { return this.text; }
}

const STATEMENT_CACHE_MAX = 512;
/** Lists longer than this bind as one JSON array (see expandFragment). */
const JSON_LIST_MIN = 8;

export function createSyncSqlClient(filename: string, opts: { readonly?: boolean } = {}): SyncSqlClient {
    const db = new Database(filename, opts.readonly ? { readonly: true } : { create: true, readwrite: true });
    // Wait for a transient lock instead of failing the statement (2026-09-09: one SQLITE_BUSY on
    // a plain write during a read-only verify script cost the applier a pipeline reset and the
    // local-root primary; the Bun.SQL reader already waited 10 s).
    try { db.exec("PRAGMA busy_timeout = 10000"); } catch { /* ignore */ }
    const cache = new Map<string, Statement>();
    let inTx = false;

    const prepared = (text: string): Statement => {
        const hit = cache.get(text);
        if (hit) { cache.delete(text); cache.set(text, hit); return hit; } // LRU touch
        const stmt = db.prepare(text);
        cache.set(text, stmt);
        if (cache.size > STATEMENT_CACHE_MAX) {
            const oldest = cache.keys().next().value!;
            try { cache.get(oldest)?.finalize(); } catch { /* ignore */ }
            cache.delete(oldest);
        }
        return stmt;
    };
    const multi = (text: string) => /;\s*\S/.test(text.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, ""));
    const isPlainWrite = (text: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text) && !/\bRETURNING\b/i.test(text);
    const query = (text: string, params: Param[]): SyncQuery =>
        new SyncQuery((mode) => {
            if (params.length === 0 && multi(text)) { db.exec(text); return []; }
            const stmt = prepared(text);
            if (isPlainWrite(text)) {
                // `.count` = rows the statement itself changed (sqlite3_changes: triggers excluded,
                // unlike Bun.SQL's count, which broke a strict check on 2026-09-06).
                const r = stmt.run(...(params as any[]));
                const rows: any[] = [];
                (rows as any).count = Number(r.changes);
                return rows;
            }
            const rows = mode === "values" ? stmt.values(...(params as any[])) : stmt.all(...(params as any[]));
            (rows as any).count = rows.length;
            return rows;
        }, text);

    const client = function (this: unknown, first: unknown, ...values: unknown[]): unknown {
        if (Array.isArray(first) && "raw" in (first as object)) {
            const strings = first as unknown as TemplateStringsArray;
            const text: string[] = [];
            const params: Param[] = [];
            for (let i = 0; i < strings.length; i++) {
                text.push(strings[i]!);
                if (i < values.length) {
                    const v = values[i];
                    if (v instanceof Fragment) expandFragment(v, text, params);
                    else { text.push("?"); params.push(toParam(v)); }
                }
            }
            return query(text.join(""), params);
        }
        return new Fragment(first);
    } as unknown as SyncSqlClient & { [k: string]: unknown };

    Object.defineProperties(client, {
        inTransaction: { get: () => inTx },
        filename: { get: () => filename },
        database: { get: () => db },
    });
    client.unsafe = (text: string, params?: unknown[]) => query(text, (params ?? []).map(toParam));
    client.begin = async <T>(cb: (tx: SyncSqlClient) => Promise<T> | T): Promise<T> => {
        if (inTx) throw new Error("sql.begin: cannot start a transaction within a transaction (a second begin on the shared connection; serialise it)");
        db.exec("BEGIN");
        inTx = true;
        try {
            const out = await cb(client);
            db.exec("COMMIT");
            return out;
        } catch (err) {
            try { db.exec("ROLLBACK"); } catch { /* connection may be gone */ }
            throw err;
        } finally {
            inTx = false;
        }
    };
    client.close = async () => {
        for (const s of cache.values()) { try { s.finalize(); } catch { /* ignore */ } }
        cache.clear();
        try { db.close(); } catch { /* already closed */ }
    };
    return client;
}
