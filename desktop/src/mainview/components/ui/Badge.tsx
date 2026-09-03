import type { Component, JSX } from "solid-js";
import { cn } from "../../lib/cn";

const variants: Record<string, string> = {
  default: "border-accent/20 bg-accent-dim text-accent",
  success: "border-green/20 bg-green-dim text-green",
  warning: "border-amber/20 bg-amber-dim text-amber",
  danger: "border-red/20 bg-red-dim text-red",
  muted: "border-border bg-bg-overlay text-text-secondary",
  neon: "border-accent/25 bg-accent-dim text-accent shadow-[0_0_8px_rgba(255,45,85,0.12)]",
  purple: "border-purple/20 bg-purple-dim text-purple",
  cyan: "border-cyan/20 bg-cyan-dim text-cyan",
};

export const Badge: Component<
  JSX.HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }
> = (props) => (
  <span
    {...props}
    class={cn(
      "inline-flex items-center rounded-full border px-2.5 py-[2px] text-[11px] font-semibold leading-[16px]",
      variants[props.variant ?? "default"],
      props.class,
    )}
  />
);
