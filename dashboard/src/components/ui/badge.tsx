import type { Component, JSX } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
  {
    variants: {
      variant: {
        default: "bg-accent-dim text-accent",
        success: "bg-green-dim text-green",
        warning: "bg-[rgba(245,158,11,0.1)] text-amber",
        danger: "bg-red-dim text-red",
        info: "bg-blue-dim text-blue",
        muted: "bg-border text-text-dim",
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
