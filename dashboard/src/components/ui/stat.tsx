import type { Component, JSX } from "solid-js";
import { cn } from "@/lib/cn";

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  class?: string;
  accent?: boolean;
}

export const Stat: Component<StatProps> = (props) => (
  <div class={cn("flex flex-col gap-0.5", props.class)}>
    <span class="text-[10px] font-medium uppercase tracking-wider text-text-muted">
      {props.label}
    </span>
    <span
      class={cn(
        "font-mono text-lg font-semibold tabular-nums",
        props.accent ? "text-accent" : "text-text",
      )}
    >
      {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
    </span>
    {props.sub && <span class="text-[10px] text-text-dim">{props.sub}</span>}
  </div>
);
