/**
 * Explorer client for the node's Mini-Blockfrost API (/api/v0). Types mirror
 * Blockfrost's response shapes; Gerolamo extensions are marked.
 *
 * Base URL: VITE_NODE_URL when the dashboard is served separately (dev server,
 * dashboard-server), otherwise same-origin (the node serves /explorer/ itself).
 */
import { ApiError, NetworkError } from "./api";

export const NODE_BASE_URL: string = (import.meta as any).env?.VITE_NODE_URL || "";
const V0 = `${NODE_BASE_URL}/api/v0`;

export interface BfBlock {
  time: number;
  height: number | null;
  hash: string;
  slot: number;
  epoch: number;
  epoch_slot: number | null;
  slot_leader: string | null;
  size: number | null;
  tx_count: number | null;
  output: string | null;
  fees: string | null;
  previous_block: string | null;
  next_block: string | null;
  confirmations: number | null;
  /** Gerolamo: Byron epoch-boundary block (no height, shares its slot with the epoch's first block). */
  ebb?: boolean;
}

export interface BfAmount {
  unit: string;
  quantity: string;
}

export interface BfTx {
  hash: string;
  block: string | null;
  block_height: number | null;
  block_time: number | null;
  slot: number;
  index: number | null;
  output_amount: BfAmount[] | null;
  fees: string | null;
  size: number | null;
  invalid_before: string | null;
  invalid_hereafter: string | null;
  utxo_count: number | null;
  valid_contract: boolean | null;
}

export interface BfTxUtxos {
  hash?: string;
  inputs: Array<{ tx_hash: string; output_index: number; address: string | null; amount: BfAmount[]; collateral?: boolean; reference?: boolean }>;
  outputs: Array<{ tx_hash?: string; output_index: number; address: string; amount: BfAmount[]; data_hash: string | null; inline_datum: string | null; reference_script_hash: string | null; collateral?: boolean; reference?: boolean }>;
}

export interface BfAddress {
  address: string;
  amount: BfAmount[];
  stake_address: string | null;
  type: string | null;
  script: boolean | null;
  utxo_count?: number;
  tx_count?: number;
}

export interface BfAddressUtxo {
  tx_hash: string;
  output_index: number;
  amount: BfAmount[];
  block?: string | null;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
}

export interface BfAddressTx {
  tx_hash: string;
  tx_index?: number;
  block_height?: number | null;
  block_time?: number | null;
  slot?: number;
  direction?: string | null;
}

export interface BfEpoch {
  epoch: number;
  start_time: number;
  end_time: number;
  first_block_time: number | null;
  last_block_time: number | null;
  block_count: number;
  tx_count: number | null;
  first_block: string | null;
  last_block: string | null;
  first_slot: number;
  last_slot: number;
  synced: "complete" | "partial" | "none";
}

export type SearchResult = { kind: "tx" | "block" | "address" | "stake" | "pool" | "unknown"; id: string; height?: number; slot?: number; message?: string };

export interface NodeMetrics {
  tipSlot: string;
  epoch: number | null;
  eraName: string | null;
  network: string;
  sync?: { blocksApplied?: number; blocksPerSec?: number; pendingHeaders?: number; primary?: string | null };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${V0}${path}`, init);
  } catch (err) {
    throw new NetworkError(path, err);
  }
  if (!res.ok) {
    let body: string | undefined;
    try {
      const j = (await res.json()) as { message?: string };
      body = j?.message;
    } catch {
      /* no body */
    }
    throw new ApiError(res.status, res.statusText, path, body);
  }
  return (await res.json()) as T;
}

export const explorer = {
  blocks: (limit = 25, before?: string): Promise<BfBlock[]> => getJson(`/blocks?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  block: (id: string): Promise<BfBlock> => getJson(`/blocks/${encodeURIComponent(id)}`),
  blockByHeight: (n: number): Promise<BfBlock> => getJson(`/blocks/height/${n}`),
  blockTxs: (id: string): Promise<string[]> => getJson(`/blocks/${encodeURIComponent(id)}/txs`),
  tx: (hash: string): Promise<BfTx> => getJson(`/txs/${hash}`),
  txUtxos: (hash: string): Promise<BfTxUtxos> => getJson(`/txs/${hash}/utxos`),
  address: (addr: string): Promise<BfAddress> => getJson(`/addresses/${encodeURIComponent(addr)}`),
  addressUtxos: (addr: string): Promise<BfAddressUtxo[]> => getJson(`/addresses/${encodeURIComponent(addr)}/utxos`),
  addressTxs: (addr: string, page = 1, count = 50): Promise<BfAddressTx[]> => getJson(`/addresses/${encodeURIComponent(addr)}/transactions?page=${page}&count=${count}`),
  epoch: (n: number): Promise<BfEpoch> => getJson(`/epochs/${n}`),
  epochBlocks: (n: number, page = 1, count = 100): Promise<string[]> => getJson(`/epochs/${n}/blocks?page=${page}&count=${count}`),
  epochParameters: (n: number): Promise<Record<string, unknown>> => getJson(`/epochs/${n}/parameters`),
  search: (q: string): Promise<SearchResult> => getJson(`/search?q=${encodeURIComponent(q)}`),
  metrics: async (): Promise<NodeMetrics> => {
    let res: Response;
    try {
      res = await fetch(`${NODE_BASE_URL}/metrics`);
    } catch (err) {
      throw new NetworkError("/metrics", err);
    }
    if (!res.ok) throw new ApiError(res.status, res.statusText, "/metrics");
    return (await res.json()) as NodeMetrics;
  },
};

