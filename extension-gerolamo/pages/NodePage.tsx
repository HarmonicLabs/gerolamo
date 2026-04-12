import { createSignal, Show, For } from "solid-js";
import { useBrowserNodeState } from "@/lib/background-bridge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/StatCard";
import { formatNumber, formatUptime } from "@/lib/format";
import { Loader2 } from "lucide-solid";

const STATE_COLORS: Record<string, string> = {
  disconnected: "bg-red-500",
  connecting: "bg-yellow-500 animate-pulse",
  synced: "bg-green-500",
  error: "bg-red-500",
};

export default function NodePage() {
  const { bgState, connect, disconnect } = useBrowserNodeState();
  const [loading, setLoading] = createSignal(false);

  const uptime = () => {
    const cs = bgState().connectedSince;
    return cs ? Math.floor((Date.now() - new Date(cs).getTime()) / 1000) : 0;
  };

  const handleConnect = async () => {
    setLoading(true);
    try { await connect(); } finally { setLoading(false); }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try { await disconnect(); } finally { setLoading(false); }
  };

  return (
    <div class="space-y-3">
      <div class="glass-panel rounded-lg p-3 border border-border">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <div class={`h-3 w-3 rounded-full ${STATE_COLORS[bgState().state] || "bg-gray-500"}`} />
            <span class="text-sm font-medium capitalize">{bgState().state}</span>
          </div>
          <Badge variant="outline" class="text-[9px]">{bgState().network}</Badge>
        </div>

        <Show when={bgState().lastError}>
          <p class="text-[10px] text-destructive mb-2">{bgState().lastError}</p>
        </Show>

        <div class="flex gap-2">
          <Show
            when={bgState().state !== "disconnected" && bgState().state !== "error"}
            fallback={
              <Button size="sm" onClick={handleConnect} disabled={loading()} class="flex-1">
                <Show when={loading()} fallback="Connect"><Loader2 size={12} class="animate-spin" /></Show>
              </Button>
            }
          >
            <Button size="sm" variant="destructive" onClick={handleDisconnect} disabled={loading()} class="flex-1">
              <Show when={loading()} fallback="Disconnect"><Loader2 size={12} class="animate-spin" /></Show>
            </Button>
          </Show>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <StatCard label="Tip Slot" value={formatNumber(bgState().tipSlot)} />
        <StatCard label="Height" value={formatNumber(bgState().tipHeight)} accent="red" />
        <StatCard label="Epoch" value={formatNumber(bgState().epoch)} />
        <StatCard label="Uptime" value={uptime() > 0 ? formatUptime(uptime()) : "—"} />
      </div>

      <div>
        <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Architecture</h3>
        <div class="glass-panel rounded-lg p-3 border border-border space-y-2">
          <div class="flex items-center gap-2 text-[10px]">
            <Badge variant="secondary" class="text-[8px] px-1.5 py-0">Extension</Badge>
            <span class="text-muted-foreground">HTTPS</span>
            <span class="neon-text-cyan">→</span>
          </div>
          <div class="flex items-center gap-2 text-[10px]">
            <Badge variant="outline" class="text-[8px] px-1.5 py-0">Koios</Badge>
            <span class="text-muted-foreground text-[9px] font-mono">API v1</span>
          </div>
          <div class="flex items-center gap-2 text-[10px]">
            <span class="neon-text-cyan">→</span>
            <Badge class="text-[8px] px-1.5 py-0">Cardano</Badge>
            <span class="text-muted-foreground">{bgState().network} network</span>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Data Sources</h3>
        <div class="glass-panel rounded-lg p-3 border border-border">
          <div class="grid grid-cols-2 gap-1 text-[10px]">
            <For each={["Blocks", "Network", "UTxOs", "Tx Submit"]}>
              {(p) => (
                <div class="flex items-center gap-1.5">
                  <div class={`h-1.5 w-1.5 rounded-full ${bgState().state === "synced" ? "bg-green-500" : "bg-gray-500"}`} />
                  <span class="text-muted-foreground">{p}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
