import { createSignal, createResource, createMemo, For, Show, type Component } from "solid-js";
import { TransitionGroup } from "solid-transition-group";
import { Motion } from "@motionone/solid";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSSE, fetchLogs, type LogEntry } from "@/lib/api";

const LEVEL_VARIANT = {
  DEBUG: "muted" as const,
  INFO: "neon" as const,
  WARN: "warning" as const,
  ERROR: "danger" as const,
  MEMPOOL: "success" as const,
  ROLLBACK: "magenta" as const,
};

const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

// ---------------------------------------------------------------------------
// Mock log entries for demo mode
// ---------------------------------------------------------------------------

function generateMockLogs(): LogEntry[] {
  const now = Date.now();
  const entries: { message: string; level: string; offset: number }[] = [
    { message: "Block received at slot 72,451,000 from peer 18.196.54.132:3001", level: "INFO", offset: 0 },
    { message: "Applied block a1b2c3d4 to volatile DB (12 txs, 48.3 KB)", level: "INFO", offset: 2_400 },
    { message: "Peer connected: 52.14.88.201:6000 (hot)", level: "INFO", offset: 5_100 },
    { message: "Chain selection: extended tip to slot 72,451,000", level: "INFO", offset: 7_300 },
    { message: "VRF verified for slot leader vk_test1qz2fxv2...q2ytjqp", level: "DEBUG", offset: 8_000 },
    { message: "Mempool: added tx ab01cd23 (fee: 0.182 ADA, 291 bytes)", level: "INFO", offset: 12_000 },
    { message: "KES signature verified (period 312, remaining 62)", level: "DEBUG", offset: 15_500 },
    { message: "Peer disconnected: 13.48.141.210:3001 (warm, timeout)", level: "WARN", offset: 18_000 },
    { message: "Block received at slot 72,450,980 from peer 3.127.183.90:3001", level: "INFO", offset: 22_000 },
    { message: "Applied block b2c3d4e5 to volatile DB (5 txs, 21.4 KB)", level: "INFO", offset: 24_500 },
    { message: "UTxO set updated: +5 created, -3 spent (net +2)", level: "INFO", offset: 25_000 },
    { message: "Stable state checkpoint: slot 72,448,840 (k=2160 depth)", level: "INFO", offset: 30_000 },
    { message: "GC cycle completed: pruned 43 immutable blocks", level: "DEBUG", offset: 35_000 },
    { message: "Peer reconnecting: 35.180.12.241:6000 (warm)", level: "INFO", offset: 38_000 },
    { message: "Chain sync: progress 99.87% (14,520 blocks/min)", level: "INFO", offset: 42_000 },
    { message: "Mempool: tx bc12de34 expired (TTL slot 72,450,900)", level: "INFO", offset: 45_000 },
    { message: "Block received at slot 72,450,960 from peer backbone.preprod.cardano.iog.io:3001", level: "INFO", offset: 50_000 },
    { message: "Plutus script evaluation: validator aabb0011 passed (234 ExUnits)", level: "DEBUG", offset: 52_000 },
    { message: "Network tip estimate: slot 72,452,118 (1,118 ahead)", level: "DEBUG", offset: 55_000 },
    { message: "Applied block c3d4e5f6 to volatile DB (0 txs, 4.0 KB)", level: "INFO", offset: 58_000 },
    { message: "Peer connected: preprod-node.world.dev.cardano.org:30000 (bootstrap)", level: "INFO", offset: 62_000 },
    { message: "Epoch boundary: entering epoch 371", level: "INFO", offset: 65_000 },
    { message: "Connection refused by peer 3.67.121.44:3001", level: "WARN", offset: 70_000 },
    { message: "Block received at slot 72,450,940 from peer 52.14.88.201:6000", level: "INFO", offset: 75_000 },
    { message: "Applied block d4e5f6a7 to volatile DB (31 txs, 89.2 KB)", level: "INFO", offset: 77_000 },
    { message: "Mempool: added tx de34fa56 (fee: 1.246 ADA, 2,341 bytes, PlutusV3)", level: "INFO", offset: 80_000 },
    { message: "Stake pool registration detected in tx dd44ee55", level: "INFO", offset: 82_000 },
    { message: "DNS resolution failed for peer 44.210.7.85:6000", level: "WARN", offset: 88_000 },
    { message: "Block received at slot 72,450,920 from peer 18.196.54.132:3001", level: "INFO", offset: 92_000 },
    { message: "Socket timeout: peer 18.230.44.112:6000 (cold)", level: "ERROR", offset: 95_000 },
    { message: "Retrying connection to peer 18.230.44.112:6000 (attempt 2/5)", level: "WARN", offset: 98_000 },
    { message: "Applied block e5f6a7b8 to volatile DB (8 txs, 33.8 KB)", level: "INFO", offset: 100_000 },
    { message: "Ouroboros mini-protocol: chain-sync header validated", level: "DEBUG", offset: 103_000 },
    { message: "NFT mint detected: policy ddee3344, asset 4e465431", level: "INFO", offset: 108_000 },
    { message: "Block received at slot 72,450,900 from peer 3.127.183.90:3001", level: "INFO", offset: 112_000 },
    { message: "Conway governance action: treasury withdrawal proposal", level: "INFO", offset: 115_000 },
    { message: "Block validation: invalid block header from peer 54.93.166.78:3001", level: "ERROR", offset: 120_000 },
    { message: "Peer demoted: 54.93.166.78:3001 (warm -> cold)", level: "WARN", offset: 122_000 },
    { message: "Applied block f6a7b8c9 to volatile DB (2 txs, 12.3 KB)", level: "INFO", offset: 125_000 },
    { message: "Mempool size: 7 pending transactions (total 8.2 KB)", level: "DEBUG", offset: 130_000 },
  ];

  return entries.map((e) => ({
    timestamp: new Date(now - e.offset).toISOString(),
    level: e.level,
    message: e.message,
  }));
}

