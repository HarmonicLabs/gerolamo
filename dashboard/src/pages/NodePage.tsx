import { StatCard } from "@/components/StatCard";
import { useStatus, useSSE, type NodeStatus } from "@/lib/api";
import { formatNumber, formatUptime } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";

export default function NodePage() {
  const { data: status, isError } = useStatus();
  const qc = useQueryClient();
  useSSE<NodeStatus>("status", (s) => qc.setQueryData(["status"], s));

  const eraNames: Record<number, string> = { 1: "Byron", 2: "Shelley", 3: "Allegra", 4: "Mary", 5: "Alonzo", 6: "Babbage", 7: "Conway" };
  const running = !!status && !isError;

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Node Status</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Status" value={running ? "Running" : "Offline"} accent={running ? "cyan" : "red"} />
        <StatCard label="Era" value={status ? eraNames[status.tip.era] ?? `${status.tip.era}` : "—"} accent="cyan" />
        <StatCard label="Epoch" value={status?.tip.epoch.toString() ?? "—"} accent="cyan" />
        <StatCard label="Uptime" value={status ? formatUptime(Math.floor(status.uptime / 1000)) : "—"} accent="cyan" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Network Info</h3>
          <div className="space-y-2 text-sm">
            {[
              ["Network", status?.network ?? "—"],
              ["Protocol", "Ouroboros Praos"],
              ["Era", status ? eraNames[status.tip.era] ?? `${status.tip.era}` : "—"],
              ["Epoch", status?.tip.epoch.toString() ?? "—"],
              ["Tip Slot", status ? formatNumber(status.tip.slot) : "—"],
              ["Sync", status ? `${(status.sync.progress * 100).toFixed(2)}%` : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground">{k}</span>
                <span className="neon-text-cyan">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Storage</h3>
          <div className="space-y-2 text-sm">
            {[
              ["Volatile Blocks", status ? formatNumber(status.volatileBlocks) : "—"],
              ["Immutable Blocks", status ? formatNumber(status.immutableBlocks) : "—"],
              ["UTxO Set Size", status ? formatNumber(status.utxoCount) : "—"],
              ["Mempool Txs", status?.mempoolSize.toString() ?? "—"],
              ["GC Cycles", status?.gcCycles.toString() ?? "—"],
              ["Started At", status?.sync.startedAt ? new Date(status.sync.startedAt).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground">{k}</span>
                <span className="neon-text-cyan">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {status?.tip.hash && (
        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Tip Block Hash</h3>
          <pre className="text-xs text-muted-foreground bg-muted/30 rounded p-3 overflow-x-auto font-mono break-all">
            {status.tip.hash}
          </pre>
        </div>
      )}
    </div>
  );
}
