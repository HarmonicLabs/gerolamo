import { Show, For } from "solid-js";
import { useBrowserNodeState, useNodeBlocks } from "@/lib/background-bridge";
import { StatCard } from "@/components/StatCard";
import { formatNumber, formatUptime, formatBytes } from "@/lib/format";

export default function OverviewPage() {
  const { bgState } = useBrowserNodeState();
  const blocks = useNodeBlocks();

  const uptime = () => {
    const cs = bgState().connectedSince;
    return cs ? Math.floor((Date.now() - new Date(cs).getTime()) / 1000) : 0;
  };

  return (
    <Show
      when={bgState().state !== "disconnected" && bgState().state !== "error"}
      fallback={
        <div class="flex flex-col items-center justify-center h-full gap-4 text-center">
          <div class="h-12 w-12 rounded-full border-2 border-muted flex items-center justify-center">
            <div class="h-3 w-3 rounded-full bg-red-500" />
          </div>
          <div>
            <p class="text-sm font-medium">Not Connected</p>
            <p class="text-xs text-muted-foreground mt-1">
              {bgState().lastError || "Go to the Node tab to connect via Koios"}
            </p>
          </div>
        </div>
      }
    >
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-2">
          <StatCard label="Tip Slot" value={formatNumber(bgState().tipSlot)} accent="cyan" />
          <StatCard label="Height" value={formatNumber(bgState().tipHeight)} accent="red" />
          <StatCard label="Epoch" value={formatNumber(bgState().epoch)} accent="cyan" />
          <StatCard label="Uptime" value={uptime() > 0 ? formatUptime(uptime()) : "—"} accent="cyan" />
        </div>

        <div class="grid grid-cols-2 gap-2">
          <StatCard label="Network" value={bgState().network} accent="cyan" />
          <StatCard label="Blocks Seen" value={formatNumber(bgState().blocksReceived)} accent="red" />
        </div>

        <Show when={blocks().length > 0}>
          <div>
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Recent Blocks</h3>
            <div class="flex gap-1 overflow-x-auto pb-1">
              <For each={blocks().slice(0, 12)}>
                {(b) => (
                  <div class="glass-panel rounded-md p-1.5 min-w-[56px] text-center border border-border hover:neon-border-cyan transition-all cursor-default">
                    <p class="text-[9px] neon-text-cyan font-bold">{b.slot % 100000}</p>
                    <p class="text-[8px] text-muted-foreground">{formatBytes(b.size)}</p>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={blocks().length > 0}>
          <div>
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Latest Blocks</h3>
            <div class="space-y-1">
              <For each={blocks().slice(0, 8)}>
                {(b) => (
                  <div class="glass-panel rounded-md p-2 flex justify-between items-center text-xs">
                    <div class="flex items-center gap-2">
                      <span class="neon-text-cyan font-medium">Slot {formatNumber(b.slot)}</span>
                      <span class="text-[9px] text-muted-foreground">{b.txCount} txs</span>
                    </div>
                    <div class="text-muted-foreground text-[10px]">{formatBytes(b.size)}</div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
