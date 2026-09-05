#!/usr/bin/env bun
/**
 * Sync race: sample several nodes' chain tips on one clock and report when each
 * crossed fixed block heights, so different implementations can be compared on
 * the same machine against the same upstream.
 *
 *   bun scripts/sync-race.mjs \
 *     --gerolamo http://127.0.0.1:3030 \
 *     --dingo    http://127.0.0.1:12798 \
 *     --amaru    /media/bakon/data/cardano/amaru/logs/amaru-run.log \
 *     --every 10 --out /tmp/sync-race.csv \
 *     --milestones 100000,500000,1000000,2000000,4490511,5000000
 *
 * Sources:
 *   --gerolamo <http base>   GET /api/v0/blocks/latest → height, slot
 *   --dingo    <metrics url> Prometheus cardano_node_metrics_blockNum_int / slotNum_int
 *   --amaru    <log file>    Amaru has no metrics endpoint; the newest
 *                            `slot=<n>` / `"slot":<n>` in its log is its tip slot (height unknown)
 *
 * Output: one CSV row per sample (ts, node, height, slot) plus, on Ctrl-C or
 * --duration, a table of wall-clock seconds to each milestone height per node
 * and the average blocks/s over the run.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const every = Number(opt("every", "10")) * 1000;
const durationSec = Number(opt("duration", "0"));
const out = opt("out", null);
const milestones = String(opt("milestones", "100000,500000,1000000,2000000,3000000,4490511,5000000,6000000"))
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

const sources = [];
if (opt("gerolamo")) sources.push({ name: "gerolamo", kind: "gerolamo", target: opt("gerolamo").replace(/\/$/, "") });
if (opt("dingo")) sources.push({ name: "dingo", kind: "prom", target: opt("dingo").replace(/\/$/, "") });
if (opt("amaru")) sources.push({ name: "amaru", kind: "log", target: opt("amaru") });
if (sources.length === 0) {
  console.error("no sources; pass --gerolamo <url>, --dingo <url> and/or --amaru <log>");
  process.exit(2);
}

async function sampleGerolamo(base) {
  const r = await fetch(`${base}/api/v0/blocks/latest`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  return { height: b.height ?? null, slot: b.slot ?? null };
}

async function sampleProm(base) {
  const r = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  const pick = (name) => {
    const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\d+(?:\\.\\d+)?)`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { height: pick("cardano_node_metrics_blockNum_int"), slot: pick("cardano_node_metrics_slotNum_int") };
}

/** Newest slot mentioned in the last 64 KB of a log file. */
function sampleLog(path) {
  const size = statSync(path).size;
  const from = Math.max(0, size - 65536);
  const buf = Buffer.alloc(size - from);
  const fd = require("node:fs").openSync(path, "r");
  try {
    require("node:fs").readSync(fd, buf, 0, buf.length, from);
  } finally {
    require("node:fs").closeSync(fd);
  }
  const text = buf.toString("utf8");
  // Amaru: INFO tip.adopt lines carry block_height and slot (JSON or text traces).
  let slot = null;
  let height = null;
  for (const m of text.matchAll(/(?:\bslot[=:"\s]+|"slot":\s*)(\d{3,})/g)) slot = Number(m[1]);
  for (const m of text.matchAll(/block_height[=:"\s]+(\d+)/g)) height = Number(m[1]);
  return { height, slot };
}

const start = Date.now();
const state = new Map(sources.map((s) => [s.name, { first: null, last: null, firstAt: 0, lastAt: 0, hit: new Map(), errors: 0 }]));

async function tick() {
  const now = Date.now();
  const line = [];
  for (const s of sources) {
    const st = state.get(s.name);
    let v;
    try {
      v = s.kind === "gerolamo" ? await sampleGerolamo(s.target) : s.kind === "prom" ? await sampleProm(s.target) : sampleLog(s.target);
    } catch (e) {
      st.errors++;
      line.push(`${s.name}: — (${e.message})`);
      continue;
    }
    if (v.height != null) {
      if (st.first == null) { st.first = v.height; st.firstAt = now; }
      st.last = v.height; st.lastAt = now;
      for (const m of milestones) if (!st.hit.has(m) && v.height >= m) st.hit.set(m, now);
    }
    line.push(`${s.name}: h=${v.height ?? "?"} s=${v.slot ?? "?"}`);
    if (out) appendFileSync(out, `${new Date(now).toISOString()},${s.name},${v.height ?? ""},${v.slot ?? ""}\n`);
  }
  console.log(`[${Math.round((now - start) / 1000)}s] ${line.join("  |  ")}`);
}

function report() {
  console.log("\nSeconds from start to each block height:");
  const head = ["height", ...sources.map((s) => s.name)];
  console.log(head.join("\t"));
  for (const m of milestones) {
    const row = [m];
    for (const s of sources) {
      const at = state.get(s.name).hit.get(m);
      row.push(at ? Math.round((at - start) / 1000) : "—");
    }
    console.log(row.join("\t"));
  }
  console.log("\nAverage blocks/s over the run:");
  for (const s of sources) {
    const st = state.get(s.name);
    if (st.first == null || st.lastAt === st.firstAt) { console.log(`${s.name}\t—`); continue; }
    console.log(`${s.name}\t${((st.last - st.first) / ((st.lastAt - st.firstAt) / 1000)).toFixed(1)}\t(${st.first} → ${st.last}, ${st.errors} failed samples)`);
  }
}

if (out) appendFileSync(out, "");
process.on("SIGINT", () => { report(); process.exit(0); });
await tick();
const timer = setInterval(() => void tick(), every);
if (durationSec > 0) setTimeout(() => { clearInterval(timer); report(); process.exit(0); }, durationSec * 1000);
