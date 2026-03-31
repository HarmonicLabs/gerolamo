import type { Component, JSX } from "solid-js";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// SkeletonLine -- animated shimmer bar (configurable width/height)
// ---------------------------------------------------------------------------
interface SkeletonLineProps {
  width?: string;
  height?: string;
  class?: string;
}

export const SkeletonLine: Component<SkeletonLineProps> = (props) => (
  <div
    class={cn(
      "rounded-[var(--radius-sm)] bg-bg-raised skeleton-shimmer",
      props.class,
    )}
    style={{
      width: props.width ?? "100%",
      height: props.height ?? "14px",
    }}
    aria-hidden="true"
  />
);

// ---------------------------------------------------------------------------
// SkeletonCard -- card-shaped placeholder with shimmer
// ---------------------------------------------------------------------------
interface SkeletonCardProps {
  lines?: number;
  class?: string;
}

export const SkeletonCard: Component<SkeletonCardProps> = (props) => {
  const count = props.lines ?? 3;
  return (
    <div
      class={cn(
        "glass-card p-5 flex flex-col gap-3",
        props.class,
      )}
      aria-hidden="true"
    >
      {/* Title line */}
      <SkeletonLine width="45%" height="16px" />
      {/* Body lines */}
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonLine
          width={`${85 - i * 12}%`}
          height="12px"
          class={i === count - 1 ? "opacity-60" : ""}
        />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// SkeletonTable -- table with shimmer rows
// ---------------------------------------------------------------------------
interface SkeletonTableProps {
  rows?: number;
  cols?: number;
  class?: string;
}

export const SkeletonTable: Component<SkeletonTableProps> = (props) => {
  const rows = props.rows ?? 5;
  const cols = props.cols ?? 4;
  return (
    <div
      class={cn("glass-card overflow-hidden", props.class)}
      aria-hidden="true"
    >
      {/* Header row */}
      <div
        class="flex gap-4 px-5 py-3 border-b border-border-subtle"
        style={{ "background-color": "rgba(255,45,85,0.03)" }}
      >
        {Array.from({ length: cols }).map(() => (
          <SkeletonLine width="80px" height="10px" />
        ))}
      </div>
      {/* Body rows */}
      {Array.from({ length: rows }).map((_, ri) => (
        <div
          class="flex gap-4 px-5 py-3 border-b border-border-subtle/30"
          style={{ "animation-delay": `${ri * 80}ms` }}
        >
          {Array.from({ length: cols }).map((_, ci) => (
            <SkeletonLine
              width={ci === 0 ? "120px" : "64px"}
              height="12px"
            />
          ))}
        </div>
      ))}
    </div>
  );
};
