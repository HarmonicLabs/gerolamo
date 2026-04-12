import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useCallback } from "react";
import { getSettings } from "./settings";

function apiBase(): string {
  // In dev mode, vite proxies /api → dashboard server, so just use relative paths
  if (import.meta.env.DEV) return "";
  return getSettings().apiEndpoint;
}

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────

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

export interface Block {
  slot: number;
  hash: string;
  prevHash: string;
  era: number;
  epoch: number;
  txCount: number;
  size: number;
  insertedAt: string;
}

export interface BlockDetail extends Block {
  isValid: boolean;
  blockData: unknown;
}

export interface Peer {
  id: string;
  host: string;
  port: number;
  category: string;
  slot: number;
  connected: boolean;
}

export interface MempoolTx {
  txHash: string;
  size: number;
  fee: number;
  receivedAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface UtxoResult {
  ref: string;
  txHash: string;
  outputIndex: number;
  address: string;
  amount: string;
  assets: Record<string, unknown>;
}

export interface ChainState {
  treasury: number;
  reserves: number;
  poolCount: number;
  stakeCount: number;
  delegationCount: number;
}

export interface Delta {
  id: number;
  blockHash: string;
  action: string;
  utxo: string;
  createdAt: string;
}

// ─── React Query Hooks ───────────────────────────────────────────────────

export function useStatus() {
  return useQuery<NodeStatus>({
    queryKey: ["status"],
    queryFn: () => fetchApi("/api/status"),
    refetchInterval: getSettings().refreshInterval,
  });
}

export function useBlocks(limit = 50) {
  return useQuery<Block[]>({
    queryKey: ["blocks", limit],
    queryFn: () => fetchApi(`/api/blocks?limit=${limit}`),
    refetchInterval: getSettings().refreshInterval,
  });
}

export function useBlockDetail(hash: string | null) {
  return useQuery<BlockDetail>({
    queryKey: ["block", hash],
    queryFn: () => fetchApi(`/api/block/${hash}`),
    enabled: !!hash,
  });
}

export function usePeers() {
  return useQuery<Peer[]>({
    queryKey: ["peers"],
    queryFn: () => fetchApi("/api/peers"),
    refetchInterval: getSettings().refreshInterval,
  });
}

export function useMempool() {
  return useQuery<MempoolTx[]>({
    queryKey: ["mempool"],
    queryFn: () => fetchApi("/api/mempool"),
    refetchInterval: getSettings().refreshInterval,
  });
}

export function useLogs(level = "INFO", limit = 100) {
  return useQuery<LogEntry[]>({
    queryKey: ["logs", level, limit],
    queryFn: () => fetchApi(`/api/logs?level=${level}&limit=${limit}`),
    refetchInterval: getSettings().refreshInterval,
  });
}

export function useUtxoLookup(query: string) {
  return useQuery<UtxoResult[]>({
    queryKey: ["utxo", query],
    queryFn: () => fetchApi(`/api/utxo?q=${encodeURIComponent(query)}`),
    enabled: !!query,
  });
}

export function useChainState() {
  return useQuery<ChainState>({
    queryKey: ["chain-state"],
    queryFn: () => fetchApi("/api/chain-state"),
    refetchInterval: 30000,
  });
}

export function useDeltas(limit = 100) {
  return useQuery<Delta[]>({
    queryKey: ["deltas", limit],
    queryFn: () => fetchApi(`/api/deltas?limit=${limit}`),
    refetchInterval: getSettings().refreshInterval,
  });
}

// ─── SSE Hook ────────────────────────────────────────────────────────────

export function useSSE<T>(channel: string, onMessage: (data: T) => void) {
  const onMsgRef = useRef(onMessage);
  onMsgRef.current = onMessage;

  useEffect(() => {
    if (!getSettings().wsEnabled) return;
    const url = `${apiBase()}/api/sse/${channel}`;
    const es = new EventSource(url);
    es.onmessage = (evt) => {
      try {
        onMsgRef.current(JSON.parse(evt.data));
      } catch { /* ignore malformed SSE data */ }
    };
    return () => es.close();
  }, [channel]);
}

// ─── Tx Submission ───────────────────────────────────────────────────────

export async function submitTransaction(cborHex: string): Promise<{ ok: boolean; message: string }> {
  const bytes = new Uint8Array(cborHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const res = await fetch(`${apiBase()}/api/txsubmit`, {
    method: "POST",
    headers: { "Content-Type": "application/cbor" },
    body: bytes,
  });
  const text = await res.text();
  return { ok: res.ok, message: text };
}
