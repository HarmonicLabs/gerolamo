#!/usr/bin/env bun
/**
 * Batch A3 hydrate path — separate DB, one BEGIN/COMMIT per chunk, bulk pragmas.
 *
 * Does NOT touch .hydrate/full.db (leave running A3 alone).
 *
 * Usage:
 *   bun scripts/batch-hydrate.mjs --from 50 --to 52
 *   bun scripts/batch-hydrate.mjs --from 50 --limit 5
 *   bun scripts/batch-hydrate.mjs --db .hydrate/batch.db --from 50 --limit 10
 *
 * Soft apply only (same as A3): no VRF/KES/script proof; block CBOR not stored.
 */
import { resolve } from "node:path";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const WORKDIR = resolve(import.meta.dir, "..");
const IMMUTABLE = resolve(
  arg("chunks", resolve(WORKDIR, "snapshots/preprod/db/immutable")),
);
const DB_PATH = resolve(arg("db", resolve(WORKDIR, ".hydrate/batch.db")));
const fromChunk = Number(arg("from", "50"));
const toArg = arg("to", null);
const limit = arg("limit", null) != null ? Number(arg("limit")) : null;
const wipe = hasFlag("wipe");
const PROGRESS_EVERY = Number(arg("progress", "1"));

process.chdir(WORKDIR);
process.env.GEROLAMO_DB_PATH = DB_PATH;
process.env.DATABASE_URL = `sqlite://${DB_PATH}`;

if (wipe && existsSync(DB_PATH)) {
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      unlinkSync(p);
    } catch {
      /* */
    }
  }
  console.log("wiped", DB_PATH);
}

mkdirSync(resolve(DB_PATH, ".."), { recursive: true });

// IMPORTANT: do not destructure `sql` before initSql — init closes the old handle.
// Use the returned client (and/or sqlMod.sql after init) for all writes.
const sqlMod = await import(resolve(WORKDIR, "src/sql.ts"));
const sql = sqlMod.initSql(DB_PATH);

// One-shot hydrate pragmas (disposable / rebuildable DB)
for (const q of [
  "PRAGMA journal_mode=WAL",
  "PRAGMA synchronous=OFF",
  "PRAGMA temp_store=MEMORY",
  "PRAGMA cache_size=-128000", // ~128MB
  "PRAGMA mmap_size=536870912", // 512MB
  "PRAGMA busy_timeout=5000",
]) {
  try {
    await sql.unsafe(q);
  } catch (e) {
    console.warn("pragma fail", q, e.message?.slice?.(0, 80) ?? e);
  }
}

// Import db/legacy AFTER initSql so module sql binding is the batch DB.
const { ensureInitialized, getMaxSlot, getUtxoCount } = await import(
  resolve(WORKDIR, "src/db.ts")
);
const { processChunk } = await import(resolve(WORKDIR, "src/state/legacy.ts"));
const { logger, LogLevel } = await import(
  resolve(WORKDIR, "src/utils/logger.ts")
);
try {
  logger.setLogLevel(LogLevel.NONE);
} catch {
  /* */
}

const chunkLogger = {
  info: () => {},
  debug: () => {},
  warn: (...a) => console.warn("[chunk-warn]", ...a),
  error: (...a) => console.error("[chunk-err]", ...a),
};

await ensureInitialized();

// Seed treasury row so fee UPDATEs don't no-op forever
try {
  await sql`INSERT OR IGNORE INTO chain_account_state (id, treasury, reserves) VALUES (1, 0, 0)`;
} catch {
  /* schema may use AUTOINCREMENT only — best effort */
  try {
    const rows = await sql`SELECT id FROM chain_account_state LIMIT 1`;
    if (!rows?.length) {
      await sql`INSERT INTO chain_account_state (treasury, reserves) VALUES (0, 0)`;
    }
  } catch {
    /* */
  }
}

const names = await readdir(IMMUTABLE);
const chunkNos = [
  ...new Set(
    names
      .map((v) =>
        parseInt(v.replace(/\.(primary|secondary|chunk)$/, ""), 10),
      )
      .filter((n) => Number.isFinite(n) && n >= 0),
  ),
].sort((a, b) => a - b);

