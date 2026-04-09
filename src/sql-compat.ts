// ---------------------------------------------------------------------------
// SQLite-backed drop-in replacement for `import { sql } from "bun"` (Postgres)
//
// The node's db.ts was written against Bun's Postgres tagged template literal.
// This module provides the same API backed by bun:sqlite so the node works
// without a Postgres server.
//
// Supported API surface:
//   sql`SELECT ... WHERE x = ${val}`          — parameterized query
//   sql`SELECT ...`.values()                  — returns rows as array-of-arrays (positional tuples)
//   sql(array)                                — parameter array for IN / batch VALUES
//   sql.begin(async (tx) => { ... })          — transaction
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { resolve } from "path";

const DB_PATH = resolve(
  process.env.GEROLAMO_DB ?? "./ledger/gerolamo.db",
);

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Result wrapper — adds .values() for compat
// ---------------------------------------------------------------------------

class SqlResult extends Array<any> {
  // Override Array.values() to return array-of-arrays (row values) for compat
  values(): any {
    return this.map((row: any) =>
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? Object.values(row)
        : row
    );
  }
}

// ---------------------------------------------------------------------------
// Parameter placeholder for arrays: sql(array)
// Returns a marker that the template literal handler can expand.
// ---------------------------------------------------------------------------

class SqlParams {
  constructor(public readonly rows: any[][]) {}
}

// ---------------------------------------------------------------------------
// Build SQL from tagged template + interpolated values
// ---------------------------------------------------------------------------

interface SqlTag {
  (strings: TemplateStringsArray, ...values: any[]): SqlResult & PromiseLike<SqlResult>;
  (rows: any[][]): SqlParams;
  begin: (fn: (tx: SqlTag) => Promise<void>) => Promise<void>;
}

function buildQuery(
  strings: TemplateStringsArray,
  values: any[],
): { query: string; params: any[] } {
  let query = "";
  const params: any[] = [];

  for (let i = 0; i < strings.length; i++) {
    query += strings[i];
    if (i < values.length) {
      const val = values[i];
      if (val instanceof SqlParams) {
        // Expand array of rows into VALUES (...), (...), ...
        const placeholders = val.rows.map((row) => {
          const rowPlaceholders = row.map(() => {
            params.push(undefined); // placeholder
            return "?";
          });
          // Actually set the params
          const startIdx = params.length - row.length;
          row.forEach((v, j) => {
            params[startIdx + j] = normalizeParam(v);
          });
          return `(${rowPlaceholders.join(", ")})`;
        });
        query += placeholders.join(", ");
      } else if (Array.isArray(val)) {
        // IN clause: expand array
        const placeholders = val.map((v) => {
          params.push(normalizeParam(v));
          return "?";
        });
        query += `(${placeholders.join(", ")})`;
      } else {
        params.push(normalizeParam(val));
        query += "?";
      }
    }
  }

  return { query: query.trim(), params };
}

function normalizeParam(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return v;
}

function execQuery(db: Database, queryStr: string, params: any[], asArrays: boolean = false): SqlResult {
  const result = new SqlResult();

  // No params → use db.exec() which handles multi-statement, triggers, etc.
  if (params.length === 0) {
    try {
      const trimmed = queryStr.trim().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
        const stmt = db.prepare(queryStr);
        const rows = asArrays ? stmt.values() : stmt.all();
        result.push(...rows);
      } else {
        db.exec(queryStr);
      }
    } catch (e: any) {
      if (!e.message?.includes("already exists")) {
        const err = new Error(`SQLite error: ${e.message}\nQuery: ${queryStr.slice(0, 200)}`);
        (err as any).cause = e;
        throw err;
      }
    }
    return result;
  }

  // Parameterized query
  const trimmed = queryStr.trim().toUpperCase();
  const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");

  try {
    if (isSelect) {
      const stmt = db.prepare(queryStr);
      const rows = asArrays ? stmt.values(...params) : stmt.all(...params);
      result.push(...rows);
    } else {
      db.prepare(queryStr).run(...params);
    }
  } catch (e: any) {
    const err = new Error(`SQLite error: ${e.message}\nQuery: ${queryStr.slice(0, 200)}`);
    (err as any).cause = e;
    throw err;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main sql tagged template literal
// ---------------------------------------------------------------------------

function createSqlTag(db: Database): SqlTag {
  const tag: any = function (
    stringsOrRows: TemplateStringsArray | any[][],
    ...values: any[]
  ): SqlResult | SqlParams {
    // Called as sql(array) — parameter builder
    if (!("raw" in stringsOrRows)) {
      return new SqlParams(stringsOrRows as any[][]);
    }

    // Called as sql`...` — execute query
    const { query, params } = buildQuery(
      stringsOrRows as TemplateStringsArray,
      values,
    );

    // Return a proper Promise so `await sql`...`` works
    const promise = new Promise<SqlResult>((resolve, reject) => {
      try {
        resolve(execQuery(db, query, params));
      } catch (e) {
        reject(e);
      }
    });

    // Attach .values() on the promise itself for `(await sql`...`).values()` pattern
    (promise as any).values = () => promise.then((result: SqlResult) => result.values());

    return promise as any;
  };

  tag.begin = async (fn: (tx: SqlTag) => Promise<void>) => {
    db.exec("BEGIN");
    try {
      await fn(createSqlTag(db));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return tag as SqlTag;
}

export const sql: SqlTag = createSqlTag(getDb());
