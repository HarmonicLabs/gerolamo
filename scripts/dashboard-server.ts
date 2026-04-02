import { Database } from "bun:sqlite";
import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "3050" },
    db: { type: "string", default: "./ledger/gerolamo.db" },
    "node-url": { type: "string", default: "http://localhost:3030" },
    "static-dir": { type: "string", default: "" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`Gerolamo Dashboard Server

Usage: bun run scripts/dashboard-server.ts [options]

Options:
  --port <n>         Server port (default: 3050)
  --db <path>        SQLite database path (default: ./ledger/gerolamo.db)
  --node-url <url>   Gerolamo node URL (default: http://localhost:3030)
  --static-dir <dir> Serve built dashboard from this directory
  --help             Show this help
`);
  process.exit(0);
}

const PORT = parseInt(args.port!, 10);
const DB_PATH = resolve(args.db!);
const NODE_URL = args["node-url"]!;
const STATIC_DIR = args["static-dir"] ? resolve(args["static-dir"]) : "";

let db: Database | null = null;
let dbMissing = false;
function getDb(): Database | null {
  if (dbMissing) return null;
  if (!db) {
    if (!existsSync(DB_PATH)) {
      dbMissing = true;
      console.warn(`Database not found at ${DB_PATH} — API will return empty data until node starts`);
      return null;
    }
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

const startTime = Date.now();

// SSE clients
const sseClients = new Map<string, Set<ReadableStreamDefaultController>>();
function addSSEClient(channel: string, controller: ReadableStreamDefaultController) {
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel)!.add(controller);
}
function removeSSEClient(channel: string, controller: ReadableStreamDefaultController) {
  sseClients.get(channel)?.delete(controller);
}
function broadcastSSE(channel: string, data: unknown) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  const clients = sseClients.get(channel);
  if (!clients) return;
  for (const c of clients) {
    try { c.enqueue(new TextEncoder().encode(msg)); } catch { clients.delete(c); }
  }
}

// Poll node state and broadcast
let lastTipSlot = 0;
async function pollAndBroadcast() {
  try {
    const status = buildStatus();
    broadcastSSE("status", status);
    if (status.tip.slot !== lastTipSlot) {
      lastTipSlot = status.tip.slot;
      const blocks = queryRecentBlocks(1);
      if (blocks.length > 0) broadcastSSE("blocks", blocks[0]);
    }
    const logs = queryLogs("INFO", 10);
    if (logs.length > 0) broadcastSSE("logs", logs);
  } catch {}
}
setInterval(pollAndBroadcast, 2000);

const EMPTY_STATUS = {
  tip: { slot: 0, hash: "", epoch: 0, era: 0 },
  sync: { progress: 0, speed: 0, startedAt: new Date().toISOString() },
  uptime: 0, network: process.env.NETWORK ?? "preprod",
  volatileBlocks: 0, immutableBlocks: 0, utxoCount: 0, mempoolSize: 0, gcCycles: 0,
};

function buildStatus() {
  const d = getDb();
  if (!d) return { ...EMPTY_STATUS, uptime: Date.now() - startTime };
  const tipRow = d.query("SELECT MAX(slot) as slot FROM blocks").get() as any;
  const tipSlot = tipRow?.slot ?? 0;

  const blockRow = d.query("SELECT hash, prev_hash, slot FROM blocks WHERE slot = ?").get(tipSlot) as any;
  const tipHash = blockRow?.hash ?? "";

  const volatileCount = (d.query("SELECT COUNT(*) as c FROM blocks").get() as any)?.c ?? 0;
  const immutableCount = (d.query("SELECT COUNT(*) as c FROM immutable_blocks").get() as any)?.c ?? 0;
  const utxoCount = (d.query("SELECT COUNT(*) as c FROM utxo").get() as any)?.c ?? 0;

  let mempoolSize = 0;
  let treasury = 0;
  let reserves = 0;
  try {
    const cas = d.query("SELECT treasury, reserves FROM chain_account_state WHERE id = 1").get() as any;
    treasury = cas?.treasury ?? 0;
    reserves = cas?.reserves ?? 0;
  } catch {}

  const epoch = tipSlot > 0 ? Math.floor((tipSlot - 86400) / 432000) + 208 : 0; // preprod approx
  const era = 6; // Conway current era

  return {
    tip: { slot: tipSlot, hash: typeof tipHash === "string" ? tipHash : "", epoch, era },
    sync: { progress: 0, speed: 0, startedAt: new Date(startTime).toISOString() },
    uptime: Date.now() - startTime,
    network: process.env.NETWORK ?? "preprod",
    volatileBlocks: volatileCount,
    immutableBlocks: immutableCount,
    utxoCount,
    mempoolSize,
    gcCycles: 0,
  };
}

