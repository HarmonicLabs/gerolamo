import type { Component } from "solid-js";
import { cn } from "../../lib/cn";

interface ProgressBarProps {
  value: number;
  class?: string;
  variant?: "accent" | "green" | "orange" | "cyan";
}

const colors = {
  accent: "bg-accent shadow-[0_0_12px_rgba(255,45,85,0.3)]",
  green: "bg-green shadow-[0_0_12px_rgba(0,230,118,0.3)]",
  orange: "bg-amber shadow-[0_0_12px_rgba(255,138,0,0.3)]",
  cyan: "bg-blue shadow-[0_0_12px_rgba(0,179,255,0.3)]",
};

export const ProgressBar: Component<ProgressBarProps> = (props) => (
  <div
    class={cn("relative h-[6px] w-full overflow-hidden rounded-full bg-bg-sunken", props.class)}
    role="progressbar"
    aria-valuenow={Math.min(100, Math.max(0, Math.round(props.value * 100) / 100))}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label="Sync progress"
  >
    <div
      class={cn("h-full rounded-full transition-all duration-700 ease-out", colors[props.variant ?? "accent"])}
      style={{ width: `${Math.min(100, Math.max(0, props.value))}%` }}
    />
  </div>
);
