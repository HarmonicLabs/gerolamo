import type { Component, JSX } from "solid-js";
import { cn } from "@/lib/cn";

export const Card: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div
    {...props}
    class={cn("glass-card", props.class)}
  />
);

export const CardHeader: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div
    {...props}
    class={cn("border-b border-[rgba(255,255,255,0.06)] px-5 py-4", props.class)}
  />
);

export const CardTitle: Component<JSX.HTMLAttributes<HTMLHeadingElement>> = (props) => (
  <h3
    {...props}
    class={cn("text-[14px] font-semibold text-text", props.class)}
  />
);

export const CardDescription: Component<JSX.HTMLAttributes<HTMLParagraphElement>> = (props) => (
  <p {...props} class={cn("text-[13px] text-text-secondary mt-1", props.class)} />
);

export const CardContent: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div {...props} class={cn("p-5", props.class)} />
);
