import { createSignal, createEffect, Show, For } from "solid-js";
import { useNodeLogs } from "@/lib/background-bridge";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-solid";

export default function LogsPage() {
  const logs = useNodeLogs();
  const [paused, setPaused] = createSignal(false);
  const [filter, setFilter] = createSignal<"all" | "error" | "info">("all");
  const [frozenLogs, setFrozenLogs] = createSignal<string[]>([]);
  let scrollRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!paused()) {
      setFrozenLogs(logs());
    }
  });

  createEffect(() => {
    frozenLogs(); // track
    if (!paused() && scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight;
    }
  });

  const displayLogs = () => paused() ? frozenLogs() : logs();

  const filtered = () => {
    const f = filter();
    return displayLogs().filter((log) => {
      if (f === "all") return true;
      if (f === "error") return log.toLowerCase().includes("error");
      return !log.toLowerCase().includes("error");
    });
  };

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex gap-1">
          <For each={["all", "info", "error"] as const}>
            {(f) => (
              <Button
                variant={filter() === f ? "default" : "outline"}
                size="sm"
                class="h-6 px-2 text-[9px]"
                onClick={() => setFilter(f)}
              >
                {f.toUpperCase()}
              </Button>
            )}
          </For>
        </div>
        <Button variant="outline" size="icon" class="h-6 w-6" onClick={() => setPaused(!paused())}>
          <Show when={paused()} fallback={<Pause size={12} />}><Play size={12} /></Show>
        </Button>
      </div>

      <div ref={scrollRef} class="glass-panel rounded-lg border border-border p-2 h-[420px] overflow-y-auto">
        <Show
          when={filtered().length > 0}
          fallback={<p class="text-xs text-muted-foreground text-center py-4">No logs yet</p>}
        >
          <div class="space-y-0.5">
            <For each={filtered()}>
              {(log) => (
                <p class={`text-[9px] font-mono leading-tight ${
                  log.toLowerCase().includes("error") ? "text-destructive" : "text-muted-foreground"
                }`}>
                  {log}
                </p>
              )}
            </For>
          </div>
        </Show>
      </div>

      <p class="text-[8px] text-muted-foreground text-center">
        {filtered().length} entries {paused() && "(paused)"}
      </p>
    </div>
  );
}