// ---------------------------------------------------------------------------
// Hash routes inside the Explorer page: #/explorer, #/explorer/block/<id>, …
// ---------------------------------------------------------------------------

export type ExplorerRoute =
  | { page: "blocks"; before?: string }
  | { page: "block"; id: string }
  | { page: "tx"; hash: string }
  | { page: "address"; address: string }
  | { page: "epoch"; epoch: number }
  | { page: "search"; q: string };

export const EXPLORER_HASH_PREFIX = "#/explorer";

export function parseExplorerRoute(hash: string): ExplorerRoute {
  const h = (hash || "").replace(/^#\/?/, "/");
  const rest = h.startsWith("/explorer") ? h.slice("/explorer".length) : h;
  const [pathPart, query] = rest.split("?");
  const seg = (pathPart || "").split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const params = new URLSearchParams(query || "");
  if (seg.length === 0) return { page: "blocks", before: params.get("before") ?? undefined };
  switch (seg[0]) {
    case "block":
      return seg[1] ? { page: "block", id: seg[1] } : { page: "blocks" };
    case "tx":
      return seg[1] ? { page: "tx", hash: seg[1].toLowerCase() } : { page: "blocks" };
    case "address":
      return seg[1] ? { page: "address", address: seg[1] } : { page: "blocks" };
    case "epoch":
      return seg[1] && /^\d+$/.test(seg[1]) ? { page: "epoch", epoch: Number(seg[1]) } : { page: "blocks" };
    case "search":
      return { page: "search", q: params.get("q") ?? "" };
    default:
      return { page: "blocks" };
  }
}

export function explorerHref(route: ExplorerRoute): string {
  switch (route.page) {
    case "blocks":
      return `${EXPLORER_HASH_PREFIX}${route.before ? `?before=${encodeURIComponent(route.before)}` : ""}`;
    case "block":
      return `${EXPLORER_HASH_PREFIX}/block/${encodeURIComponent(route.id)}`;
    case "tx":
      return `${EXPLORER_HASH_PREFIX}/tx/${route.hash}`;
    case "address":
      return `${EXPLORER_HASH_PREFIX}/address/${encodeURIComponent(route.address)}`;
    case "epoch":
      return `${EXPLORER_HASH_PREFIX}/epoch/${route.epoch}`;
    case "search":
      return `${EXPLORER_HASH_PREFIX}/search?q=${encodeURIComponent(route.q)}`;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, tested)
// ---------------------------------------------------------------------------

export function lovelaceToAda(q: string | number | bigint): string {
  const n = BigInt(String(q || "0"));
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""} ₳`;
}

export function shortHash(h: string | null | undefined, head = 8, tail = 6): string {
  if (!h) return "—";
  return h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
}

export function relativeTime(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (unixSeconds == null) return "—";
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function absoluteTime(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null) return "—";
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** lovelace total of a Blockfrost amount array (other assets ignored). */
export function lovelaceOf(amount: BfAmount[] | null | undefined): bigint {
  if (!amount) return 0n;
  let n = 0n;
  for (const a of amount) if (a.unit === "lovelace") n += BigInt(a.quantity || "0");
  return n;
}
