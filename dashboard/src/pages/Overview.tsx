import { createResource, createMemo, Show, type Component } from "solid-js";
import { Motion } from "@motionone/solid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ProgressRing } from "@/components/Charts/ProgressRing";
import { fetchStatus, fetchChainState, useSSE, type NodeStatus } from "@/lib/api";

const MITHRIL_PHASE: Record<string, string> = {
  certificate: "Verifying certificate chain",
  download: "Downloading certified chain",
  apply: "Storing blocks",
  done: "Certified chain ready",
  error: "Failed",
};

function mithrilPct(m: { phase: string; chunk?: number; chunks?: number; beacon?: number; downloadedChunks?: number; appliedChunks?: number }): number {
  if (m.phase === "done") return 100;
  const total = m.chunks ?? m.beacon ?? 0;
  const done = m.phase === "apply" ? (m.appliedChunks ?? 0) : (m.downloadedChunks ?? 0);
  return total > 0 ? (100 * done) / total : 0;
}

function formatEta(sec: number): string {
  if (sec <= 0) return "done";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

const ERA_NAMES: Record<number, string> = {
  0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary",
  4: "Alonzo", 5: "Babbage", 6: "Conway",
};

const ERA_BADGE_VARIANT: Record<number, "muted" | "neon" | "purple" | "orange" | "cyan" | "success"> = {
  0: "muted", 1: "cyan", 2: "purple", 3: "purple",
  4: "orange", 5: "success", 6: "neon",
};

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function shortAda(lovelaces: number): string {
  const ada = lovelaces / 1_000_000;
  if (ada >= 1_000_000_000) return `${(ada / 1_000_000_000).toFixed(1)}B`;
  if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(1)}M`;
  if (ada >= 1_000) return `${(ada / 1_000).toFixed(1)}K`;
  return ada.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const Overview: Component = () => {
  const [status, { refetch }] = createResource(fetchStatus);
  const [chainState] = createResource(fetchChainState);
  const { data: liveStatus, connected } = useSSE<NodeStatus | null>("/sse/status", null);

  const current = createMemo(() => liveStatus() ?? status() ?? null);
  const currentChainState = () => chainState() ?? null;

  setInterval(refetch, 10000);

  return (
    <div class="flex flex-col gap-6">
      <h2 class="sr-only">Node Overview</h2>
      {/* ─── HERO: Sync Status ─── */}
      <Show when={current()} fallback={<SkeletonCard lines={4} class="min-h-[220px]" />}>
        {(s) => (
          <Motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, easing: [0.16, 1, 0.3, 1] }}
          >
            <div class="glass-card-accent p-6" role="region" aria-label="Sync status" aria-live="polite">
              {/* Top row: status + badges */}
              <div class="flex items-center justify-between mb-6">
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2">
                    <div
                      class="h-[8px] w-[8px] rounded-full"
                      classList={{
                        "bg-green pulse-live": connected(),
                        "bg-text-muted": !connected(),
                      }}
                      role="img"
                      aria-label={connected() ? "Node online" : "Node offline"}
                    />
                    <span class="text-[13px] font-medium text-text">
                      {connected() ? "Online" : "Offline"}
                    </span>
                  </div>
                  <Badge variant="neon">{s().network.toUpperCase()}</Badge>
                  <Badge variant="purple">{ERA_NAMES[s().tip.era] ?? `Era ${s().tip.era}`}</Badge>
                  <Badge
                    variant="muted"
                    title={s().tip.targetEpoch != null && s().tip.targetEpoch! > s().tip.epoch ? `Applying epoch ${s().tip.epoch} of ${s().tip.targetEpoch} (${s().tip.targetEpoch! - s().tip.epoch} behind)` : undefined}
                  >
                    Epoch {s().tip.epoch}
                    <Show when={s().tip.targetEpoch != null && s().tip.targetEpoch! > s().tip.epoch}>
                      <span class="text-text-muted"> / {s().tip.targetEpoch}</span>
                    </Show>
                  </Badge>
                </div>
                <span class="text-[12px] font-mono text-text-dim">
                  Uptime {formatUptime(s().uptime)}
                </span>
              </div>

              {/* Sync: ring + number + progress bar */}
              <div class="flex items-center gap-6 mb-5">
                <ProgressRing
                  value={s().sync.progress * 100}
                  size={100}
                  strokeWidth={7}
                  variant={s().sync.progress >= 1 ? "green" : "accent"}
                />
                <div class="flex flex-col flex-1 gap-3">
                  <div class="flex items-end gap-3">
                    <span class="font-mono text-[42px] font-bold leading-none tabular-nums text-text text-glow-strong">
                      {(s().sync.progress * 100).toFixed(2)}
                    </span>
                    <span class="text-[18px] font-semibold text-text-secondary mb-1">%</span>
                    <Badge variant={s().sync.progress >= 1 ? "success" : "default"} class="mb-2 ml-2">
                      {s().sync.progress >= 1 ? "Fully Synced" : "Syncing"}
                    </Badge>
                  </div>
                  <div class="relative">
                    <ProgressBar value={s().sync.progress * 100} variant="accent" />
                    <div class="shimmer-bar absolute inset-0 rounded-full pointer-events-none" />
                  </div>
                </div>
              </div>

              {/* Stats row */}
              <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
                  <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Tip Slot</span>
                  <span class="font-mono text-[18px] font-bold tabular-nums text-accent text-glow">{s().tip.slot.toLocaleString()}</span>
                </div>
                <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
                  <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Speed</span>
                  <span class="font-mono text-[18px] font-bold tabular-nums text-text">{s().sync.speed > 0 ? `${s().sync.speed}` : "\u2014"}</span>
                  <span class="text-[10px] text-text-muted">blocks/min</span>
                </div>
                <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
                  <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Mempool</span>
                  <span class="font-mono text-[18px] font-bold tabular-nums text-text">{s().mempoolSize}</span>
                  <span class="text-[10px] text-text-muted">pending</span>
                </div>
                <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
                  <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">GC Cycles</span>
                  <span class="font-mono text-[18px] font-bold tabular-nums text-text">{s().gcCycles.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </Motion.div>
        )}
      </Show>

      {/* ─── MITHRIL BOOTSTRAP (certified-chain import running outside the node) ─── */}
      <Show when={current()?.mithril}>
        {(m) => (
          <div class="glass-card-accent p-6" role="region" aria-label="Mithril bootstrap" aria-live="polite">
            <div class="flex items-baseline justify-between gap-4 flex-wrap">
              <div>
                <div class="text-xs uppercase tracking-wider text-text-muted">Mithril bootstrap · {m().network}</div>
                <div class="text-2xl font-semibold">
                  {m().replay ? (m().replay!.phase === "replay" ? "Replaying certified chain into the ledger" : "Certified chain replayed · live") : (MITHRIL_PHASE[m().phase] ?? m().phase)}
                  <span class="text-text-muted text-base"> · snapshot epoch {m().snapshotEpoch ?? "?"}{m().certificateVerified ? " · certificate verified" : ""}</span>
                </div>
              </div>
              <div class="text-sm text-text-muted">
                {m().replay ? `slot ${m().replay!.tipSlot.toLocaleString()} of ${m().replay!.certifiedSlot.toLocaleString()}${m().replay!.certifiedEpoch != null ? ` (certified through epoch ${m().replay!.certifiedEpoch})` : ""}` : m().phase === "download" || m().phase === "apply" ? `${((m().phase === "apply" ? m().appliedChunks : m().downloadedChunks) ?? 0).toLocaleString()} / ${(m().chunks ?? m().beacon ?? 0).toLocaleString()} chunks` : (m().message ?? "")}
              </div>
            </div>
            <ProgressBar value={m().replay ? m().replay!.percent : mithrilPct(m())} variant={m().replay ? (m().replay!.phase === "live" ? "green" : "purple") : m().phase === "apply" ? "cyan" : m().phase === "done" ? "green" : m().phase === "error" ? "orange" : "accent"} class="mt-4" />
            <div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat label="Blocks stored" value={(m().blocks ?? 0).toLocaleString()} size="sm" />
              <Stat label="Last slot" value={m().lastSlot != null ? `${m().lastSlot!.toLocaleString()}${m().lastEpoch != null ? ` · epoch ${m().lastEpoch}` : ""}` : "—"} size="sm" />
              <Stat label="Rate" value={m().ratePerSec != null ? `${m().ratePerSec!.toFixed(1)} chunks/s` : "—"} size="sm" />
              <Stat label="ETA" value={m().etaSec != null ? formatEta(m().etaSec!) : "—"} size="sm" />
            </div>
            <Show when={m().phase === "error"}>
              <div class="mt-3 text-sm text-amber">{m().message}</div>
            </Show>
          </div>
        )}
      </Show>

      {/* ─── BLOCK PRODUCTION (role, inbound listener, producer state from the node's /metrics) ─── */}
      <Show when={current()?.node}>
        {(n) => (
          <div class="glass-card-accent p-6" role="region" aria-label="Block production" aria-live="polite">
            <div class="flex items-baseline justify-between gap-4 flex-wrap">
              <div>
                <div class="text-xs uppercase tracking-wider text-text-muted">Block production</div>
                <div class="text-2xl font-semibold">
                  {!n().nodeUp ? "Node not reachable" : n().producer ? (n().producer!.dryRun ? "Block producer · dry run (leadership logged, nothing forged)" : "Block producer · forging") : n().inbound?.listening ? "Relay · validating, serving peers, not forging" : "Relay · validating, not yet serving peers, not forging"}
                  <Show when={n().producer}>{(p) => <span class="text-text-muted text-base font-mono"> · pool {p().poolId.slice(0, 16)}…</span>}</Show>
                </div>
              </div>
              <div class="text-sm text-text-muted">
                {n().inbound?.listening ? `inbound N2N on ${n().inbound!.host ?? "*"}:${n().inbound!.port} · ${n().inbound!.clients} client(s)` : "outbound connections only: inbound listener off, so other relays cannot pull from this node yet"}
                {n().hotPeers != null ? ` · ${n().hotPeers} hot peer(s)` : ""}
              </div>
            </div>
            <Show when={n().producer} fallback={<div class="mt-3 text-sm text-text-muted">To forge: <span class="font-mono">role: "producer"</span> with the pool keys in the node config; to serve peers: <span class="font-mono">role: "relay"</span> (inbound listener on).</div>}>
              {(p) => (
                <>
                  <div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Stat label="Next leader slot" value={p().nextLeaderSlot != null ? `${Number(p().nextLeaderSlot).toLocaleString()}${n().nextLeaderInSec != null ? (n().nextLeaderInSec! > 0 ? ` · in ${formatEta(n().nextLeaderInSec!)}` : " · now") : ""}` : "none scheduled"} size="sm" />
                    <Stat label="Leader slots known" value={`${p().leaderSlotsKnown} (epochs ${p().scheduledEpochs.join(", ") || "—"})`} size="sm" />
                    <Stat label="Forged" value={`${p().forged}${p().lastForgedSlot != null ? ` · last at ${Number(p().lastForgedSlot).toLocaleString()}` : ""}`} size="sm" />
                    <Stat label="Op-cert / KES" value={`counter ${p().opcert.counter} · period ${p().opcert.kesPeriod} · evolution ${p().kesEvolution}`} size="sm" />
                  </div>
                  <Show when={p().lastError}>
                    <div class="mt-3 text-sm text-amber">{p().lastError}</div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>

      {/* ─── THROUGHPUT METRICS ─── */}
      <Show when={current()} fallback={
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
        </div>
      }>
        {(s) => (
          <div class="stagger grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <Card class="glass-card-accent">
              <CardContent>
                <Stat label="Volatile Blocks" value={s().volatileBlocks} accent glow size="md" />
              </CardContent>
            </Card>
            <Card class="glass-card-accent">
              <CardContent>
                <Stat label="Immutable Blocks" value={s().immutableBlocks} size="md" />
              </CardContent>
            </Card>
            <Card class="glass-card-accent">
              <CardContent>
                <Stat label="UTxO Set Size" value={s().utxoCount} accent glow size="md" />
              </CardContent>
            </Card>
            <Card class="glass-card-accent">
              <CardContent>
                <Stat label="Blocks/min" value={s().sync.speed > 0 ? s().sync.speed : "\u2014"} sub="throughput" accent glow glowColor="green" size="md" />
              </CardContent>
            </Card>
            <Card class="glass-card-accent">
              <CardContent>
                <Stat label="Txs/hour" value={s().sync.speed > 0 ? Math.round(s().sync.speed * 60 * 0.8) : "\u2014"} sub="estimated" accent glow glowColor="cyan" size="md" />
              </CardContent>
            </Card>
          </div>
        )}
      </Show>

      {/* ─── LEDGER STATE ─── */}
      <Show when={currentChainState()} fallback={<SkeletonCard lines={2} />}>
        {(cs) => (
          <Motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            <Card class="glass-card-accent">
              <CardHeader>
                <div class="flex items-center gap-3">
                  <CardTitle>Ledger State</CardTitle>
                  <Badge variant="muted">on-chain</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  <Stat label="Treasury" value={`${shortAda(cs().treasury)}`} sub="ADA" accent glow glowColor="red" size="sm" />
                  <Stat label="Reserves" value={`${shortAda(cs().reserves)}`} sub="ADA" accent glow glowColor="orange" size="sm" />
                  <Stat label="Stake Pools" value={cs().poolCount} accent glow glowColor="green" size="sm" />
                  <Stat label="Stake Keys" value={cs().stakeCount} accent glow glowColor="cyan" size="sm" />
                  <Stat label="Delegations" value={cs().delegationCount} size="sm" />
                </div>
              </CardContent>
            </Card>
          </Motion.div>
        )}
      </Show>

      {/* ─── PROTOCOL ─── */}
      <Show when={current()} fallback={<SkeletonCard lines={2} />}>
        {(s) => (
          <Motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
          >
            <Card class="glass-card-accent">
              <CardHeader>
                <div class="flex items-center gap-3">
                  <CardTitle>Protocol</CardTitle>
                  <Badge variant="purple">Ouroboros Praos</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Stat label="Security Param" value="k = 2160" size="sm" />
                  <Stat label="Network" value={s().network} accent size="sm" />
                  <Stat label="Era" value={ERA_NAMES[s().tip.era] ?? "?"} size="sm" />
                  <Stat label="Runtime" value="TypeScript" size="sm" />
                </div>
              </CardContent>
            </Card>
          </Motion.div>
        )}
      </Show>
    </div>
  );
};

export default Overview;
