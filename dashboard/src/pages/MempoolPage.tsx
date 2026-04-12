import { useMempool, useSSE, type MempoolTx } from "@/lib/api";
import { CopyHash } from "@/components/CopyHash";
import { StatCard } from "@/components/StatCard";
import { formatNumber, formatBytes } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";

export default function MempoolPage() {
  const { data: txs = [], isLoading } = useMempool();
  const qc = useQueryClient();
  useSSE<MempoolTx[]>("mempool", (data) => qc.setQueryData(["mempool"], data));

  const totalSize = txs.reduce((s, t) => s + t.size, 0);
  const totalFee = txs.reduce((s, t) => s + t.fee, 0);
  const avgFee = txs.length > 0 ? Math.round(totalFee / txs.length) : 0;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading mempool...</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Mempool</h1>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label="Transactions" value={txs.length} accent="red" />
        <StatCard label="Total Size" value={formatBytes(totalSize)} accent="cyan" />
        <StatCard label="Avg Fee" value={`${formatNumber(avgFee)} lovelace`} accent="cyan" />
      </div>

      <div className="glass-panel rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground uppercase">
              <th className="text-left p-3">Tx Hash</th>
              <th className="text-right p-3">Size</th>
              <th className="text-right p-3">Fee (lovelace)</th>
              <th className="text-right p-3">Received</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => (
              <tr key={tx.txHash} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="p-3"><CopyHash hash={tx.txHash} /></td>
                <td className="p-3 text-right text-muted-foreground">{formatBytes(tx.size)}</td>
                <td className="p-3 text-right neon-text-cyan">{formatNumber(tx.fee)}</td>
                <td className="p-3 text-right text-muted-foreground">{tx.receivedAt ? new Date(tx.receivedAt).toLocaleTimeString() : "—"}</td>
              </tr>
            ))}
            {txs.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">Mempool is empty</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
