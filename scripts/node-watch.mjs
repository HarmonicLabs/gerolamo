#!/usr/bin/env bun
/**
 * Live Gerolamo node log + health monitor.
 * Read-only on the live DB. Safe while hydrate owns batch.db.
 *
 * Usage:
 *   bun scripts/node-watch.mjs
 *   bun scripts/node-watch.mjs --once
 *   bun scripts/node-watch.mjs --log /tmp/gerolamo-live-test.log --db .live/test.db
 *   bun scripts/node-watch.mjs --port 3041 --http 3040
 *
 * HTTP (when not --once):
 *   GET /          → full JSON snapshot
 *   GET /health    → { ok, nodeUp, toHexCrashes, tip }
 *   GET /errors    → recent ERROR samples + counts
 *   GET /tail?n=40 → last N log lines
 */
import { resolve } from "node:path";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}

const once = process.argv.includes("--once");
const WORKDIR = resolve(import.meta.dir, "..");
const LOG = resolve(arg("log", "/tmp/gerolamo-live-test.log"));
const DB = resolve(arg("db", resolve(WORKDIR, ".live/test.db")));
const HTTP_NODE = Number(arg("http", "3040"));
const MON_PORT = Number(arg("port", "3041"));
const INTERVAL = Number(arg("interval", "10"));
const MAX_RECENT = 40;
const TAIL_BYTES = 512 * 1024;

/** Classifiers — real crashes vs soft noise */
const RULES = [
  {
    id: "toHex_crash",
    severity: "fatal",
    re: /toHex expects an `Uint8Array`|fromHex expects an hexadecimal/,
  },
  {
    id: "rollForward_throw",
    severity: "error",
    re: /Error processing rollForward/,
  },
  {
    id: "multiplexer",
    severity: "error",
    re: /Multiplexer error/,
  },
  {
    id: "multi_asset",
    severity: "soft",
    re: /Multi-asset balance mismatch|multi-assets balance invalid/,
  },
  {
    id: "utxo_missing",
    severity: "soft",
    re: /UTxO not found|UTxO balance invalid/,
  },
  {
    id: "validity_interval",
    severity: "soft",
    re: /validity interval invalid/,
  },
  {
    id: "soft_apply",
    severity: "soft",
    re: /soft: applying anyway/,
  },
  {
    id: "body_passed",
    severity: "ok",
    re: /Block body validation passed all checks|body validation passed/,
  },
  {
    id: "header_passed",
    severity: "ok",
    re: /Header validation PASSED/,
  },
  {
    id: "applied_block",
    severity: "ok",
    re: /Applied Block:/,
  },
  {
    id: "hot_peer",
    severity: "ok",
    re: /Hot peer syncing|PeerGovernor snapshot/,
  },
  {
    id: "db_tip_fail",
    severity: "warn",
    re: /Failed to get DB tip/,
  },
];

function pgrepNode() {
  try {
    const out = Bun.spawnSync(["pgrep", "-af", "src/index.ts start-gerolamo"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return out.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l && !/pgrep|node-watch/.test(l));
  } catch {
    return [];
  }
}

function pgrepHydrate() {
  try {
    const out = Bun.spawnSync(["pgrep", "-af", "scripts/batch-hydrate"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return out.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l && !/pgrep|node-watch|batch-watch/.test(l));
  } catch {
    return [];
  }
}

function readTail(path, maxBytes = TAIL_BYTES) {
  if (!existsSync(path)) return { err: "log missing", path, text: "" };
  const st = statSync(path);
  const size = st.size;
  const fd = openSync(path, "r");
  try {
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return {
      path,
      bytes: size,
      mtime: st.mtime.toISOString(),
      text: buf.toString("utf8"),
      truncated: start > 0,
    };
  } finally {
    closeSync(fd);
  }
}

function classify(text) {
  const counts = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  const recent = { fatal: [], error: [], soft: [], ok: [] };
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) continue;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      counts[rule.id]++;
      const bucket =
        rule.severity === "fatal"
          ? "fatal"
          : rule.severity === "error"
            ? "error"
            : rule.severity === "ok"
              ? "ok"
              : "soft";
      if (recent[bucket].length < MAX_RECENT) {
        recent[bucket].push(line.slice(0, 240));
      }
    }
  }
  // also count raw levels
  const errorLines = (text.match(/\[ERROR\]/g) || []).length;
  const warnLines = (text.match(/\[WARN/g) || []).length;
  return { counts, recent, errorLines, warnLines };
}

