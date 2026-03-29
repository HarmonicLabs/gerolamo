import type { Component } from "solid-js";
import { cn } from "@/lib/cn";

interface ProgressBarProps {
  value: number;
  class?: string;
}

export const ProgressBar: Component<ProgressBarProps> = (props) => (
  <div class={cn("h-2 w-full overflow-hidden rounded-full bg-bg-sunken", props.class)}>
    <div
      class="h-full rounded-full bg-accent transition-all duration-500"
      style={{ width: `${Math.min(100, Math.max(0, props.value))}%` }}
    />
  </div>
);
