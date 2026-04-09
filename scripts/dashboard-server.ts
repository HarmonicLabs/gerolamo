// ---------------------------------------------------------------------------
// Gerolamo Dashboard Server
// Serves REST API + SSE + static dashboard build.
// WebSocket↔TCP proxying is handled by websockify (noVNC/websockify) as a
// separate service — see gerolamo-start.ts for orchestration.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { parseArgs } from "util";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "3050" },
    db: { type: "string", default: "./ledger/gerolamo.db" },
    "node-url": { type: "string", default: "http://localhost:3030" },
    "static-dir": { type: "string", default: "./dashboard/dist" },
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
let dbMissingLastCheck = 0;
function getDb(): Database | null {
  if (dbMissing) {
    // Re-check every 5 seconds in case the node creates the DB
    if (Date.now() - dbMissingLastCheck < 5000) return null;
    dbMissingLastCheck = Date.now();
    if (!existsSync(DB_PATH)) return null;
    dbMissing = false;
    console.log(`[dashboard] Database found at ${DB_PATH} — connecting`);
  }
  if (!db) {
    if (!existsSync(DB_PATH)) {
      dbMissing = true;
      dbMissingLastCheck = Date.now();
      console.warn(`[dashboard] Database not found at ${DB_PATH} — returning empty data until node starts`);
      return null;
    }
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

const startTime = Date.now();

// Speed tracking
let speedHistory: { slot: number; time: number }[] = [];
let lastKnownSpeed = 0;

function calculateSpeed(currentSlot: number): number {
  const now = Date.now();
  speedHistory.push({ slot: currentSlot, time: now });
  speedHistory = speedHistory.filter((s) => now - s.time < 30000);
  if (speedHistory.length < 2) return lastKnownSpeed;
  const oldest = speedHistory[0];
  const newest = speedHistory[speedHistory.length - 1];
  const timeDiffMin = (newest.time - oldest.time) / 60000;
  if (timeDiffMin <= 0) return lastKnownSpeed;
  lastKnownSpeed = Math.round((newest.slot - oldest.slot) / timeDiffMin);
  return lastKnownSpeed;
}

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

// Preprod genesis: slot 0 at epoch 208 boundary, 1s slots, 432000 per epoch
const PREPROD_GENESIS_TIME = 1654041600;
function estimateNetworkTipSlot(): number {
  return Math.floor(Date.now() / 1000) - PREPROD_GENESIS_TIME;
}

// Poll and broadcast
let lastTipSlot = 0;
let lastPeerState = "";
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

    // Broadcast peer changes
    const peers = getTopologyPeers();
    const peerState = JSON.stringify(peers.map((p: any) => `${p.id}:${p.connected}`));
    if (peerState !== lastPeerState) {
      lastPeerState = peerState;
      broadcastSSE("peers", peers);
    }

    // Broadcast mempool
    const mempool = queryMempool();
    if (mempool.length > 0) broadcastSSE("mempool", mempool);
  } catch {}
}
setInterval(pollAndBroadcast, 2000);

const EMPTY_STATUS = {
  tip: { slot: 0, hash: "", epoch: 0, era: 0 },
  sync: { progress: 0, speed: 0, startedAt: new Date().toISOString() },
  uptime: 0, network: "preprod",
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

  const networkTip = estimateNetworkTipSlot();
  const progress = networkTip > 0 ? Math.min(1, Math.max(0, tipSlot / networkTip)) : 0;
  const speed = calculateSpeed(tipSlot);

  let gcCycles = 0;
  try {
    const ss = d.query("SELECT total_blocks FROM stable_state WHERE id = 1").get() as any;
    gcCycles = ss?.total_blocks ?? 0;
  } catch {}

  const epoch = tipSlot > 0 ? Math.floor((tipSlot - 86400) / 432000) + 208 : 0;

  let mempoolSize = 0;
  try {
    // Check if mempool table exists and count entries
    const mempoolTable = d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mempool'").get();
    if (mempoolTable) {
      mempoolSize = (d.query("SELECT COUNT(*) as c FROM mempool").get() as any)?.c ?? 0;
    }
  } catch {}

  return {
    tip: { slot: tipSlot, hash: typeof tipHash === "string" ? tipHash : "", epoch, era: 6 },
    sync: { progress, speed, startedAt: new Date(startTime).toISOString() },
    uptime: Date.now() - startTime,
    network: "preprod",
    volatileBlocks: volatileCount,
    immutableBlocks: immutableCount,
    utxoCount,
    mempoolSize,
    gcCycles,
  };
}

