import { type Component, Show } from "solid-js";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { BlockInfo } from "@/lib/api";

const ERA_NAMES: Record<number, string> = {
  0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary",
  4: "Alonzo", 5: "Babbage", 6: "Conway",
};

const ERA_VARIANT: Record<number, "muted" | "neon" | "purple" | "magenta" | "default" | "success"> = {
  0: "muted", 1: "neon", 2: "purple", 3: "purple",
  4: "magenta", 5: "success", 6: "neon",
};

const ERA_DOT_COLOR: Record<number, string> = {
  0: "bg-text-muted",
  1: "bg-accent",
  2: "bg-purple",
  3: "bg-purple",
  4: "bg-magenta",
  5: "bg-green",
  6: "bg-accent",
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export interface BlockCardProps {
  block: BlockInfo;
  isExpanded: boolean;
  onToggle: () => void;
  onSelectTx?: (hash: string) => void;
  children?: any;
}

export const BlockCard: Component<BlockCardProps> = (props) => {
  const status = () => {
    // Heuristic: blocks inserted more than 20 minutes ago are likely finalized
    const age = Date.now() - new Date(props.block.insertedAt).getTime();
    return age > 20 * 60 * 1000 ? "finalized" : "volatile";
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onToggle();
    }
  };

  return (
    <div
      class={cn(
        "glass-card group transition-all duration-300 ease-out overflow-hidden",
        props.isExpanded ? "max-h-[2000px]" : "max-h-[56px]",
        props.isExpanded && "border-accent/15 glow-subtle",
      )}
      role="button"
      tabIndex={0}
      aria-expanded={props.isExpanded}
      aria-label={`Block at slot ${props.block.slot.toLocaleString()} with ${props.block.txCount} transactions`}
      onKeyDown={handleKeyDown}
    >
      {/* Collapsed header row — always visible */}
      <div
        class="flex items-center gap-3 px-4 h-[56px] cursor-pointer select-none hover:bg-accent-dim/50 transition-colors duration-150"
        onClick={() => props.onToggle()}
      >
        {/* Expand chevron */}
        <svg
          class={cn(
            "w-3.5 h-3.5 text-text-muted transition-transform duration-300 flex-shrink-0",
            props.isExpanded && "rotate-90",
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>

        {/* Slot */}
        <span class="font-mono text-[13px] font-semibold tabular-nums text-accent min-w-[90px]">
          {props.block.slot.toLocaleString()}
        </span>

        {/* Short hash */}
        <span
          class="font-mono text-[12px] text-text-dim min-w-[80px] truncate hide-mobile"
          title={props.block.hash}
        >
          {props.block.hash.slice(0, 8)}...
        </span>

        {/* Tx count badge */}
        <Badge variant={props.block.txCount > 0 ? "success" : "muted"} class="min-w-[32px] justify-center">
          {props.block.txCount} tx
        </Badge>

        {/* Size */}
        <span class="text-[12px] text-text-dim tabular-nums font-mono hide-mobile">
          {(props.block.size / 1024).toFixed(1)} KB
        </span>

        {/* Era badge with colored dot */}
        <span class="flex items-center gap-1.5 hide-mobile">
          <span class={cn("w-1.5 h-1.5 rounded-full", ERA_DOT_COLOR[props.block.era] ?? "bg-text-muted")} />
          <Badge variant={ERA_VARIANT[props.block.era] ?? "muted"} class="text-[10px] px-1.5">
            {ERA_NAMES[props.block.era] ?? `Era ${props.block.era}`}
          </Badge>
        </span>

        {/* Spacer */}
        <div class="flex-1" />

        {/* Timestamp (relative) */}
        <span class="text-[11px] text-text-dim whitespace-nowrap">
          {relativeTime(props.block.insertedAt)}
        </span>

        {/* Status indicator */}
        <span
          class={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            status() === "finalized"
              ? "bg-green pulse-live-green"
              : "bg-orange pulse-live",
          )}
          role="img"
          aria-label={status() === "finalized" ? "Block finalized" : "Block volatile"}
          title={status() === "finalized" ? "Finalized" : "Volatile"}
        />
      </div>

      {/* Expanded content */}
      <Show when={props.isExpanded}>
        <div class="border-t border-border-subtle/50">
          {props.children}
        </div>
      </Show>
    </div>
  );
};
