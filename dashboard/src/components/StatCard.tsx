interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "red" | "cyan";
}

export function StatCard({ label, value, sub, accent = "cyan" }: StatCardProps) {
  return (
    <div className={`glass-panel rounded-lg p-4 border ${accent === "red" ? "neon-border-red" : "neon-border-cyan"} transition-all`}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent === "red" ? "neon-text-red" : "neon-text-cyan"}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
