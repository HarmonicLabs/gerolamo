/** KES certificate health from the node (same thresholds as @harmoniclabs/kes `kesStatus`). */
export type GerolamoKesHealth = "ok" | "rotate-soon" | "rotate-now" | "expired" | "not-yet-valid";

export type GerolamoNetwork = "preprod" | "mainnet" | "preview";

export type MetricsPayload = {
  tipSlot?: unknown;
  epoch?: unknown;
  era?: unknown;
  eraName?: unknown;
  utxoCount?: unknown;
  genesisUtxos?: unknown;
  uptimeSec?: unknown;
  peers?: { hot?: unknown; warm?: unknown; cold?: unknown; total?: unknown } | null;
  governor?: {
    hotKeys?: unknown;
    warmKeys?: unknown;
    coldSample?: unknown;
    failedPeers?: unknown;
    recentErrors?: unknown;
    maliciousPeers?: unknown;
  } | null;
  sync?: unknown;
  role?: unknown;
  inbound?: unknown;
  /** Block producer state (null on relays); see deriveProducer. */
  producer?: unknown;
  version?: unknown;
  /** Node process resources (rssBytes, heapUsedBytes, cpuPercent …); see shared/resources. */
  process?: unknown;
  system?: unknown;
};

export type GerolamoPeerFailure = { key: string; error: string; failCount: number };

export type GerolamoPeerAgreementStatus = "agrees" | "divergent" | "unknown" | "ahead" | "behind";

export type GerolamoPeerAgreement = {
  key: string;
  role: "primary" | "verifier";
  status: GerolamoPeerAgreementStatus;
  agreedAtSlot: string | null;
  tipSlot: string | null;
  headersSeen: number;
  divergenceSlot: string | null;
  /** Slots this verifier's tip trails the primary's; null for the primary or when unknown. */
  lagSlots: number | null;
};

export type GerolamoMaliciousPeer = { key: string; reason: string; until: number };

export type GerolamoSyncHalt = { slot: string; hash: string; reason: string; since: number };

export type GerolamoMultiPeerSync = {
  /** Strict validation stopped the applier; the DB needs a repair/resync. */
  halted: GerolamoSyncHalt | null;
  mode: "genesis" | "tip" | "point" | "resume" | null;
  bodyValidation: "soft" | "strict" | null;
  primary: string | null;
  quorum: number;
  peers: GerolamoPeerAgreement[];
  agreeing: number;
  divergent: number;
  rangesInFlight: number;
  rangesQueued: number;
  rangesAwaitingApply: number;
  rangeRetries: number;
  blocksPerSec: number;
  validationWorkers: number;
  pendingHeaders: number;
};

export type GerolamoInbound = { listening: boolean; host: string | null; port: number | null; clients: number };

export type LeaderSlotOutcome = "upcoming" | "adopted" | "confirmed" | "invalid" | "missed" | "ghosted" | "stolen";

export type GerolamoLeaderSlot = { slot: string; time: string; epoch: number; outcome: LeaderSlotOutcome; hash: string | null; note: string | null };

/** The node's block-producer panel, in gLiveView's vocabulary. */
export type GerolamoProducer = {
  poolId: string;
  vrfKeyHash: string | null;
  dryRun: boolean;
  opcert: { counter: string; kesPeriod: string; chainCounter: string | null };
  kes: { period: string; evolution: number; remaining: number; maxEvolutions: number; expiresAt: string | null; health: GerolamoKesHealth | null; counter: string | null } | null;
  missedLeaderChecks: number;
  scheduledEpochs: number[];
  leaderSlotsKnown: number;
  nextLeaderSlot: string | null;
  leaderSlots: GerolamoLeaderSlot[];
  epochStats: {
    epoch: number; leader: number; ideal: number | null; luck: number | null;
    adopted: number; confirmed: number; invalid: number; missed: number; ghosted: number; stolen: number;
  } | null;
  forged: number;
  lastForgedSlot: string | null;
  lastError: string | null;
};

