import type { Component, JSX } from "solid-js";
import { cn } from "@/lib/cn";

export const Card: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div
    {...props}
    class={cn(
      "rounded-[var(--radius)] border border-border bg-bg-raised p-4",
      props.class,
    )}
  />
);

export const CardHeader: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div {...props} class={cn("flex flex-col gap-1.5 pb-3", props.class)} />
);

export const CardTitle: Component<JSX.HTMLAttributes<HTMLHeadingElement>> = (props) => (
  <h3
    {...props}
    class={cn("text-sm font-semibold text-text", props.class)}
  />
);

export const CardDescription: Component<JSX.HTMLAttributes<HTMLParagraphElement>> = (props) => (
  <p {...props} class={cn("text-xs text-text-dim", props.class)} />
);

export const CardContent: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => (
  <div {...props} class={cn("", props.class)} />
);
