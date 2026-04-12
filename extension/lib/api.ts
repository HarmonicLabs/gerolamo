// ---------------------------------------------------------------------------
// API types and fetch helpers for the Gerolamo extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared interfaces — node status
// ---------------------------------------------------------------------------

export interface TipInfo {
  slot: number;
  hash: string;
  epoch: number;
  era: number;
}

export interface SyncInfo {
  progress: number;
  speed: number;
  startedAt: string;
}

export interface NodeStatus {
  tip: TipInfo;
  sync: SyncInfo;
  uptime: number;
  network: string;
  volatileBlocks: number;
  immutableBlocks: number;
  utxoCount: number;
  mempoolSize: number;
  gcCycles: number;
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export interface PeerInfo {
  id: string;
  host: string;
  port: number;
  category: "hot" | "warm" | "cold" | "bootstrap" | "new";
  slot: number;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface BlockInfo {
  slot: number;
  hash: string;
  prevHash: string;
  era: number;
  epoch: number;
  txCount: number;
  size: number;
  insertedAt: string;
}

// ---------------------------------------------------------------------------
// UTxOs
// ---------------------------------------------------------------------------

export interface UtxoEntry {
  ref: string;
  txHash: string;
  outputIndex: number;
  address: string;
  amount: string;
  assets: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

export async function fetchJson<T>(apiBase: string, path: string): Promise<T> {
  const res = await fetch(`${apiBase}/api${path}`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export function fetchStatus(apiBase: string): Promise<NodeStatus> {
  return fetchJson<NodeStatus>(apiBase, "/status");
}

export function fetchPeers(apiBase: string): Promise<PeerInfo[]> {
  return fetchJson<PeerInfo[]>(apiBase, "/peers");
}

export function fetchRecentBlocks(apiBase: string, limit = 50): Promise<BlockInfo[]> {
  return fetchJson<BlockInfo[]>(apiBase, `/blocks?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Mempool
// ---------------------------------------------------------------------------

export interface MempoolEntry {
  txHash: string;
  size: number;
  fee: number;
  receivedAt: string;
}

export function fetchMempool(apiBase: string): Promise<MempoolEntry[]> {
  return fetchJson<MempoolEntry[]>(apiBase, "/mempool");
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export function fetchLogs(apiBase: string, level = "INFO", limit = 100): Promise<LogEntry[]> {
  return fetchJson<LogEntry[]>(apiBase, `/logs?level=${level}&limit=${limit}`);
}

// ---------------------------------------------------------------------------
// UTxO lookup
// ---------------------------------------------------------------------------

export function fetchUtxos(apiBase: string, query: string): Promise<UtxoEntry[]> {
  return fetchJson<UtxoEntry[]>(apiBase, `/utxo?q=${encodeURIComponent(query)}`);
}

// ---------------------------------------------------------------------------
// Transaction submission
// ---------------------------------------------------------------------------

export async function submitTransaction(apiBase: string, txCbor: Uint8Array): Promise<{ txHash: string }> {
  const res = await fetch(`${apiBase}/api/txsubmit`, {
    method: "POST",
    headers: { "Content-Type": "application/cbor" },
    body: txCbor,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tx submit ${res.status}: ${body}`);
  }

  return res.json() as Promise<{ txHash: string }>;
}
