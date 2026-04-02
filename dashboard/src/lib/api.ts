import { createSignal, onCleanup, onMount } from "solid-js";

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------
export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL || "";

const API_BASE = `${API_BASE_URL}/api`;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly path: string;

  constructor(status: number, statusText: string, path: string, body?: string) {
    super(
      `API ${status} ${statusText} on ${path}${body ? `: ${body}` : ""}`
    );
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.path = path;
  }
}

export class NetworkError extends Error {
  public readonly path: string;
  public readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(`Network error on ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "NetworkError";
    this.path = path;
    this.cause = cause;
  }
}

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

/** Extended block detail (for future /api/block/:hash endpoint) */
export interface BlockDetail extends BlockInfo {
  vrf: string;
  kesSignature: string;
  timestamp: string;
  status: "finalized" | "volatile";
  totalFees: number;
  withdrawals: number;
  txHashes: string[];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface TxInput {
  txHash: string;
  index: number;
  address: string;
  value: string;
}

export interface TxOutput {
  address: string;
  value: string;
  datum?: string;
}

export interface TxScript {
  hash: string;
  type: "PlutusV1" | "PlutusV2" | "PlutusV3" | "Native";
  result: "pass" | "fail";
}

export interface TxCollateral {
  txHash: string;
  index: number;
}

export interface TxMint {
  policyId: string;
  assetName: string;
  quantity: string;
}

export interface TxDetail {
  hash: string;
  blockHash: string;
  fee: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  scripts: TxScript[];
  collateral: TxCollateral[];
  mint: TxMint[];
  metadata?: Record<string, unknown>;
  size: number;
  validContract: boolean;
}

// ---------------------------------------------------------------------------
// Mempool
// ---------------------------------------------------------------------------

export interface MempoolTx {
  hash: string;
  fee: number;
  size: number;
  arrivedAt: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  scripts?: TxScript[];
  ttl: number;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
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
// Deltas
// ---------------------------------------------------------------------------

export interface DeltaEntry {
  id: number;
  blockHash: string;
  action: "spend" | "create" | "cert" | "fee" | "withdrawal";
  utxo: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Chain state
// ---------------------------------------------------------------------------

export interface ChainState {
  treasury: number;
  reserves: number;
  poolCount: number;
  stakeCount: number;
  delegationCount: number;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`);
  } catch (err) {
    throw new NetworkError(path, err);
  }

  if (!res.ok) {
    let body: string | undefined;
    try {
      body = await res.text();
    } catch {}
    throw new ApiError(res.status, res.statusText, path, body);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Existing API functions
// ---------------------------------------------------------------------------

export function fetchStatus(): Promise<NodeStatus> {
  return fetchJson<NodeStatus>("/status");
}

export function fetchPeers(): Promise<PeerInfo[]> {
  return fetchJson<PeerInfo[]>("/peers");
}

export function fetchRecentBlocks(limit = 50): Promise<BlockInfo[]> {
  return fetchJson<BlockInfo[]>(`/blocks?limit=${limit}`);
}

export function fetchLogs(level = "INFO", limit = 100): Promise<LogEntry[]> {
  return fetchJson<LogEntry[]>(`/logs?level=${level}&limit=${limit}`);
}

export function fetchUtxos(query: string): Promise<UtxoEntry[]> {
  return fetchJson<UtxoEntry[]>(`/utxo?q=${encodeURIComponent(query)}`);
}

export function fetchRecentDeltas(limit = 100): Promise<DeltaEntry[]> {
  return fetchJson<DeltaEntry[]>(`/deltas?limit=${limit}`);
}

export function fetchChainState(): Promise<ChainState> {
  return fetchJson<ChainState>("/chain-state");
}

// ---------------------------------------------------------------------------
// New API functions
// ---------------------------------------------------------------------------

export function fetchMempool(): Promise<MempoolTx[]> {
  return fetchJson<MempoolTx[]>("/mempool");
}

export function fetchBlockDetail(hash: string): Promise<BlockDetail> {
  return fetchJson<BlockDetail>(`/block/${hash}`);
}

export function fetchTxDetail(hash: string): Promise<TxDetail> {
  return fetchJson<TxDetail>(`/tx/${hash}`);
}

// ---------------------------------------------------------------------------
// SSE hook
// ---------------------------------------------------------------------------

export function useSSE<T>(path: string, initialValue: T) {
  const [data, setData] = createSignal<T>(initialValue);
  const [connected, setConnected] = createSignal(false);

  onMount(() => {
    let es: EventSource | null = null;

    function connect() {
      es = new EventSource(`${API_BASE}${path}`);
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          setData(() => JSON.parse(e.data) as T);
        } catch {}
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        setTimeout(connect, 3000);
      };
    }

    connect();

    onCleanup(() => {
      es?.close();
    });
  });

  return { data, connected };
}