function queryRecentBlocks(limit: number) {
  const d = getDb();
  if (!d) return [];
  const rows = d.query(`
    SELECT slot, hash, prev_hash, block_data, block_fetch_RawCbor, inserted_at
    FROM blocks ORDER BY slot DESC LIMIT ?
  `).all(limit) as any[];

  return rows.map((r: any) => {
    const hashHex = typeof r.hash === "string" ? r.hash : Buffer.from(r.hash).toString("hex");
    const prevHashHex = typeof r.prev_hash === "string" ? r.prev_hash : (r.prev_hash ? Buffer.from(r.prev_hash).toString("hex") : "");

    // Get block size from the raw CBOR blob
    let size = 0;
    if (r.block_fetch_RawCbor instanceof Uint8Array || Buffer.isBuffer(r.block_fetch_RawCbor)) {
      size = r.block_fetch_RawCbor.byteLength ?? r.block_fetch_RawCbor.length ?? 0;
    } else if (r.block_data instanceof Uint8Array || Buffer.isBuffer(r.block_data)) {
      size = r.block_data.byteLength ?? r.block_data.length ?? 0;
    }

    // Get tx count from utxo_deltas: count distinct 'create' actions for this block
    let txCount = 0;
    try {
      const hashBuf = typeof r.hash === "string" ? Buffer.from(r.hash, "hex") : r.hash;
      const deltaRow = d.query(
        "SELECT COUNT(DISTINCT utxo) as c FROM utxo_deltas WHERE block_hash = ? AND action = 'fee'"
      ).get(hashBuf) as any;
      txCount = deltaRow?.c ?? 0;
    } catch {}

    return {
      slot: r.slot,
      hash: hashHex,
      prevHash: prevHashHex,
      era: 6,
      epoch: r.slot > 0 ? Math.floor((r.slot - 86400) / 432000) + 208 : 0,
      txCount,
      size,
      insertedAt: r.inserted_at ? new Date(Number(r.inserted_at) * 1000).toISOString() : new Date().toISOString(),
    };
  });
}

function isNodeConnected(): boolean {
  // The node is considered connected if the DB has a block inserted within the last 60 seconds
  const d = getDb();
  if (!d) return false;
  try {
    const row = d.query("SELECT MAX(inserted_at) as latest FROM blocks").get() as any;
    if (!row?.latest) return false;
    const latestTime = Number(row.latest) * 1000; // inserted_at is unix seconds
    return (Date.now() - latestTime) < 60_000;
  } catch {
    return false;
  }
}

function getTopologyPeers(): any[] {
  const topoPath = resolve("./src/config/preprod/topology.json");
  if (!existsSync(topoPath)) return [];
  try {
    const topo = JSON.parse(readFileSync(topoPath, "utf-8"));
    const connected = isNodeConnected();
    const peers: any[] = [];

    // Bootstrap peers are always connected when node is running
    for (const ap of topo.bootstrapPeers ?? []) {
      peers.push({ id: `${ap.address}:${ap.port}`, host: ap.address, port: ap.port, category: "bootstrap", slot: lastTipSlot, connected });
    }

    // Local roots with access points
    for (const root of topo.localRoots ?? []) {
      for (const ap of root.accessPoints ?? []) {
        if (!peers.some((p) => p.host === ap.address && p.port === ap.port)) {
          peers.push({ id: `${ap.address}:${ap.port}`, host: ap.address, port: ap.port, category: "localRoot", slot: lastTipSlot, connected });
        }
      }
    }

    // Public roots are warm/passive peers
    for (const root of topo.publicRoots ?? []) {
      for (const ap of root.accessPoints ?? []) {
        if (!peers.some((p) => p.host === ap.address && p.port === ap.port)) {
          peers.push({ id: `${ap.address}:${ap.port}`, host: ap.address, port: ap.port, category: "warm", slot: lastTipSlot, connected });
        }
      }
    }
    return peers;
  } catch { return []; }
}

