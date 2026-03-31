import type { Component, JSX } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-[2px] text-[11px] font-semibold leading-[16px]",
  {
    variants: {
      variant: {
        default: "border-accent/20 bg-accent-dim text-accent",
        success: "border-green/20 bg-green-dim text-green",
        warning: "border-amber/20 bg-amber-dim text-amber",
        danger: "border-red/20 bg-red-dim text-red",
        info: "border-blue/20 bg-blue-dim text-blue",
        muted: "border-border bg-bg-overlay text-text-secondary",
        neon: "border-accent/25 bg-accent-dim text-accent shadow-[0_0_8px_rgba(255,45,85,0.12)]",
        magenta: "border-magenta/20 bg-magenta-dim text-magenta",
        purple: "border-purple/20 bg-purple-dim text-purple",
        orange: "border-orange/20 bg-orange-dim text-orange",
        cyan: "border-cyan/20 bg-cyan-dim text-cyan",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type BadgeProps = JSX.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export const Badge: Component<BadgeProps> = (props) => (
  <span
    {...props}
    class={cn(badgeVariants({ variant: props.variant }), props.class)}
  />
);