function readDb() {
  if (!existsSync(DB)) return { err: "db missing", path: DB };
  try {
    const db = new Database(DB, { readonly: true });
    const tip = Number(db.query("SELECT MAX(slot) s FROM blocks").get()?.s ?? 0);
    const blocks = Number(
      db.query("SELECT COUNT(*) c FROM blocks").get()?.c ?? 0,
    );
    let utxo = -1;
    try {
      utxo = Number(db.query("SELECT COUNT(*) c FROM utxo").get()?.c ?? 0);
    } catch {
      /* */
    }
    db.close();
    const st = statSync(DB);
    return {
      path: DB,
      tip,
      blocks,
      utxo,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch (e) {
    return { err: String(e?.message || e).slice(0, 160), path: DB };
  }
}

async function probeHttp() {
  const base = `http://127.0.0.1:${HTTP_NODE}`;
  const out = { base, health: null, metrics: null, governor: null, ok: false };
  try {
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    out.health = { status: h.status, body: await h.json().catch(() => null) };
  } catch (e) {
    out.health = { err: String(e?.message || e).slice(0, 80) };
  }
  try {
    const m = await fetch(`${base}/metrics`, {
      signal: AbortSignal.timeout(2500),
    });
    out.metrics = { status: m.status, body: await m.json().catch(() => null) };
  } catch (e) {
    out.metrics = { err: String(e?.message || e).slice(0, 80) };
  }
  try {
    const g = await fetch(`${base}/governor`, {
      signal: AbortSignal.timeout(2500),
    });
    out.governor = { status: g.status, body: await g.json().catch(() => null) };
  } catch (e) {
    out.governor = { err: String(e?.message || e).slice(0, 80) };
  }
  out.ok = out.health?.status === 200 && out.health?.body?.healthy === true;
  return out;
}

function lastLines(text, n = 40) {
  const lines = text.split("\n").filter(Boolean);
  return lines.slice(-n);
}

async function snapshot() {
  const nodeProcs = pgrepNode();
  const hydrateProcs = pgrepHydrate();
  const tail = readTail(LOG);
  const cls = classify(tail.text || "");
  const db = readDb();
  const http = await probeHttp();

  const toHex = cls.counts.toHex_crash || 0;
  const rollThrows = cls.counts.rollForward_throw || 0;
  const soft = cls.counts.soft_apply || 0;
  const applied = cls.counts.applied_block || 0;
  const bodyOk = cls.counts.body_passed || 0;

  const verdict =
    toHex > 0
      ? "FAIL_toHex"
      : !http.ok && nodeProcs.length === 0
        ? "DOWN"
        : !http.ok
          ? "HTTP_DOWN"
          : rollThrows > 0
            ? "DEGRADED_rollForward"
            : "OK";

  return {
    ts: new Date().toISOString(),
    verdict,
    node: {
      running: nodeProcs.length > 0,
      processes: nodeProcs,
      httpOk: http.ok,
      http,
    },
    hydrate: {
      running: hydrateProcs.length > 0,
      processes: hydrateProcs.slice(0, 3),
      note: "hydrate must stay sole writer on batch.db",
    },
    log: {
      path: LOG,
      bytes: tail.bytes ?? 0,
      mtime: tail.mtime ?? null,
      truncated: !!tail.truncated,
      errorLines: cls.errorLines,
      warnLines: cls.warnLines,
      counts: cls.counts,
      recentFatal: cls.recent.fatal.slice(-10),
      recentError: cls.recent.error.slice(-15),
      recentSoft: cls.recent.soft.slice(-10),
    },
    db,
    derived: {
      toHexCrashes: toHex,
      rollForwardThrows: rollThrows,
      softApplies: soft,
      appliedBlocks: applied,
      bodyPassed: bodyOk,
      tipHttp: http.metrics?.body?.tipSlot ?? null,
      tipDb: db.tip ?? null,
      peers: http.metrics?.body?.peers ?? http.governor?.body ?? null,
      note:
        "soft body fails expected mid-chain; toHex/rollForward throws are real bugs",
    },
  };
}

function printHuman(s) {
  const c = s.log.counts;
  console.log(
    JSON.stringify(
      {
        ts: s.ts,
        verdict: s.verdict,
        nodeUp: s.node.running,
        httpOk: s.node.httpOk,
        hydrateUp: s.hydrate.running,
        tipDb: s.derived.tipDb,
        tipHttp: s.derived.tipHttp,
        peers: s.derived.peers,
        counts: {
          toHex: c.toHex_crash,
          rollForward: c.rollForward_throw,
          multiAsset: c.multi_asset,
          utxoMissing: c.utxo_missing,
          softApply: c.soft_apply,
          bodyPassed: c.body_passed,
          applied: c.applied_block,
          headerPassed: c.header_passed,
          ERROR: s.log.errorLines,
          WARN: s.log.warnLines,
        },
        recentError: s.log.recentError.slice(-5),
        recentFatal: s.log.recentFatal.slice(-3),
      },
      null,
      2,
    ),
  );
}

let lastSnap = null;

async function tick() {
  lastSnap = await snapshot();
  printHuman(lastSnap);
  return lastSnap;
}

if (once) {
  await tick();
  process.exit(lastSnap?.verdict === "OK" || lastSnap?.verdict === "DEGRADED_rollForward" ? 0 : 1);
}

console.error(
  `node-watch: log=${LOG} db=${DB} nodeHttp=${HTTP_NODE} mon=:${MON_PORT} every ${INTERVAL}s`,
);

// Never let first snapshot kill the daemon before Bun.serve binds.
try {
  await tick();
} catch (e) {
  console.error("first tick failed (continuing):", e);
}

const server = Bun.serve({
  port: MON_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const s = lastSnap || (await snapshot());
        return Response.json({
          ok: s.verdict === "OK" || s.verdict === "DEGRADED_rollForward",
          verdict: s.verdict,
          nodeUp: s.node.running,
          httpOk: s.node.httpOk,
          toHexCrashes: s.derived.toHexCrashes,
          tip: s.derived.tipHttp ?? s.derived.tipDb,
          ts: s.ts,
        });
      }
      if (url.pathname === "/errors") {
        const s = lastSnap || (await snapshot());
        return Response.json({
          counts: s.log.counts,
          errorLines: s.log.errorLines,
          warnLines: s.log.warnLines,
          recentFatal: s.log.recentFatal,
          recentError: s.log.recentError,
          recentSoft: s.log.recentSoft,
          verdict: s.verdict,
        });
      }
      if (url.pathname === "/tail") {
        const n = Math.min(
          200,
          Math.max(1, Number(url.searchParams.get("n") || 40)),
        );
        const t = readTail(LOG);
        return Response.json({
          path: LOG,
          lines: lastLines(t.text || "", n),
        });
      }
      if (url.pathname === "/" || url.pathname === "/snapshot") {
        const s = await snapshot();
        lastSnap = s;
        return Response.json(s);
      }
      return new Response(
        "node-watch: GET / GET /health GET /errors GET /tail?n=40 GET /snapshot",
        { status: 200 },
      );
    } catch (e) {
      return Response.json(
        { err: String(e?.message || e).slice(0, 200) },
        { status: 500 },
      );
    }
  },
});

console.error(`node-watch HTTP on http://127.0.0.1:${server.port}`);

setInterval(() => {
  void tick().catch((e) => console.error("tick error", e));
}, INTERVAL * 1000);

// Keep the process alive: Bun.serve + interval should suffice, but
// stdin resume + never-resolving promise is belt-and-suspenders for
// environments that drop the event loop after top-level await.
try {
  process.stdin.resume();
} catch {
  /* non-TTY / closed stdin */
}
await new Promise(() => {});
