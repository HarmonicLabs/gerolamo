import { createSignal, Show, type Component } from "solid-js";
import { cn } from "@/lib/cn";
import type { DiagramBlock, DiagramTx } from "./types";
import {
  ERA_COLORS,
  ERA_NAMES,
  HEALTH_COLORS,
  EASE_SMOOTH,
} from "./types";
import TxStack from "./TxStack";

interface BlockNodeProps {
  block: DiagramBlock;
  selected: boolean;
  onSelect: (block: DiagramBlock) => void;
}

const BlockNode: Component<BlockNodeProps> = (props) => {
  const [hovered, setHovered] = createSignal(false);

  const eraColor = () => ERA_COLORS[props.block.era] ?? "#9AA6B2";
  const eraName = () => ERA_NAMES[props.block.era] ?? "?";
  const healthColor = () => HEALTH_COLORS[props.block.health];

  const timeSince = () => {
    const sec = Math.floor((Date.now() - props.block.receivedAt) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  };

  /** Placeholder txs — real data would come from an API call on expand */
  const txs = (): DiagramTx[] => [];

  const handleClick = () => {
    props.onSelect(props.block);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onSelect(props.block);
    }
  };

  return (
    <div
      class="group relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Tooltip on hover — uses opacity/pointer-events transition */}
      <div
        class="absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg-overlay px-3 py-2 text-[10px] shadow-lg"
        style={{
          opacity: hovered() && !props.selected ? "1" : "0",
          "pointer-events": hovered() && !props.selected ? "auto" : "none",
          transition: `opacity 150ms ${EASE_SMOOTH}, transform 150ms ${EASE_SMOOTH}`,
          transform: hovered() && !props.selected
            ? "translateY(-50%) translateX(0)"
            : "translateY(-50%) translateX(-4px)",
          "box-shadow": `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${healthColor()}15`,
        }}
        role="tooltip"
        aria-hidden={!(hovered() && !props.selected)}
      >
        <div class="flex flex-col gap-0.5">
          <span class="text-text-secondary">
            Slot <span class="font-mono text-text font-semibold">{props.block.slot.toLocaleString()}</span>
          </span>
          <span class="font-mono text-text-dim">{props.block.hash}</span>
          <span class="text-text-muted">
            Parent: <span class="font-mono">{props.block.prevHash.slice(0, 16)}...</span>
          </span>
          <span class="text-text-muted">
            {props.block.insertedAt ? new Date(props.block.insertedAt).toLocaleString() : timeSince()}
          </span>
          <Show when={props.block.totalFees > 0}>
            <span class="text-text-muted">
              Fees: <span class="font-mono text-text-dim">{(props.block.totalFees / 1_000_000).toFixed(3)} ADA</span>
            </span>
          </Show>
          <span class="text-text-muted">
            {props.block.txCount} tx{props.block.txCount !== 1 ? "s" : ""} &middot; {props.block.size.toLocaleString()} bytes
          </span>
        </div>
      </div>

      {/* Block brick */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        class={cn(
          "relative flex items-start gap-2.5 rounded-[var(--radius-sm)] border px-3 py-2 transition-all duration-200 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
          props.selected
            ? "border-transparent"
            : props.block.isNew
              ? "border-accent/20 bg-accent/[0.03]"
              : "border-border-subtle hover:border-border",
        )}
        style={{
          "box-shadow": props.selected
            ? `0 0 12px ${healthColor()}30, 0 0 0 1px ${healthColor()}60, inset 0 0 8px ${healthColor()}08`
            : hovered()
              ? `0 2px 12px rgba(0,0,0,0.2)`
              : "none",
          "border-color": props.selected ? `${healthColor()}60` : undefined,
          "transition-timing-function": EASE_SMOOTH,
        }}
      >
        {/* Left: era color dot */}
        <div class="relative mt-1 shrink-0">
          <div
            class="h-3 w-3 rounded-full border-2 transition-all duration-300"
            style={{
              "border-color": props.block.isNew || props.selected ? eraColor() : `${eraColor()}40`,
              background: props.block.isNew || props.selected ? eraColor() : `${eraColor()}20`,
              "box-shadow": props.block.isNew ? `0 0 6px ${eraColor()}40` : "none",
            }}
          />
        </div>

        {/* Right: block info */}
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Slot + era badge */}
          <div class="flex items-center gap-2">
            <span class="font-mono text-[12px] font-semibold tabular-nums text-text">
              {props.block.slot.toLocaleString()}
            </span>
            <span
              class="rounded-sm px-1 py-[1px] text-[9px] font-bold uppercase tracking-wider"
              style={{
                color: eraColor(),
                background: `${eraColor()}10`,
                border: `1px solid ${eraColor()}20`,
              }}
            >
              {eraName()}
            </span>
            {/* Health indicator */}
            <div
              class="ml-auto h-[5px] w-[5px] rounded-full shrink-0"
              style={{
                background: healthColor(),
                "box-shadow": `0 0 4px ${healthColor()}50`,
              }}
              title={props.block.health}
            />
          </div>

          {/* Hash (short) */}
          <span class="font-mono text-[10px] text-text-muted truncate">
            {props.block.hash.slice(0, 8)}...{props.block.hash.slice(-4)}
          </span>

          {/* Tx count + time */}
          <div class="flex items-center gap-2">
            <Show
              when={props.block.txCount > 0}
              fallback={
                <span class="text-[10px] text-text-muted font-mono">0 txs</span>
              }
            >
              <TxStack
                txCount={props.block.txCount}
                txs={txs()}
                eraColor={eraColor()}
              />
            </Show>
            <span class="ml-auto text-[10px] text-text-muted">{timeSince()}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BlockNode;