async function queryPeers(): Promise<any[]> {
  return getTopologyPeers();
}

function queryLogs(level: string, limit: number) {
  // Check multiple log directories: the configured log dir, default ./logs, and store logs
  const logDirs = [
    resolve("./logs"),
    resolve("./src/store/logs/preprod"),
    resolve("./src/store/logs/mainnet"),
  ].filter((d) => existsSync(d));

  const levelMap: Record<string, string[]> = {
    DEBUG: ["debug.jsonl", "info.jsonl", "warn.jsonl", "error.jsonl", "mempool.jsonl", "rollback.jsonl"],
    INFO: ["info.jsonl", "warn.jsonl", "error.jsonl", "mempool.jsonl", "rollback.jsonl"],
    WARN: ["warn.jsonl", "error.jsonl", "rollback.jsonl"],
    ERROR: ["error.jsonl"],
  };
  const files = levelMap[level] ?? ["info.jsonl"];
  const entries: Array<{ timestamp: string; level: string; message: string }> = [];

  for (const logDir of logDirs) {
    for (const file of files) {
      const p = join(logDir, file);
      if (!existsSync(p)) continue;
      try {
        // Only read the tail of the file for efficiency
        const stat = statSync(p);
        const readSize = Math.min(stat.size, 1024 * 256); // last 256KB
        const content = readSize < stat.size
          ? readFileSync(p, "utf-8").slice(-readSize)
          : readFileSync(p, "utf-8");
        const lines = content.trim().split("\n").slice(-limit);
        for (const line of lines) {
          if (!line) continue;
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
  }

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

function queryUtxos(q: string) {
  const d = getDb();
  if (!d || !q) return [];
  if (/^[0-9a-f]{64}:\d+$/i.test(q)) {
    return (d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE utxo_ref = ?").all(q) as any[]).map(parseUtxoRow);
  }
  if (/^[0-9a-f]{64}$/i.test(q)) {
    return (d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE tx_hash = ? ORDER BY utxo_ref LIMIT 100").all(q) as any[]).map(parseUtxoRow);
  }
  return (d.query("SELECT utxo_ref, tx_out, tx_hash FROM utxo WHERE tx_hash LIKE ? LIMIT 100").all(`${q}%`) as any[]).map(parseUtxoRow);
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
  return (d.query("SELECT id, block_hash, action, utxo, created_at FROM utxo_deltas ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r: any) => ({
    id: r.id,
    blockHash: typeof r.block_hash === "string" ? r.block_hash : (r.block_hash ? Buffer.from(r.block_hash).toString("hex") : ""),
    action: r.action,
    utxo: typeof r.utxo === "string" ? r.utxo : JSON.stringify(r.utxo),
    createdAt: r.created_at ?? new Date().toISOString(),
  }));
}

function queryMempool(): any[] {
  const d = getDb();
  if (!d) return [];
  try {
    // Check if mempool table exists
    const mempoolTable = d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mempool'").get();
    if (!mempoolTable) return [];
    const rows = d.query("SELECT * FROM mempool ORDER BY rowid DESC LIMIT 100").all() as any[];
    return rows.map((r: any) => ({
      txHash: r.tx_hash ?? r.hash ?? "",
      size: r.size ?? r.tx_size ?? 0,
      fee: r.fee ?? 0,
      receivedAt: r.received_at ?? r.created_at ?? new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

function queryBlockByHash(hash: string): any | null {
  const d = getDb();
  if (!d || !hash) return null;

  // Try volatile blocks first
  let row: any = null;
  try {
    const hashBuf = Buffer.from(hash, "hex");
    row = d.query(`
      SELECT slot, hash, prev_hash, block_data, block_fetch_RawCbor, header_data, is_valid, inserted_at
      FROM blocks WHERE hash = ?
    `).get(hashBuf) as any;
  } catch {}

  // Try immutable blocks if not found
  if (!row) {
    try {
      const hashBuf = Buffer.from(hash, "hex");
      row = d.query(`
        SELECT slot, block_hash as hash, prev_hash, block_data, block_fetch_RawCbor, header_data, inserted_at
        FROM immutable_blocks WHERE block_hash = ?
      `).get(hashBuf) as any;
    } catch {}
  }

  // Also try as plain string hash (in case stored as TEXT)
  if (!row) {
    try {
      row = d.query(`
        SELECT slot, hash, prev_hash, block_data, block_fetch_RawCbor, header_data, is_valid, inserted_at
        FROM blocks WHERE hash = ?
      `).get(hash) as any;
    } catch {}
  }

  if (!row) return null;

  const hashHex = typeof row.hash === "string" ? row.hash : Buffer.from(row.hash).toString("hex");
  const prevHashHex = typeof row.prev_hash === "string" ? row.prev_hash : (row.prev_hash ? Buffer.from(row.prev_hash).toString("hex") : "");

  let size = 0;
  if (row.block_fetch_RawCbor instanceof Uint8Array || Buffer.isBuffer(row.block_fetch_RawCbor)) {
    size = row.block_fetch_RawCbor.byteLength ?? row.block_fetch_RawCbor.length ?? 0;
  } else if (row.block_data instanceof Uint8Array || Buffer.isBuffer(row.block_data)) {
    size = row.block_data.byteLength ?? row.block_data.length ?? 0;
  }

  // Count txs from fee deltas for this block
  let txCount = 0;
  try {
    const hashBuf = typeof row.hash === "string" ? Buffer.from(row.hash, "hex") : row.hash;
    const deltaRow = d.query(
      "SELECT COUNT(DISTINCT utxo) as c FROM utxo_deltas WHERE block_hash = ? AND action = 'fee'"
    ).get(hashBuf) as any;
    txCount = deltaRow?.c ?? 0;
  } catch {}

  // Try to parse block_data if it's JSONB (immutable blocks store as JSON)
  let blockDataParsed: any = null;
  try {
    if (typeof row.block_data === "string") {
      blockDataParsed = JSON.parse(row.block_data);
    }
  } catch {}

  return {
    slot: row.slot,
    hash: hashHex,
    prevHash: prevHashHex,
    era: 6,
    epoch: row.slot > 0 ? Math.floor((row.slot - 86400) / 432000) + 208 : 0,
    txCount,
    size,
    isValid: row.is_valid ?? true,
    insertedAt: row.inserted_at ? new Date(Number(row.inserted_at) * 1000).toISOString() : new Date().toISOString(),
    blockData: blockDataParsed,
  };
}

function queryChainState() {
  const d = getDb();
  if (!d) return { treasury: 0, reserves: 0, poolCount: 0, stakeCount: 0, delegationCount: 0 };
  let treasury = 0, reserves = 0;
  try {
    const cas = d.query("SELECT treasury, reserves FROM chain_account_state WHERE id = 1").get() as any;
    treasury = cas?.treasury ?? 0; reserves = cas?.reserves ?? 0;
  } catch {}
  let poolCount = 0;
  try {
    const pd = d.query("SELECT pools FROM pool_distr WHERE id = 1").get() as any;
    if (pd?.pools) { const pools = typeof pd.pools === "string" ? JSON.parse(pd.pools) : pd.pools; poolCount = Array.isArray(pools) ? pools.length : 0; }
  } catch {}
  const stakeCount = (d.query("SELECT COUNT(*) as c FROM stake").get() as any)?.c ?? 0;
  const delegationCount = (d.query("SELECT COUNT(*) as c FROM delegations").get() as any)?.c ?? 0;
  return { treasury, reserves, poolCount, stakeCount, delegationCount };
}

function createSSEStream(channel: string): Response {
  const stream = new ReadableStream({
    start(controller) { addSSEClient(channel, controller); controller.enqueue(new TextEncoder().encode(":ok\n\n")); },
    cancel(controller) { removeSSEClient(channel, controller as any); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" },
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// Tx submission proxy — browser POSTs signed tx CBOR, we relay to the node
async function proxyTxSubmit(req: Request): Promise<Response> {
  try {
    const body = await req.arrayBuffer();
    const resp = await fetch(`${NODE_URL}/txsubmit`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const result = await resp.text();
    return new Response(result, { status: resp.status, headers: { "Content-Type": "application/json", ...CORS } });
  } catch (e: any) {
    return json({ error: e.message }, 502);
  }
}

// ---------------------------------------------------------------------------
// HTTP Server — no WebSocket here; websockify handles WS↔TCP separately
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // REST API
    if (path === "/api/status") { try { return json(buildStatus()); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/peers") { try { return json(await queryPeers()); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/blocks") { return json(queryRecentBlocks(parseInt(url.searchParams.get("limit") ?? "50", 10))); }
    if (path === "/api/mempool") { try { return json(queryMempool()); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/logs") { return json(queryLogs(url.searchParams.get("level") ?? "INFO", parseInt(url.searchParams.get("limit") ?? "100", 10))); }
    if (path === "/api/utxo") { try { return json(queryUtxos(url.searchParams.get("q") ?? "")); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/deltas") { try { return json(queryRecentDeltas(parseInt(url.searchParams.get("limit") ?? "100", 10))); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/chain-state") { try { return json(queryChainState()); } catch (e: any) { return json({ error: e.message }, 500); } }
    if (path === "/api/topology") { return json(getTopologyPeers()); }
    if (path === "/api/txsubmit" && req.method === "POST") { return proxyTxSubmit(req); }

    // Block detail endpoint: /api/block/:hash
    {
      const blockMatch = path.match(/^\/api\/block\/([0-9a-fA-F]{64})$/);
      if (blockMatch) {
        try {
          const block = queryBlockByHash(blockMatch[1]);
          if (!block) return json({ error: "Block not found" }, 404);
          return json(block);
        } catch (e: any) { return json({ error: e.message }, 500); }
      }
    }

    // SSE
    if (path === "/api/sse/status") return createSSEStream("status");
    if (path === "/api/sse/blocks") return createSSEStream("blocks");
    if (path === "/api/sse/logs") return createSSEStream("logs");
    if (path === "/api/sse/peers") return createSSEStream("peers");
    if (path === "/api/sse/mempool") return createSSEStream("mempool");

    // Static files (production: built dashboard)
    if (STATIC_DIR) {
      let filePath = path === "/" ? "/index.html" : path;
      const file = Bun.file(join(STATIC_DIR, filePath));
      if (await file.exists()) return new Response(file);
      const index = Bun.file(join(STATIC_DIR, "index.html"));
      if (await index.exists()) return new Response(index);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`
  GEROLAMO DASHBOARD SERVER
  ─────────────────────────
  API:       http://localhost:${PORT}/api
  SSE:       http://localhost:${PORT}/api/sse
  DB:        ${DB_PATH}
  Node:      ${NODE_URL}
${STATIC_DIR ? `  Static:    ${STATIC_DIR}\n` : ""}  ─────────────────────────
  NOTE: WebSocket↔TCP proxy is handled by websockify (separate service)
`);
