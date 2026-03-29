import { createSignal, onCleanup, onMount } from "solid-js";

const API_BASE = "/api";

export interface NodeStatus {
  tip: { slot: number; hash: string; epoch: number; era: number };
  sync: { progress: number; speed: number; startedAt: string };
  uptime: number;
  network: string;
  volatileBlocks: number;
  immutableBlocks: number;
  utxoCount: number;
  mempoolSize: number;
  gcCycles: number;
}

export interface PeerInfo {
  id: string;
  host: string;
  port: number;
  category: "hot" | "warm" | "cold" | "bootstrap" | "new";
  slot: number;
  connected: boolean;
}

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

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface UtxoEntry {
  ref: string;
  txHash: string;
  outputIndex: number;
  address: string;
  amount: string;
  assets: Record<string, Record<string, string>>;
}

export interface DeltaEntry {
  id: number;
  blockHash: string;
  action: "spend" | "create" | "cert" | "fee" | "withdrawal";
  utxo: string;
  createdAt: string;
}

export interface ChainState {
  treasury: number;
  reserves: number;
  poolCount: number;
  stakeCount: number;
  delegationCount: number;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchStatus() {
  return fetchJson<NodeStatus>("/status");
}

export function fetchPeers() {
  return fetchJson<PeerInfo[]>("/peers");
}

export function fetchRecentBlocks(limit = 50) {
  return fetchJson<BlockInfo[]>(`/blocks?limit=${limit}`);
}

export function fetchLogs(level = "INFO", limit = 100) {
  return fetchJson<LogEntry[]>(`/logs?level=${level}&limit=${limit}`);
}

export function fetchUtxos(query: string) {
  return fetchJson<UtxoEntry[]>(`/utxo?q=${encodeURIComponent(query)}`);
}

export function fetchRecentDeltas(limit = 100) {
  return fetchJson<DeltaEntry[]>(`/deltas?limit=${limit}`);
}

export function fetchChainState() {
  return fetchJson<ChainState>("/chain-state");
}

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
          setData(JSON.parse(e.data) as T);
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
