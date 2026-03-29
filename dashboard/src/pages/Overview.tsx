import { createResource, Show, type Component } from "solid-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { fetchStatus, fetchChainState, useSSE, type NodeStatus } from "@/lib/api";

const ERA_NAMES: Record<number, string> = {
  0: "Byron",
  1: "Shelley",
  2: "Allegra",
  3: "Mary",
  4: "Alonzo",
  5: "Babbage",
  6: "Conway",
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

function formatLovelace(lovelaces: number): string {
  return `${(lovelaces / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })} ADA`;
}

const Overview: Component = () => {
  const [status, { refetch: refetchStatus }] = createResource(fetchStatus);
  const [chainState] = createResource(fetchChainState);
  const { data: liveStatus, connected } = useSSE<NodeStatus | null>("/sse/status", null);

  const current = () => liveStatus() ?? status();

  setInterval(refetchStatus, 10000);

  return (
    <div class="flex flex-col gap-4">
      {/* Connection indicator */}
      <div class="flex items-center gap-2">
        <div
          class="h-2 w-2 rounded-full"
          classList={{
            "bg-green animate-pulse": connected(),
            "bg-red": !connected(),
          }}
        />
        <span class="text-xs text-text-dim">
          {connected() ? "Live" : "Polling"}
        </span>
        <Show when={current()}>
          <Badge variant="default">{current()!.network.toUpperCase()}</Badge>
          <Badge variant="info">ERA {current()!.tip.era} ({ERA_NAMES[current()!.tip.era] ?? "?"})</Badge>
          <Badge variant="muted">EPOCH {current()!.tip.epoch}</Badge>
        </Show>
      </div>

      {/* Sync progress */}
      <Show when={current()}>
        {(s) => (
          <Card>
            <CardHeader>
              <CardTitle>Sync Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="flex items-center gap-4 mb-3">
                <ProgressBar value={s().sync.progress * 100} class="flex-1" />
                <span class="font-mono text-sm text-accent tabular-nums">
                  {(s().sync.progress * 100).toFixed(2)}%
                </span>
              </div>
              <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Tip Slot" value={s().tip.slot} accent />
                <Stat label="Speed" value={`${s().sync.speed} b/min`} />
                <Stat label="Uptime" value={formatUptime(s().uptime)} />
                <Stat label="Mempool" value={s().mempoolSize} sub="transactions" />
              </div>
            </CardContent>
          </Card>
        )}
      </Show>

      {/* Database stats */}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Show when={current()}>
          {(s) => (
            <>
              <Card>
                <CardContent class="flex flex-col items-center justify-center py-6">
                  <Stat label="Volatile Blocks" value={s().volatileBlocks} accent />
                </CardContent>
              </Card>
              <Card>
                <CardContent class="flex flex-col items-center justify-center py-6">
                  <Stat label="Immutable Blocks" value={s().immutableBlocks} />
                </CardContent>
              </Card>
              <Card>
                <CardContent class="flex flex-col items-center justify-center py-6">
                  <Stat label="UTxO Set" value={s().utxoCount} />
                </CardContent>
              </Card>
              <Card>
                <CardContent class="flex flex-col items-center justify-center py-6">
                  <Stat label="GC Cycles" value={s().gcCycles} />
                </CardContent>
              </Card>
            </>
          )}
        </Show>
      </div>

      {/* Chain state */}
      <Show when={chainState()}>
        {(cs) => (
          <Card>
            <CardHeader>
              <CardTitle>Chain State</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <Stat label="Treasury" value={formatLovelace(cs().treasury)} />
                <Stat label="Reserves" value={formatLovelace(cs().reserves)} />
                <Stat label="Pools" value={cs().poolCount} />
                <Stat label="Stake Addrs" value={cs().stakeCount} />
                <Stat label="Delegations" value={cs().delegationCount} />
              </div>
            </CardContent>
          </Card>
        )}
      </Show>
    </div>
  );
};

export default Overview;