/** Where the chain tip sits inside its epoch, and how far the clock epoch is. */
export type GerolamoEpochProgress = {
  /** Epoch the tip slot belongs to. */
  epoch: number;
  /** Epoch the network clock is in right now. */
  clockEpoch: number;
  epochsBehind: number;
  lengthSlots: number;
  slotsDone: number;
  slotsLeft: number;
  /** 0–100 through the tip's epoch. */
  percent: number;
  /** True when the tip epoch is the live one. */
  live: boolean;
};

export type GerolamoSyncStatus = {
  /** Node build label (`version+commit[-dirty]`), null for nodes that predate it. */
  nodeVersion: string | null;
  epochProgress: GerolamoEpochProgress | null;
  /** "data", "relay" or "producer"; null when the node predates roles. */
  role: "data" | "relay" | "producer" | null;
  inbound: GerolamoInbound | null;
  /** Block-producer state; null on relays and on nodes that predate it. */
  producer: GerolamoProducer | null;
  tipSlot: string;
  networkTipSlot: string;
  syncPercent: number;
  followPercent: number;
  emptyLedger: boolean;
  syncLabel: string;
  lagSlots: string;
  epoch: number | null;
  /** Ledger era number of the tip block (0/1 Byron … 7 Conway, 8 Dijkstra). */
  era: number | null;
  eraName: string | null;
  utxoCount: number | null;
  /** Genesis outputs from the Byron genesis file: total seeded and how many remain unspent. */
  genesisUtxos: { total: number; unspent: number; avvm: number } | null;
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
    maliciousPeers: GerolamoMaliciousPeer[];
  };
  /** Multi-peer honesty / parallel fetch state (null when the node predates it). */
  multiPeer: GerolamoMultiPeerSync | null;
};

const NETWORK_CLOCKS: Record<GerolamoNetwork, { systemStartMs: number; slotOffset: bigint }> = {
  preprod: { systemStartMs: 1_655_769_600_000, slotOffset: 86_400n },
  preview: { systemStartMs: 1_666_656_000_000, slotOffset: 0n },
  mainnet: { systemStartMs: 1_596_059_091_000, slotOffset: 4_492_800n },
};

/**
 * Epoch geometry per network: Byron epochs (short) until the Shelley hard fork
 * slot, then fixed-length Shelley+ epochs. Preview never had Byron.
 */
const EPOCH_GEOMETRY: Record<
  GerolamoNetwork,
  { byronEpochSlots: bigint; shelleyStartSlot: bigint; shelleyStartEpoch: bigint; shelleyEpochSlots: bigint }
> = {
  preprod: { byronEpochSlots: 21_600n, shelleyStartSlot: 86_400n, shelleyStartEpoch: 4n, shelleyEpochSlots: 432_000n },
  preview: { byronEpochSlots: 86_400n, shelleyStartSlot: 0n, shelleyStartEpoch: 0n, shelleyEpochSlots: 86_400n },
  mainnet: { byronEpochSlots: 21_600n, shelleyStartSlot: 4_492_800n, shelleyStartEpoch: 208n, shelleyEpochSlots: 432_000n },
};

export function epochBoundsAtSlot(
  slot: bigint,
  network: GerolamoNetwork,
): { epoch: bigint; startSlot: bigint; lengthSlots: bigint } {
  const g = EPOCH_GEOMETRY[network];
  if (slot < g.shelleyStartSlot) {
    const epoch = slot / g.byronEpochSlots;
    return { epoch, startSlot: epoch * g.byronEpochSlots, lengthSlots: g.byronEpochSlots };
  }
  const rel = (slot - g.shelleyStartSlot) / g.shelleyEpochSlots;
  return {
    epoch: g.shelleyStartEpoch + rel,
    startSlot: g.shelleyStartSlot + rel * g.shelleyEpochSlots,
    lengthSlots: g.shelleyEpochSlots,
  };
}

