import type { Component } from "solid-js";
import { cn } from "@/lib/cn";

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  class?: string;
  accent?: boolean;
  glow?: boolean;
  glowColor?: "red" | "orange" | "green" | "cyan";
  size?: "sm" | "md" | "lg";
}

export const Stat: Component<StatProps> = (props) => {
  const sz = props.size ?? "md";
  const gc = props.glowColor ?? "red";
  return (
    <div class={cn("flex flex-col items-center text-center gap-1", props.class)}>
      <span class="text-[11px] uppercase tracking-[0.08em] text-text-dim font-medium">
        {props.label}
      </span>
      <span
        class={cn(
          "font-mono font-bold leading-none tabular-nums",
          sz === "sm" && "text-[16px]",
          sz === "md" && "text-[22px]",
          sz === "lg" && "text-[32px]",
          props.accent ? "text-accent" : "text-text",
          props.glow && props.accent && gc === "red" && "text-glow",
          props.glow && props.accent && gc === "orange" && "text-glow-orange",
          props.glow && props.accent && gc === "green" && "text-glow-green",
          props.glow && props.accent && gc === "cyan" && "text-glow-cyan",
        )}
      >
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </span>
      {props.sub && (
        <span class="text-[11px] text-text-muted">{props.sub}</span>
      )}
    </div>
  );
};
