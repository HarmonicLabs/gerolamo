import { usePeers, useSSE, type Peer } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";

function categoryColor(category: string, connected: boolean) {
  if (!connected) return "bg-muted text-muted-foreground border-border";
  switch (category) {
    case "bootstrap": return "bg-green-500/20 text-green-400 border-green-500/30";
    case "localRoot": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    default: return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  }
}

export default function PeersPage() {
  const { data: peers = [], isLoading } = usePeers();
  const qc = useQueryClient();
  useSSE<Peer[]>("peers", (p) => qc.setQueryData(["peers"], p));

  const connected = peers.filter((p) => p.connected).length;
  const disconnected = peers.length - connected;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading peers...</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Peers</h1>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "CONNECTED", count: connected, color: "bg-green-500/20 text-green-400 border-green-500/30" },
          { label: "DISCONNECTED", count: disconnected, color: "bg-muted text-muted-foreground border-border" },
          { label: "TOTAL", count: peers.length, color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
        ].map((s) => (
          <div key={s.label} className="glass-panel rounded-lg p-4 text-center">
            <Badge className={`${s.color} border mb-2`}>{s.label}</Badge>
            <p className="text-2xl font-bold neon-text-cyan">{s.count}</p>
          </div>
        ))}
      </div>

      <div className="glass-panel rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground uppercase">
              <th className="text-left p-3">Host</th>
              <th className="text-left p-3">Port</th>
              <th className="text-left p-3">Category</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Tip Slot</th>
            </tr>
          </thead>
          <tbody>
            {peers.map((peer) => (
              <tr key={peer.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="p-3 font-mono neon-text-cyan">{peer.host}</td>
                <td className="p-3 text-muted-foreground">{peer.port}</td>
                <td className="p-3">
                  <Badge className={`${categoryColor(peer.category, peer.connected)} border text-xs`}>{peer.category}</Badge>
                </td>
                <td className="p-3">
                  <span className={peer.connected ? "text-green-400" : "text-muted-foreground"}>
                    {peer.connected ? "Connected" : "Disconnected"}
                  </span>
                </td>
                <td className="p-3 text-right">{peer.slot > 0 ? formatNumber(peer.slot) : "—"}</td>
              </tr>
            ))}
            {peers.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No peers configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Peer network visualization */}
      {peers.length > 0 && (
        <div className="glass-panel rounded-lg p-6">
          <h3 className="text-sm text-muted-foreground mb-4">Peer Network</h3>
          <svg viewBox="0 0 400 200" className="w-full max-w-xl mx-auto">
            <circle cx="200" cy="100" r="20" fill="none" stroke="hsl(348,100%,50%)" strokeWidth="2" className="animate-pulse-glow" />
            <text x="200" y="104" textAnchor="middle" fill="hsl(348,100%,50%)" fontSize="8" fontFamily="monospace">YOU</text>

            {peers.map((peer, i) => {
              const angle = (i / peers.length) * Math.PI * 2 - Math.PI / 2;
              const x = 200 + Math.cos(angle) * 80;
              const y = 100 + Math.sin(angle) * 70;
              const color = peer.connected ? "#22c55e" : "#6b7280";
              return (
                <g key={peer.id}>
                  <line x1="200" y1="100" x2={x} y2={y} stroke={color} strokeWidth="1" opacity="0.4" />
                  <circle cx={x} cy={y} r="10" fill="none" stroke={color} strokeWidth="1.5" />
                  <text x={x} y={y + 3} textAnchor="middle" fill={color} fontSize="5" fontFamily="monospace">
                    {peer.host.split('.').slice(-1)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