/** The slot the network clock is at right now (the sync target), per network geometry. */
export function networkTipSlotNow(network: GerolamoNetwork, nowMs = Date.now()): bigint {
  const clock = NETWORK_CLOCKS[network];
  return clock.slotOffset + BigInt(Math.max(0, Math.floor((nowMs - clock.systemStartMs) / 1000)));
}

export function deriveEpochProgress(
  tipSlot: bigint,
  networkTipSlot: bigint,
  network: GerolamoNetwork,
): GerolamoEpochProgress {
  const tip = epochBoundsAtSlot(tipSlot, network);
  const clock = epochBoundsAtSlot(networkTipSlot, network);
  const done = tipSlot - tip.startSlot;
  const live = tip.epoch >= clock.epoch;
  // In the live epoch the clock, not the epoch end, is the finish line.
  const end = live ? networkTipSlot : tip.startSlot + tip.lengthSlots;
  const left = end > tipSlot ? end - tipSlot : 0n;
  const pct = Number(tip.lengthSlots) > 0 ? (Number(done) / Number(tip.lengthSlots)) * 100 : 0;
  return {
    epoch: Number(tip.epoch),
    clockEpoch: Number(clock.epoch),
    epochsBehind: Number(clock.epoch > tip.epoch ? clock.epoch - tip.epoch : 0n),
    lengthSlots: Number(tip.lengthSlots),
    slotsDone: Number(done),
    slotsLeft: Number(left),
    percent: Math.round(Math.max(0, Math.min(100, pct)) * 100) / 100,
    live,
  };
}

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

const maliciousPeers = (value: unknown): GerolamoMaliciousPeer[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.key !== "string") return [];
    return [{ key: row.key, reason: String(row.reason ?? ""), until: finiteNumber(row.until) ?? 0 }];
  });
};

const slotString = (value: unknown): string | null => {
  if (value == null) return null;
  const s = String(value);
  return /^\d+$/.test(s) ? s : null;
};

const OUTCOMES: LeaderSlotOutcome[] = ["upcoming", "adopted", "confirmed", "invalid", "missed", "ghosted", "stolen"];

export function deriveProducer(value: unknown): GerolamoProducer | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.poolId !== "string") return null;
  const oc = v.opcert && typeof v.opcert === "object" ? (v.opcert as Record<string, unknown>) : {};
  const kes = v.kes && typeof v.kes === "object" ? (v.kes as Record<string, unknown>) : null;
  const es = v.epochStats && typeof v.epochStats === "object" ? (v.epochStats as Record<string, unknown>) : null;
  const leaderSlots: GerolamoLeaderSlot[] = Array.isArray(v.leaderSlots)
    ? v.leaderSlots.slice(0, 64).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const r = item as Record<string, unknown>;
        const slot = slotString(r.slot);
        if (!slot) return [];
        return [{
          slot,
          time: typeof r.time === "string" ? r.time : "",
          epoch: finiteNumber(r.epoch) ?? 0,
          outcome: OUTCOMES.includes(r.outcome as LeaderSlotOutcome) ? (r.outcome as LeaderSlotOutcome) : "upcoming",
          hash: typeof r.hash === "string" ? r.hash : null,
          note: typeof r.note === "string" ? r.note : null,
        }];
      })
    : [];
  return {
    poolId: v.poolId,
    vrfKeyHash: typeof v.vrfKeyHash === "string" ? v.vrfKeyHash : null,
    dryRun: v.dryRun === true,
    opcert: {
      counter: String(oc.counter ?? "?"),
      kesPeriod: String(oc.kesPeriod ?? "?"),
      chainCounter: oc.chainCounter == null ? null : String(oc.chainCounter),
    },
    kes: kes
      ? {
          period: String(kes.period ?? "?"),
          evolution: finiteNumber(kes.evolution) ?? finiteNumber(v.kesEvolution) ?? 0,
          remaining: finiteNumber(kes.remaining) ?? 0,
          maxEvolutions: finiteNumber(kes.maxEvolutions) ?? 0,
          expiresAt: typeof kes.expiresAt === "string" ? kes.expiresAt : null,
          health: typeof kes.health === "string" ? (kes.health as GerolamoKesHealth) : null,
          counter: typeof kes.counter === "string" ? kes.counter : null,
        }
      : null,
    missedLeaderChecks: finiteNumber(v.missedLeaderChecks) ?? 0,
    scheduledEpochs: Array.isArray(v.scheduledEpochs) ? v.scheduledEpochs.map(finiteNumber).filter((n): n is number => n != null) : [],
    leaderSlotsKnown: finiteNumber(v.leaderSlotsKnown) ?? leaderSlots.length,
    nextLeaderSlot: slotString(v.nextLeaderSlot),
    leaderSlots,
    epochStats: es
      ? {
          epoch: finiteNumber(es.epoch) ?? 0,
          leader: finiteNumber(es.leader) ?? 0,
          ideal: es.ideal == null ? null : finiteNumber(es.ideal),
          luck: es.luck == null ? null : finiteNumber(es.luck),
          adopted: finiteNumber(es.adopted) ?? 0,
          confirmed: finiteNumber(es.confirmed) ?? 0,
          invalid: finiteNumber(es.invalid) ?? 0,
          missed: finiteNumber(es.missed) ?? 0,
          ghosted: finiteNumber(es.ghosted) ?? 0,
          stolen: finiteNumber(es.stolen) ?? 0,
        }
      : null,
    forged: finiteNumber(v.forged) ?? 0,
    lastForgedSlot: slotString(v.lastForgedSlot),
    lastError: typeof v.lastError === "string" ? v.lastError : null,
  };
}

