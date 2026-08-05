import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Shared SQLite SQL client for Gerolamo.
 *
 * Bun's default `import { sql } from "bun"` is Postgres. Gerolamo stores
 * chain state in SQLite (config.dbPath / DATABASE_URL / ./.live/test.db).
 *
 * Call `initSql(dbPath)` from start() before ensureInitialized().
 * Live ES-module binding: reassignment after init is visible to all importers.
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

function openSqlite(filename: string): SQL {
    const abs = resolve(filename);
    mkdirSync(dirname(abs), { recursive: true });
    currentDbPath = abs;
    return new SQL({ adapter: "sqlite", filename: abs });
}

/** Live binding — reassigned by initSql(). */
export let sql: SQL = openSqlite(filenameFromEnvOrDefault());

export function initSql(dbPath?: string): SQL {
    const filename = dbPath?.trim() || filenameFromEnvOrDefault();
    // Prefer closing previous connection if the API exists (best-effort).
    try {
        void (sql as any).close?.();
    } catch {
        /* ignore */
    }
    sql = openSqlite(filename);
    return sql;
}

export function getSqlFilename(): string {
    return currentDbPath;
}