function queryRecentBlocks(limit: number) {
  const d = getDb();
  if (!d) return [];
  const rows = d.query(`
    SELECT slot, hash, prev_hash, inserted_at
    FROM blocks
    ORDER BY slot DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((r: any) => ({
    slot: r.slot,
    hash: typeof r.hash === "string" ? r.hash : Buffer.from(r.hash).toString("hex"),
    prevHash: typeof r.prev_hash === "string" ? r.prev_hash : (r.prev_hash ? Buffer.from(r.prev_hash).toString("hex") : ""),
    era: 6,
    epoch: r.slot > 0 ? Math.floor((r.slot - 86400) / 432000) + 208 : 0,
    txCount: 0,
    size: 0,
    insertedAt: r.inserted_at ? new Date(Number(r.inserted_at) * 1000).toISOString() : new Date().toISOString(),
  }));
}

function queryPeers() {
  // Peers are in-memory in the running node, not in DB.
  // Proxy to the node if available, otherwise return empty.
  return [];
}

function queryLogs(level: string, limit: number) {
  // Read from log files if they exist
  const logDir = resolve("./logs");
  const levelMap: Record<string, string[]> = {
    DEBUG: ["debug.jsonl", "info.jsonl", "warn.jsonl", "error.jsonl"],
    INFO: ["info.jsonl", "warn.jsonl", "error.jsonl"],
    WARN: ["warn.jsonl", "error.jsonl"],
    ERROR: ["error.jsonl"],
  };
  const files = levelMap[level] ?? ["info.jsonl"];
  const entries: Array<{ timestamp: string; level: string; message: string }> = [];

  for (const file of files) {
    const p = join(logDir, file);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8");
      const lines = content.trim().split("\n").slice(-limit);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          entries.push({
            timestamp: entry.timestamp ?? new Date().toISOString(),
            level: entry.level ?? file.replace(".jsonl", "").toUpperCase(),
            message: entry.message ?? entry.msg ?? line,
          });
        } catch {
          entries.push({ timestamp: new Date().toISOString(), level: "INFO", message: line });
        }
      }
    } catch {}
  }

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

function queryUtxos(q: string) {
  const d = getDb();
  if (!d || !q) return [];

  // utxo ref format: hash:idx
  if (/^[0-9a-f]{64}:\d+$/i.test(q)) {
    const rows = d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE utxo_ref = ?").all(q) as any[];
    return rows.map(parseUtxoRow);
  }

  // tx hash
  if (/^[0-9a-f]{64}$/i.test(q)) {
    const rows = d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE tx_hash = ? ORDER BY utxo_ref LIMIT 100").all(q) as any[];
    return rows.map(parseUtxoRow);
  }

  // prefix search on tx_hash
  const rows = d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE tx_hash LIKE ? LIMIT 100").all(`${q}%`) as any[];
  return rows.map(parseUtxoRow);
}

function parseUtxoRow(row: any) {
  const ref = typeof row.utxo_ref === "string" ? row.utxo_ref : "";
  const parts = ref.split(":");
  let txOut: any = {};
  try { txOut = typeof row.tx_out === "string" ? JSON.parse(row.tx_out) : row.tx_out; } catch {}
  return {
    ref,
    txHash: parts[0] ?? row.tx_hash ?? "",
    outputIndex: parseInt(parts[1] ?? "0", 10),
    address: txOut.address ?? "",
    amount: txOut.amount ?? "0",
    assets: txOut.assets ?? {},
  };
}

function queryRecentDeltas(limit: number) {
  const d = getDb();
  if (!d) return [];
  const rows = d.query(`
    SELECT id, block_hash, action, utxo, created_at
    FROM utxo_deltas
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((r: any) => ({
    id: r.id,
    blockHash: typeof r.block_hash === "string" ? r.block_hash : (r.block_hash ? Buffer.from(r.block_hash).toString("hex") : ""),
    action: r.action,
    utxo: typeof r.utxo === "string" ? r.utxo : JSON.stringify(r.utxo),
    createdAt: r.created_at ?? new Date().toISOString(),
  }));
}

function queryChainState() {
  const d = getDb();
  if (!d) return { treasury: 0, reserves: 0, poolCount: 0, stakeCount: 0, delegationCount: 0 };
  let treasury = 0, reserves = 0;
  try {
    const cas = d.query("SELECT treasury, reserves FROM chain_account_state WHERE id = 1").get() as any;
    treasury = cas?.treasury ?? 0;
    reserves = cas?.reserves ?? 0;
  } catch {}

  let poolCount = 0;
  try {
    const pd = d.query("SELECT pools FROM pool_distr WHERE id = 1").get() as any;
    if (pd?.pools) {
      const pools = typeof pd.pools === "string" ? JSON.parse(pd.pools) : pd.pools;
      poolCount = Array.isArray(pools) ? pools.length : 0;
    }
  } catch {}

  const stakeCount = (d.query("SELECT COUNT(*) as c FROM stake").get() as any)?.c ?? 0;
  const delegationCount = (d.query("SELECT COUNT(*) as c FROM delegations").get() as any)?.c ?? 0;

  return { treasury, reserves, poolCount, stakeCount, delegationCount };
}

function createSSEStream(channel: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      addSSEClient(channel, controller);
      controller.enqueue(new TextEncoder().encode(":ok\n\n"));
    },
    cancel(controller) {
      removeSSEClient(channel, controller as any);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // API routes
    if (path === "/api/status") {
      try { return json(buildStatus()); }
      catch (e: any) { return json({ error: e.message }, 500); }
    }

    if (path === "/api/peers") {
      return json(queryPeers());
    }

    if (path === "/api/blocks") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      try { return json(queryRecentBlocks(limit)); }
      catch (e: any) { return json({ error: e.message }, 500); }
    }

    if (path === "/api/logs") {
      const level = url.searchParams.get("level") ?? "INFO";
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      return json(queryLogs(level, limit));
    }

    if (path === "/api/utxo") {
      const q = url.searchParams.get("q") ?? "";
      try { return json(queryUtxos(q)); }
      catch (e: any) { return json({ error: e.message }, 500); }
    }

    if (path === "/api/deltas") {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      try { return json(queryRecentDeltas(limit)); }
      catch (e: any) { return json({ error: e.message }, 500); }
    }

    if (path === "/api/chain-state") {
      try { return json(queryChainState()); }
      catch (e: any) { return json({ error: e.message }, 500); }
    }

    // SSE endpoints
    if (path === "/api/sse/status") return createSSEStream("status");
    if (path === "/api/sse/blocks") return createSSEStream("blocks");
    if (path === "/api/sse/logs") return createSSEStream("logs");

    // Static files (built dashboard)
    if (STATIC_DIR) {
      let filePath = path === "/" ? "/index.html" : path;
      const file = Bun.file(join(STATIC_DIR, filePath));
      if (await file.exists()) {
        return new Response(file);
      }
      // SPA fallback
      const index = Bun.file(join(STATIC_DIR, "index.html"));
      if (await index.exists()) {
        return new Response(index);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`
┌─────────────────────────────────────────┐
│  GEROLAMO DASHBOARD SERVER              │
├─────────────────────────────────────────┤
│  API:     http://localhost:${PORT}/api   │
│  SSE:     http://localhost:${PORT}/api/sse│
│  DB:      ${DB_PATH}                     │
│  Node:    ${NODE_URL}                    │
${STATIC_DIR ? `│  Static:  ${STATIC_DIR}\n` : ""}└─────────────────────────────────────────┘
`);