export function deriveMultiPeerSync(value: unknown): GerolamoMultiPeerSync | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const sched = (v.scheduler && typeof v.scheduler === "object" ? v.scheduler : {}) as Record<string, unknown>;
  const peers: GerolamoPeerAgreement[] = Array.isArray(v.peers)
    ? v.peers.slice(0, 32).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const p = item as Record<string, unknown>;
        if (typeof p.key !== "string") return [];
        const role = p.role === "primary" ? "primary" : "verifier";
        const status: GerolamoPeerAgreementStatus =
          p.status === "agrees" || p.status === "divergent" || p.status === "ahead" || p.status === "behind"
            ? p.status
            : "unknown";
        const div = p.divergence && typeof p.divergence === "object" ? (p.divergence as Record<string, unknown>) : null;
        return [{
          key: p.key,
          role,
          status,
          agreedAtSlot: slotString(p.agreedAtSlot),
          tipSlot: slotString(p.tipSlot),
          headersSeen: finiteNumber(p.headersSeen) ?? 0,
          divergenceSlot: div ? slotString(div.slot) : null,
          lagSlots: p.lagSlots == null ? null : finiteNumber(p.lagSlots),
        }];
      })
    : [];
  const mode = v.mode === "genesis" || v.mode === "tip" || v.mode === "point" || v.mode === "resume" ? v.mode : null;
  const bodyValidation = v.bodyValidation === "strict" || v.bodyValidation === "soft" ? v.bodyValidation : null;
  const h = v.halted && typeof v.halted === "object" ? (v.halted as Record<string, unknown>) : null;
  return {
    halted: h && typeof h.reason === "string"
      ? { slot: String(h.slot ?? ""), hash: String(h.hash ?? ""), reason: h.reason, since: finiteNumber(h.since) ?? 0 }
      : null,
    mode,
    bodyValidation,
    primary: typeof v.primary === "string" ? v.primary : null,
    quorum: finiteNumber(v.quorum) ?? 2,
    peers,
    agreeing: peers.filter((p) => p.role === "verifier" && p.status === "agrees").length,
    divergent: peers.filter((p) => p.status === "divergent").length,
    rangesInFlight: finiteNumber(sched.inFlight) ?? 0,
    rangesQueued: finiteNumber(sched.queued) ?? 0,
    rangesAwaitingApply: finiteNumber(sched.awaitingApply) ?? 0,
    rangeRetries: finiteNumber(sched.retries) ?? 0,
    blocksPerSec: finiteNumber(v.blocksPerSec) ?? 0,
    validationWorkers: finiteNumber(v.validationWorkers) ?? 0,
    pendingHeaders: finiteNumber(v.pendingHeaders) ?? 0,
  };
}

