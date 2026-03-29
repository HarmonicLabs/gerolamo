import { createSignal, createResource, For, type Component } from "solid-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSSE, fetchLogs, type LogEntry } from "@/lib/api";

const LEVEL_VARIANT = {
  DEBUG: "muted" as const,
  INFO: "info" as const,
  WARN: "warning" as const,
  ERROR: "danger" as const,
  MEMPOOL: "success" as const,
  ROLLBACK: "default" as const,
};

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
    <Card class="h-full">
      <CardHeader>
        <div class="flex items-center justify-between">
          <CardTitle>Node Logs</CardTitle>
          <div class="flex gap-1">
            {(["DEBUG", "INFO", "WARN", "ERROR"] as const).map((l) => (
              <button
                class="rounded-[var(--radius-sm)] px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors"
                classList={{
                  "bg-accent text-bg": level() === l,
                  "bg-border text-text-dim hover:bg-border-bright": level() !== l,
                }}
                onClick={() => setLevel(l)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div class="max-h-[calc(100vh-220px)] overflow-y-auto rounded bg-bg-sunken p-2">
          <For each={allLogs()}>
            {(log) => (
              <div class="flex gap-2 border-b border-border/30 px-2 py-1 font-mono text-[11px] leading-relaxed">
                <span class="shrink-0 text-text-muted">{log.timestamp}</span>
                <Badge
                  variant={LEVEL_VARIANT[log.level as keyof typeof LEVEL_VARIANT] ?? "muted"}
                  class="shrink-0"
                >
                  {log.level.padEnd(5)}
                </Badge>
                <span class="text-text-dim">{log.message}</span>
              </div>
            )}
          </For>
          {allLogs().length === 0 && (
            <div class="py-12 text-center text-text-dim">No logs at this level yet</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default Logs;
