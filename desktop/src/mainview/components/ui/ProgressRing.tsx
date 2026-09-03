import type { Component } from "solid-js";
import { cn } from "../../lib/cn";

interface ProgressRingProps {
  value: number;
  size?: number;
  strokeWidth?: number;
  class?: string;
  variant?: "accent" | "green" | "orange" | "cyan";
}

const strokeColors: Record<string, string> = {
  accent: "var(--accent-rog-red)",
  green: "var(--accent-green)",
  orange: "var(--accent-orange)",
  cyan: "var(--accent-cyan)",
};

const glowFilters: Record<string, string> = {
  accent: "drop-shadow(0 0 6px rgba(255,45,85,0.4))",
  green: "drop-shadow(0 0 6px rgba(0,230,118,0.4))",
  orange: "drop-shadow(0 0 6px rgba(255,138,0,0.4))",
  cyan: "drop-shadow(0 0 6px rgba(0,179,255,0.4))",
};

export const ProgressRing: Component<ProgressRingProps> = (props) => {
  const size = () => props.size ?? 120;
  const sw = () => props.strokeWidth ?? 8;
  const radius = () => (size() - sw()) / 2;
  const circumference = () => 2 * Math.PI * radius();
  const clamped = () => Math.min(100, Math.max(0, props.value));
  const offset = () => circumference() - (clamped() / 100) * circumference();
  const variant = () => props.variant ?? "accent";

  return (
    <div class={cn("relative inline-flex items-center justify-center", props.class)}>
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} class="transform -rotate-90">
        <circle
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          stroke-width={sw()}
        />
        <circle
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke={strokeColors[variant()]}
          stroke-width={sw()}
          stroke-linecap="round"
          stroke-dasharray={`${circumference()}`}
          stroke-dashoffset={offset()}
          style={{
            transition: "stroke-dashoffset 0.7s ease-out",
            filter: glowFilters[variant()],
          }}
        />
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center">
        <span class="font-mono text-[22px] font-bold tabular-nums text-text text-glow-strong">
          {clamped().toFixed(1)}
        </span>
        <span class="text-[11px] text-text-dim font-medium">%</span>
      </div>
    </div>
  );
};