export function deriveGerolamoSyncStatus(
  metrics: MetricsPayload,
  network: GerolamoNetwork,
  nowMs = Date.now(),
): GerolamoSyncStatus {
  const networkTip = networkTipSlotNow(network, nowMs);

  let tip = 0n;
  try {
    tip = BigInt(String(metrics.tipSlot ?? "0"));
  } catch {
    tip = 0n;
  }

  const lag = networkTip > tip ? networkTip - tip : 0n;
  const rawPercent = networkTip > 0n ? (Number(tip) / Number(networkTip)) * 100 : 0;
  const followPercent = Math.round(Math.max(0, Math.min(100, rawPercent)) * 100) / 100;
  const utxoCount = finiteNumber(metrics.utxoCount);
  const emptyLedger = (utxoCount ?? 0) === 0;
  // Tip-follow on an empty SQLite file is not genesis density.
  const syncPercent = emptyLedger ? 0 : followPercent;
  const syncLabel = emptyLedger
    ? lag === 0n
      ? "Tip follow · ledger empty"
      : "Catching tip · ledger empty"
    : lag === 0n
      ? "At network tip"
      : `${followPercent.toFixed(2)}% of clock tip`;

  const hotKeys = stringList(metrics.governor?.hotKeys);
  const inb = metrics.inbound && typeof metrics.inbound === "object" ? (metrics.inbound as Record<string, unknown>) : null;

  return {
    nodeVersion: typeof metrics.version === "string" && metrics.version ? metrics.version : null,
    epochProgress: tip > 0n ? deriveEpochProgress(tip, networkTip, network) : null,
    role: metrics.role === "relay" || metrics.role === "data" || metrics.role === "producer" ? metrics.role : null,
    producer: deriveProducer(metrics.producer),
    inbound: inb
      ? {
          listening: inb.listening === true,
          host: typeof inb.host === "string" ? inb.host : null,
          port: finiteNumber(inb.port),
          clients: finiteNumber(inb.clients) ?? 0,
        }
      : null,
    tipSlot: tip.toString(),
    networkTipSlot: networkTip.toString(),
    syncPercent,
    followPercent,
    emptyLedger,
    syncLabel,
    lagSlots: lag.toString(),
    epoch: finiteNumber(metrics.epoch),
    era: finiteNumber(metrics.era),
    eraName: typeof metrics.eraName === "string" && metrics.eraName.length > 0
      ? metrics.eraName
      : null,
    utxoCount,
    genesisUtxos: (() => {
      const g = metrics.genesisUtxos && typeof metrics.genesisUtxos === "object" ? (metrics.genesisUtxos as Record<string, unknown>) : null;
      if (!g) return null;
      const total = finiteNumber(g.total) ?? 0;
      return { total, unspent: finiteNumber(g.unspent) ?? 0, avvm: finiteNumber(g.avvm) ?? 0 };
    })(),
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
      maliciousPeers: maliciousPeers(metrics.governor?.maliciousPeers),
    },
    multiPeer: deriveMultiPeerSync(metrics.sync),
  };
}

/** Raw `/metrics` JSON, or null when the node is unreachable. */
export async function fetchGerolamoMetrics(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricsPayload | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/metrics`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    return (await response.json()) as MetricsPayload;
  } catch {
    return null;
  }
}

export async function fetchGerolamoSyncStatus(
  baseUrl: string,
  network: GerolamoNetwork,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<GerolamoSyncStatus | null> {
  const metrics = await fetchGerolamoMetrics(baseUrl, fetchImpl);
  return metrics ? deriveGerolamoSyncStatus(metrics, network, nowMs) : null;
}
