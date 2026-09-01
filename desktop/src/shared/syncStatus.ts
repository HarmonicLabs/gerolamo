export type GerolamoNetwork = "preprod" | "mainnet" | "preview";

export type MetricsPayload = {
  tipSlot?: unknown;
  epoch?: unknown;
  utxoCount?: unknown;
  uptimeSec?: unknown;
  peers?: { hot?: unknown; warm?: unknown; cold?: unknown; total?: unknown } | null;
  governor?: {
    hotKeys?: unknown;
    warmKeys?: unknown;
    coldSample?: unknown;
    failedPeers?: unknown;
    recentErrors?: unknown;
  } | null;
};

export type GerolamoPeerFailure = { key: string; error: string; failCount: number };

export type GerolamoSyncStatus = {
  tipSlot: string;
  networkTipSlot: string;
  syncPercent: number;
  lagSlots: string;
  epoch: number | null;
  utxoCount: number | null;
  uptimeSec: number | null;
  hotPeers: number | null;
  peers: {
    hot: number;
    warm: number;
    cold: number;
    total: number;
    hotKeys: string[];
    warmKeys: string[];
    coldSample: string[];
    failedPeers: number;
    recentErrors: GerolamoPeerFailure[];
  };
};

const NETWORK_CLOCKS: Record<GerolamoNetwork, { systemStartMs: number; slotOffset: bigint }> = {
  preprod: { systemStartMs: 1_655_769_600_000, slotOffset: 86_400n },
  preview: { systemStartMs: 1_666_656_000_000, slotOffset: 0n },
  mainnet: { systemStartMs: 1_596_059_091_000, slotOffset: 4_492_800n },
};

const finiteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 64) : [];

const peerFailures = (value: unknown): GerolamoPeerFailure[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.error !== "string") return [];
    return [{ key: row.key, error: row.error, failCount: finiteNumber(row.failCount) ?? 0 }];
  });
};

export function deriveGerolamoSyncStatus(
  metrics: MetricsPayload,
  network: GerolamoNetwork,
  nowMs = Date.now(),
): GerolamoSyncStatus {
  const clock = NETWORK_CLOCKS[network];
  const elapsedSlots = BigInt(Math.max(0, Math.floor((nowMs - clock.systemStartMs) / 1000)));
  const networkTip = clock.slotOffset + elapsedSlots;

  let tip = 0n;
  try {
    tip = BigInt(String(metrics.tipSlot ?? "0"));
  } catch {
    tip = 0n;
  }

  const lag = networkTip > tip ? networkTip - tip : 0n;
  const rawPercent = networkTip > 0n ? (Number(tip) / Number(networkTip)) * 100 : 0;
  const syncPercent = Math.round(Math.max(0, Math.min(100, rawPercent)) * 100) / 100;

  const hotKeys = stringList(metrics.governor?.hotKeys);

  return {
    tipSlot: tip.toString(),
    networkTipSlot: networkTip.toString(),
    syncPercent,
    lagSlots: lag.toString(),
    epoch: finiteNumber(metrics.epoch),
    utxoCount: finiteNumber(metrics.utxoCount),
    uptimeSec: finiteNumber(metrics.uptimeSec),
    hotPeers: finiteNumber(metrics.peers?.hot),
    peers: {
      hot: finiteNumber(metrics.peers?.hot) ?? 0,
      warm: finiteNumber(metrics.peers?.warm) ?? 0,
      cold: finiteNumber(metrics.peers?.cold) ?? 0,
      total: finiteNumber(metrics.peers?.total) ?? 0,
      hotKeys,
      warmKeys: stringList(metrics.governor?.warmKeys),
      coldSample: stringList(metrics.governor?.coldSample),
      failedPeers: finiteNumber(metrics.governor?.failedPeers) ?? 0,
      recentErrors: peerFailures(metrics.governor?.recentErrors),
    },
  };
}

export async function fetchGerolamoSyncStatus(
  baseUrl: string,
  network: GerolamoNetwork,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<GerolamoSyncStatus | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/metrics`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const metrics = (await response.json()) as MetricsPayload;
    return deriveGerolamoSyncStatus(metrics, network, nowMs);
  } catch {
    return null;
  }
}
