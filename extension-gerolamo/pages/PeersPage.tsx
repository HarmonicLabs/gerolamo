import { Show, For } from "solid-js";
import { useBrowserNodeState } from "@/lib/background-bridge";
import { useNetworkTotals, useEpochInfo } from "@/lib/cardano-api";
import { StatCard } from "@/components/StatCard";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";

export default function PeersPage() {
  const { bgState } = useBrowserNodeState();
  const totals = useNetworkTotals();
  const epochInfo = useEpochInfo();

  const isConnected = () => bgState().state === "synced";

  const formatAda = (lovelace: string) => {
    const n = parseInt(lovelace) / 1_000_000;
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toFixed(0);
  };

  return (
    <div class="space-y-3">
      <div class="grid grid-cols-3 gap-2">
        <StatCard label="Status" value={isConnected() ? "Online" : "Offline"} accent={isConnected() ? "cyan" : "red"} />
        <StatCard label="Network" value={bgState().network} />
        <StatCard label="Height" value={formatNumber(bgState().tipHeight)} />
      </div>

      <Show when={totals.data}>
        {(data) => (
          <div>
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Network Supply</h3>
            <div class="glass-panel rounded-lg p-3 border border-border space-y-2">
              <For each={[
                ["Circulation", data().circulation, true],
                ["Total Supply", data().supply, false],
                ["Treasury", data().treasury, false],
                ["Reserves", data().reserves, false],
                ["Rewards", data().reward, false],
              ] as const}>
                {([label, value, isCyan]) => (
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-muted-foreground">{label}</span>
                    <span class={`text-xs font-mono ${isCyan ? "neon-text-cyan" : ""}`}>{formatAda(value as string)} ADA</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>

      <Show when={epochInfo.data}>
        {(data) => (
          <div>
            <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Current Epoch</h3>
            <div class="glass-panel rounded-lg p-3 border border-border space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Epoch</span>
                <Badge variant="secondary" class="text-[9px]">{data().epoch_no}</Badge>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Blocks</span>
                <span class="text-xs">{formatNumber(data().blk_count)}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Transactions</span>
                <span class="text-xs">{formatNumber(data().tx_count)}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Fees</span>
                <span class="text-xs font-mono">{formatAda(data().fees)} ADA</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Output</span>
                <span class="text-xs font-mono">{formatAda(data().out_sum)} ADA</span>
              </div>
            </div>
          </div>
        )}
      </Show>

      <div>
        <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Data Flow</h3>
        <div class="glass-panel rounded-lg border border-border flex items-center justify-center py-6">
          <svg width="200" height="100" viewBox="0 0 200 100">
            <circle cx="40" cy="50" r="16" fill="none" stroke="hsl(348, 100%, 50%)" stroke-width="2" />
            <text x="40" y="46" text-anchor="middle" fill="hsl(348, 100%, 50%)" font-size="7" font-family="monospace">Gero-</text>
            <text x="40" y="56" text-anchor="middle" fill="hsl(348, 100%, 50%)" font-size="7" font-family="monospace">lamino</text>

            <rect x="90" y="34" width="50" height="32" rx="4" fill="none" stroke={isConnected() ? "hsl(186, 100%, 50%)" : "#555"} stroke-width="2" />
            <text x="115" y="54" text-anchor="middle" fill={isConnected() ? "hsl(186, 100%, 50%)" : "#555"} font-size="7" font-family="monospace">Koios</text>

            <circle cx="175" cy="50" r="16" fill="none" stroke={isConnected() ? "#00E676" : "#555"} stroke-width="2" />
            <text x="175" y="47" text-anchor="middle" fill={isConnected() ? "#00E676" : "#555"} font-size="7" font-family="monospace">Cardano</text>
            <text x="175" y="57" text-anchor="middle" fill="#666" font-size="6" font-family="monospace">{bgState().network}</text>

            <line x1="56" y1="50" x2="88" y2="50" stroke={isConnected() ? "hsl(186, 100%, 50%)" : "#333"} stroke-width="1.5" stroke-dasharray={isConnected() ? "none" : "4 2"} />
            <line x1="142" y1="50" x2="158" y2="50" stroke={isConnected() ? "#00E676" : "#333"} stroke-width="1.5" stroke-dasharray={isConnected() ? "none" : "4 2"} />

            <text x="72" y="44" text-anchor="middle" fill="#666" font-size="6" font-family="monospace">HTTPS</text>
          </svg>
        </div>
      </div>
    </div>
  );
}
