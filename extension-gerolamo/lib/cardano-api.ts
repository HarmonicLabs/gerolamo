// ---------------------------------------------------------------------------
// Cardano API client — uses Koios (free, no API key required).
// SolidJS Query hooks for reactive data fetching.
// ---------------------------------------------------------------------------

import { createQuery } from "@tanstack/solid-query";
import { getSettings } from "@/lib/settings";

// ---- Types ----

export interface KoiosBlock {
  hash: string;
  epoch_no: number;
  abs_slot: number;
  epoch_slot: number;
  block_height: number;
  block_size: number;
  block_time: number;
  tx_count: number;
  vrf_key: string;
  pool: string | null;
  proto_major: number;
  proto_minor: number;
}

export interface KoiosTip {
  hash: string;
  epoch_no: number;
  abs_slot: number;
  epoch_slot: number;
  block_no: number;
  block_time: number;
}

export interface KoiosTotals {
  epoch_no: number;
  circulation: string;
  treasury: string;
  reward: string;
  supply: string;
  reserves: string;
}

export interface KoiosEpochInfo {
  epoch_no: number;
  out_sum: string;
  fees: string;
  tx_count: number;
  blk_count: number;
  start_time: number;
  end_time: number;
  first_block_time: number;
  last_block_time: number;
  active_stake: string | null;
  total_rewards: string | null;
  avg_blk_reward: string | null;
}

export interface UtxoResult {
  tx_hash: string;
  tx_index: number;
  value: string;
  asset_list: { policy_id: string; asset_name: string; quantity: string }[];
  block_height: number;
  block_time: number;
}

// ---- Core fetcher ----

async function koiosGet<T>(path: string): Promise<T> {
  const { apiEndpoint } = getSettings();
  const res = await fetch(`${apiEndpoint}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Koios ${res.status}: ${body}`);
  }
  return res.json();
}

async function koiosPost<T>(path: string, body: any): Promise<T> {
  const { apiEndpoint } = getSettings();
  const res = await fetch(`${apiEndpoint}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Koios ${res.status}: ${errBody}`);
  }
  return res.json();
}

// ---- Block endpoints ----

export async function fetchTip(): Promise<KoiosTip> {
  const tips = await koiosGet<KoiosTip[]>("/tip");
  return tips[0];
}

export async function fetchRecentBlocks(count = 10): Promise<KoiosBlock[]> {
  return koiosGet<KoiosBlock[]>(`/blocks?limit=${count}&offset=0`);
}

// ---- Network endpoints ----

export async function fetchTotals(): Promise<KoiosTotals> {
  const totals = await koiosGet<KoiosTotals[]>("/totals");
  return totals[0];
}

export async function fetchEpochInfo(): Promise<KoiosEpochInfo> {
  const info = await koiosGet<KoiosEpochInfo[]>("/epoch_info?_include_next_epoch=false&limit=1");
  return info[0];
}

// ---- UTxO endpoints ----

export async function lookupUtxos(query: string): Promise<UtxoResult[]> {
  const isAddress = query.startsWith("addr") || query.startsWith("stake");
  const isTxHash = /^[0-9a-fA-F]{64}$/.test(query);

  if (isAddress) {
    return koiosPost<UtxoResult[]>("/address_utxos", {
      _addresses: [query],
      _extended: true,
    });
  }
  if (isTxHash) {
    const result = await koiosPost<any[]>("/tx_utxos", { _tx_hashes: [query] });
    if (result.length === 0) return [];
    return (result[0].outputs ?? []).map((o: any) => ({
      tx_hash: result[0].tx_hash,
      tx_index: o.tx_index,
      value: o.value,
      asset_list: o.asset_list ?? [],
      block_height: 0,
      block_time: 0,
    }));
  }

  const isUtxoRef = /^[0-9a-fA-F]{64}#\d+$/.test(query);
  if (isUtxoRef) {
    const [hash, idx] = query.split("#");
    const utxos = await lookupUtxos(hash);
    return utxos.filter((u) => u.tx_index === parseInt(idx));
  }

  throw new Error("Invalid query. Use an address, tx hash, or utxo ref (hash#index).");
}

export async function submitTransaction(cborHex: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { apiEndpoint } = getSettings();
    const bytes = new Uint8Array(cborHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const res = await fetch(`${apiEndpoint}/submittx`, {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: bytes,
    });
    if (res.ok) {
      const txHash = await res.text();
      return { ok: true, message: `Submitted: ${txHash}` };
    }
    const err = await res.text().catch(() => "Unknown error");
    return { ok: false, message: err };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Solid Query hooks ----

export function useUtxoLookup(query: () => string) {
  return createQuery(() => ({
    queryKey: ["utxo", query()],
    queryFn: () => lookupUtxos(query()),
    enabled: query().length > 0,
    retry: 1,
    staleTime: 30000,
  }));
}

export function useRecentBlocks(count = 10) {
  return createQuery(() => ({
    queryKey: ["blocks-recent", count],
    queryFn: () => fetchRecentBlocks(count),
    refetchInterval: 15000,
    staleTime: 10000,
  }));
}

export function useNetworkTotals() {
  return createQuery(() => ({
    queryKey: ["network-totals"],
    queryFn: fetchTotals,
    refetchInterval: 30000,
    staleTime: 20000,
  }));
}

export function useEpochInfo() {
  return createQuery(() => ({
    queryKey: ["epoch-info"],
    queryFn: fetchEpochInfo,
    refetchInterval: 30000,
    staleTime: 20000,
  }));
}