const Logs: Component = () => {
  const [level, setLevel] = createSignal("INFO");
  const [logs, { refetch }] = createResource(level, (l) => fetchLogs(l, 200));
  const { data: liveLogs } = useSSE<LogEntry[]>("/sse/logs", []);
  setInterval(refetch, 3000);

  const mockLogs = generateMockLogs();

  const isDemo = createMemo(() => {
    const fetched = logs() ?? [];
    const live = liveLogs() ?? [];
    // If all fetched logs have empty messages and no live logs, we're in demo mode
    const hasRealLogs = fetched.some((l) => l.message && l.message.length > 0) || live.some((l) => l.message && l.message.length > 0);
    return fetched.length === 0 && live.length === 0 || !hasRealLogs;
  });

  const allLogs = () => {
    const live = liveLogs() ?? [];
    const fetched = logs() ?? [];

    if (isDemo()) {
      const currentLevel = level();
      const levelPriority: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
      const threshold = levelPriority[currentLevel] ?? 1;
      return mockLogs.filter((l) => (levelPriority[l.level] ?? 0) >= threshold);
    }

    if (live.length > 0) {
      const combined = [...live, ...fetched];
      const seen = new Set<string>();
      return combined.filter((l) => {
        const key = `${l.timestamp}:${l.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 200);
    }
    return fetched;
  };

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Show when={isDemo()}>
        <div class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-accent/15 bg-accent/[0.04] px-4 py-2 mb-3">
          <div class="h-1.5 w-1.5 rounded-full bg-accent/50 pulse-live" />
          <span class="text-[12px] text-text-secondary">
            Demo mode — showing sample log entries
          </span>
        </div>
      </Show>
      <Card class="glass-card-accent">
        <CardHeader>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <CardTitle>Node Logs</CardTitle>
              <Badge variant="muted">{allLogs().length}</Badge>
            </div>
            <div class="flex overflow-hidden rounded-[var(--radius-sm)] border border-border" role="group" aria-label="Filter by log level">
              <For each={[...LEVELS]}>
                {(l) => (
                  <button
                    class="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all"
                    classList={{
                      "bg-accent-dim text-accent border-r border-accent/15": level() === l,
                      "bg-bg-raised text-text-muted hover:bg-bg-overlay hover:text-text-dim border-r border-border": level() !== l,
                    }}
                    onClick={() => setLevel(l)}
                    aria-pressed={level() === l}
                    aria-label={`Show ${l} level logs`}
                  >
                    {l}
                  </button>
                )}
              </For>
            </div>
          </div>
        </CardHeader>
        <div class="max-h-[calc(100vh-240px)] overflow-y-auto font-mono text-[12px]" role="log" aria-live="polite" aria-label="Node log entries">
          <TransitionGroup name="row">
            <For each={allLogs()}>
              {(log) => (
                <div class="flex items-start gap-3 border-b border-border-subtle/40 px-5 py-2.5 transition-colors hover:bg-accent/[0.02]">
                  <span class="shrink-0 tabular-nums text-text-muted text-[11px] mt-[2px] w-[180px]">{log.timestamp}</span>
                  <Badge
                    variant={LEVEL_VARIANT[log.level as keyof typeof LEVEL_VARIANT] ?? "muted"}
                    class="shrink-0"
                  >
                    {log.level}
                  </Badge>
                  <span class="flex-1 min-w-0 break-words text-text-secondary leading-relaxed">{log.message || "\u2014"}</span>
                </div>
              )}
            </For>
          </TransitionGroup>
          {allLogs().length === 0 && (
            <div class="flex flex-col items-center gap-3 px-4 py-20">
              <div class="h-10 w-10 rounded-[var(--radius-sm)] border border-border bg-bg-sunken flex items-center justify-center">
                <svg class="h-5 w-5 text-text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
              <span class="text-[13px] text-text-secondary">No logs at this level</span>
            </div>
          )}
        </div>
      </Card>
    </Motion.div>
  );
};

export default Logs;