const maxOnDisk = chunkNos[chunkNos.length - 1] ?? -1;
const toChunk =
  toArg != null
    ? Number(toArg)
    : limit != null
      ? fromChunk + Number(limit) - 1
      : maxOnDisk;
const range = chunkNos.filter((n) => n >= fromChunk && n <= toChunk);

console.log(
  JSON.stringify(
    {
      mode: "batch-hydrate",
      db: DB_PATH,
      immutable: IMMUTABLE,
      from: fromChunk,
      to: toChunk,
      rangeLen: range.length,
      wipe,
      tip0: String(await getMaxSlot()),
      utxo0: await getUtxoCount(),
    },
    null,
    2,
  ),
);

if (!range.length) {
  console.log("Nothing to do");
  process.exit(0);
}

const t0 = Date.now();
let applied = 0;
let failed = 0;
const failSamples = [];

// Absolute chain size (all immutable chunk numbers on disk), not session range.
// Resume --from N still reports done/total against the full dataset.
const chainTotal = chunkNos.length;
const chunkIndex = new Map(chunkNos.map((n, idx) => [n, idx]));
const sessionTotal = range.length;

async function progress(i) {
  const ms = Date.now() - t0;
  const tip = String(await getMaxSlot());
  const utxo = await getUtxoCount();
  const sessionDone = applied + failed;
  // 1-based absolute position of this chunk in the full on-disk set
  const doneAbs = (chunkIndex.get(i) ?? -1) + 1;
  const rate = sessionDone / (ms / 1000 || 1);
  console.log(
    JSON.stringify({
      chunk: i,
      // absolute completed-through index (matches from-0 applied semantics)
      applied: doneAbs,
      sessionApplied: applied,
      failed,
      total: chainTotal,
      remaining: Math.max(chainTotal - doneAbs, 0),
      pct: chainTotal
        ? Number(((100 * doneAbs) / chainTotal).toFixed(2))
        : null,
      sessionTotal,
      tip,
      utxo,
      ms,
      chunksPerSec: Number(rate.toFixed(3)),
      secPerChunk: sessionDone
        ? Number((ms / 1000 / sessionDone).toFixed(2))
        : null,
    }),
  );
}

for (const i of range) {
  try {
    // One transaction per chunk — all block/tx writes share this handle.
    // apply* use optional client and must NOT nest sql.begin().
    await sql.begin(async (tx) => {
      await processChunk(IMMUTABLE, i, chunkLogger, tx);
    });
    applied++;
  } catch (e) {
    failed++;
    if (failSamples.length < 12) {
      failSamples.push({ i, err: e?.message || String(e) });
    }
    console.error(
      JSON.stringify({
        chunk: i,
        err: String(e?.message || e).slice(0, 200),
      }),
    );
  }
  if (
    applied + failed === 1 ||
    (applied + failed) % PROGRESS_EVERY === 0 ||
    i === range[range.length - 1]
  ) {
    await progress(i);
  }
}

const doneFinal = applied + failed;
const lastChunk = range[range.length - 1];
const doneAbsFinal =
  lastChunk != null ? (chunkIndex.get(lastChunk) ?? -1) + 1 : doneFinal;
const result = {
  ok: failed === 0,
  mode: "batch",
  db: DB_PATH,
  from: fromChunk,
  to: toChunk,
  applied: doneAbsFinal,
  sessionApplied: applied,
  failed,
  total: chainTotal,
  remaining: Math.max(chainTotal - doneAbsFinal, 0),
  pct: chainTotal
    ? Number(((100 * doneAbsFinal) / chainTotal).toFixed(2))
    : null,
  sessionTotal,
  failSamples,
  tip: String(await getMaxSlot()),
  utxo: await getUtxoCount(),
  ms: Date.now() - t0,
  secPerChunk:
    doneFinal
      ? Number(((Date.now() - t0) / 1000 / doneFinal).toFixed(2))
      : null,
  chunksPerSec: Number(
    (doneFinal / ((Date.now() - t0) / 1000 || 1)).toFixed(3),
  ),
};
console.log("\n=== Batch Hydrate Complete ===");
console.log(JSON.stringify(result, null, 2));
process.exit(failed === 0 ? 0 : 1);
