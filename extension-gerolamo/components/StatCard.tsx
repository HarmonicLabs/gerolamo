import { Show } from "solid-js";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "red" | "cyan";
}

export function StatCard(props: StatCardProps) {
  const accent = () => props.accent ?? "cyan";
  return (
    <div class={`glass-panel rounded-lg p-3 border ${accent() === "red" ? "neon-border-red" : "neon-border-cyan"} transition-all`}>
      <p class="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{props.label}</p>
      <p class={`text-lg font-bold leading-tight ${accent() === "red" ? "neon-text-red" : "neon-text-cyan"}`}>{props.value}</p>
      <Show when={props.sub}>
        <p class="text-[10px] text-muted-foreground mt-0.5">{props.sub}</p>
      </Show>
    </div>
  );
}
