import { StatCard } from "@/components/StatCard";
import { CopyHash } from "@/components/CopyHash";
import { useStatus, useBlocks, usePeers, useSSE, type NodeStatus, type Block } from "@/lib/api";
import { formatNumber, formatUptime } from "@/lib/format";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function OverviewPage() {
  const { data: status } = useStatus();
  const { data: blocks } = useBlocks(20);
  const { data: peers } = usePeers();
  const qc = useQueryClient();

  // SSE: live status + block updates
  useSSE<NodeStatus>("status", (s) => qc.setQueryData(["status"], s));
  useSSE<Block>("blocks", (block) => {
    toast("New block adopted", { description: `Slot ${formatNumber(block.slot)}` });
    qc.invalidateQueries({ queryKey: ["blocks"] });
  });

  if (!status) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Connecting to node...</div>;
  }

  const peerCount = peers?.length ?? 0;
  const connectedPeers = peers?.filter((p) => p.connected).length ?? 0;
  const syncing = status.sync.progress < 1;
  const syncPct = (status.sync.progress * 100).toFixed(2);
  const eraNames: Record<number, string> = { 1: "Byron", 2: "Shelley", 3: "Allegra", 4: "Mary", 5: "Alonzo", 6: "Babbage", 7: "Conway" };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Overview</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Sync Progress" value={`${syncPct}%`} accent="red" />
        <StatCard label="Current Slot" value={formatNumber(status.tip.slot)} accent="cyan" />
        <StatCard label="Block Height" value={formatNumber(status.volatileBlocks + status.immutableBlocks)} accent="cyan" />
        <StatCard label="Epoch" value={status.tip.epoch.toString()} sub={`Era: ${eraNames[status.tip.era] ?? status.tip.era}`} accent="cyan" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Sync Speed" value={`${formatNumber(status.sync.speed)} blk/min`} accent="red" />
        <StatCard label="Uptime" value={formatUptime(Math.floor(status.uptime / 1000))} accent="cyan" />
        <StatCard label="Peers" value={`${connectedPeers} connected / ${peerCount} total`} accent="cyan" />
        <StatCard label="UTxO Set" value={formatNumber(status.utxoCount)} accent="cyan" />
      </div>

      {/* Sync Progress Bar */}
      <div className="glass-panel rounded-lg p-4">
        <div className="flex justify-between text-xs text-muted-foreground mb-2">
          <span>Sync Progress</span>
          <span>{syncPct}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full bg-primary transition-all ${syncing ? "animate-pulse-glow" : ""}`}
            style={{ width: `${Math.min(100, status.sync.progress * 100)}%` }}
          />
        </div>
      </div>

      {/* Mini Chain Visualization */}
      {blocks && blocks.length > 0 && (
        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Chain — Last {blocks.length} Blocks</h3>
          <div className="flex items-center gap-1 overflow-x-auto pb-2">
            {blocks.map((block, i) => (
              <div key={block.slot} className="flex items-center shrink-0">
                <div className="w-12 h-12 rounded border border-border hover:neon-border-cyan transition-all flex flex-col items-center justify-center text-[9px] cursor-pointer group">
                  <span className="neon-text-cyan group-hover:text-secondary">{block.slot % 10000}</span>
                  <span className="text-muted-foreground">{block.txCount}tx</span>
                </div>
                {i < blocks.length - 1 && <div className="w-2 h-px bg-border" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Block Feed */}
      {blocks && blocks.length > 0 && (
        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Recent Blocks</h3>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {blocks.slice(0, 10).map((block) => (
              <div key={block.slot} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 text-xs animate-fade-in-up">
                <div className="flex items-center gap-3">
                  <span className="neon-text-cyan font-bold">{formatNumber(block.slot)}</span>
                  <CopyHash hash={block.hash} chars={6} />
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{block.txCount} txs</span>
                  <span>{(block.size / 1024).toFixed(1)} KB</span>
                  <span className="text-secondary">{eraNames[block.era] ?? `Era ${block.era}`}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
