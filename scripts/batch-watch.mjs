#!/usr/bin/env bun
/**
 * Read-only batch hydrate progress.
 * Does not open batch.db as a writer. Safe while scripts/batch-hydrate.mjs runs.
 *
 * Usage:
 *   bun scripts/batch-watch.mjs
 *   bun scripts/batch-watch.mjs --log /tmp/hermes-batch-full.log --db .hydrate/batch.db
 *   bun scripts/batch-watch.mjs --once
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const once = process.argv.includes("--once");
const WORKDIR = resolve(import.meta.dir, "..");
const LOG = resolve(arg("log", "/tmp/hermes-batch-full.log"));
const DB = resolve(arg("db", resolve(WORKDIR, ".hydrate/batch.db")));
const INTERVAL = Number(arg("interval", "15"));

function pgrepBatch() {
  try {
    const out = Bun.spawnSync(["pgrep", "-af", "scripts/batch-hydrate"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = out.stdout.toString().trim();
    const lines = text
      .split("\n")
      .filter((l) => l && !/pgrep|batch-watch/.test(l));
    return lines;
  } catch {
    return [];
  }
}

function parseLog() {
  if (!existsSync(LOG)) return { err: "log missing", path: LOG };
  const raw = readFileSync(LOG, "utf8");
  const rangeM = raw.match(/"rangeLen":\s*(\d+)/);
  const fromM = raw.match(/"from":\s*(\d+)/);
  const toM = raw.match(/"to":\s*(\d+)/);
  const lines = raw
    .split("\n")
    .filter((l) => l.startsWith("{") && l.includes('"applied"'));
  let last = null;
  for (const l of lines) {
    try {
      last = JSON.parse(l);
    } catch {
      /* */
    }
  }
  const complete = raw.includes("=== Batch Hydrate Complete ===");
  let completeJson = null;
  if (complete) {
    const m = raw.match(
      /=== Batch Hydrate Complete ===\s*\n(\{[\s\S]*?\n\})/,
    );
    if (m) {
      try {
        completeJson = JSON.parse(m[1]);
      } catch {
        /* */
      }
    }
  }
  return {
    path: LOG,
    bytes: statSync(LOG).size,
    mtime: statSync(LOG).mtime.toISOString(),
    rangeLen: rangeM ? Number(rangeM[1]) : null,
    from: fromM ? Number(fromM[1]) : null,
    to: toM ? Number(toM[1]) : null,
    last,
    progressLines: lines.length,
    complete,
    completeJson,
  };
}

function readDb() {
  if (!existsSync(DB)) return { err: "db missing", path: DB };
  try {
    const db = new Database(DB, { readonly: true });
    const tip = db.query("SELECT MAX(slot) s FROM blocks").get()?.s ?? 0;
    const blocks = db.query("SELECT COUNT(*) c FROM blocks").get()?.c ?? 0;
    let utxo = -1;
    let deltas = -1;
    try {
      utxo = db.query("SELECT COUNT(*) c FROM utxo").get()?.c ?? 0;
    } catch {
      /* */
    }
    try {
      deltas = db.query("SELECT COUNT(*) c FROM utxo_deltas").get()?.c ?? 0;
    } catch {
      /* */
    }
    db.close();
    const st = statSync(DB);
    return {
      path: DB,
      tip: Number(tip),
      blocks: Number(blocks),
      utxo: Number(utxo),
      deltas: Number(deltas),
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch (e) {
    return { err: String(e?.message || e).slice(0, 120), path: DB };
  }
}

function report() {
  const procs = pgrepBatch();
  const log = parseLog();
  const db = readDb();
  const last = log.last || {};
  const done =
    (last.applied ?? 0) + (last.failed ?? 0) ||
    (log.completeJson
      ? (log.completeJson.applied ?? 0) + (log.completeJson.failed ?? 0)
      : 0);
  const total = log.rangeLen || 0;
  const sec = Number(last.secPerChunk ?? log.completeJson?.secPerChunk ?? 0);
  const rem = total > 0 ? Math.max(total - done, 0) : null;
  const etaH =
    rem != null && sec > 0 ? Number(((rem * sec) / 3600).toFixed(2)) : null;
  const pct =
    total > 0 && done >= 0 ? Number(((100 * done) / total).toFixed(2)) : null;

  const out = {
    ts: new Date().toISOString(),
    running: procs.length > 0,
    processes: procs,
    log: {
      path: log.path,
      mtime: log.mtime,
      complete: log.complete,
      from: log.from,
      to: log.to,
      rangeLen: log.rangeLen,
      lastChunk: last.chunk ?? log.completeJson?.to,
      applied: last.applied ?? log.completeJson?.applied,
      failed: last.failed ?? log.completeJson?.failed,
      tipLog: last.tip ?? log.completeJson?.tip,
      utxoLog: last.utxo ?? log.completeJson?.utxo,
      secPerChunk: sec || null,
      chunksPerSec: last.chunksPerSec ?? log.completeJson?.chunksPerSec,
      progressLines: log.progressLines,
    },
    db,
    derived: {
      done,
      total: total || null,
      pct,
      remaining: rem,
      etaHours_from_latest_rate: etaH,
      note:
        "ETA uses latest secPerChunk; late chain usually slower as UTxO grows",
    },
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (once) {
  report();
  process.exit(0);
}

console.error(
  `batch-watch: log=${LOG} db=${DB} every ${INTERVAL}s (Ctrl-C to stop)`,
);
report();
setInterval(report, Math.max(5, INTERVAL) * 1000);
