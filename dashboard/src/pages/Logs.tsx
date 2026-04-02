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

const Logs: Component = () => {
  const [level, setLevel] = createSignal("INFO");
  const [logs, { refetch }] = createResource(level, (l) => fetchLogs(l, 200));
  const { data: liveLogs } = useSSE<LogEntry[]>("/sse/logs", []);
  setInterval(refetch, 3000);

  const allLogs = () => {
    const live = liveLogs() ?? [];
    const fetched = logs() ?? [];

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
              <span class="text-[11px] text-text-muted">Start the node to begin generating logs.</span>
            </div>
          )}
        </div>
      </Card>
    </Motion.div>
  );
};

export default Logs;
