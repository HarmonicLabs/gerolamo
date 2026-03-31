import { createSignal, For, Show, type Component } from "solid-js";
import type { DiagramTx } from "./types";
import { EASE_SMOOTH } from "./types";
import TxCard from "./TxCard";

interface TxStackProps {
  txCount: number;
  /** Lazy-loaded transactions — may be empty if not yet fetched */
  txs: DiagramTx[];
  eraColor: string;
}

const TxStack: Component<TxStackProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  };

  return (
    <div class="flex flex-col">
      {/* Toggle button */}
      <button
        onClick={toggle}
        aria-expanded={expanded()}
        aria-label={`${props.txCount} transaction${props.txCount !== 1 ? "s" : ""}, ${expanded() ? "collapse" : "expand"}`}
        class="flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] transition-colors duration-150 hover:bg-bg-overlay/50"
        title={expanded() ? "Collapse transactions" : "Expand transactions"}
      >
        {/* Stack icon */}
        <svg width="12" height="12" viewBox="0 0 12 12" class="shrink-0">
          <rect x="1" y="1" width="10" height="3" rx="0.5" fill={`${props.eraColor}30`} stroke={`${props.eraColor}60`} stroke-width="0.5" />
          <rect x="2" y="5" width="8" height="2" rx="0.5" fill={`${props.eraColor}15`} stroke={`${props.eraColor}30`} stroke-width="0.5" />
          <rect x="3" y="8" width="6" height="2" rx="0.5" fill={`${props.eraColor}10`} stroke={`${props.eraColor}20`} stroke-width="0.5" />
        </svg>

        <span class="font-mono tabular-nums" style={{ color: props.eraColor }}>
          {props.txCount}
        </span>
        <span class="text-text-muted">
          tx{props.txCount !== 1 ? "s" : ""}
        </span>

        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          class="text-text-muted transition-transform duration-200"
          style={{
            transform: expanded() ? "rotate(180deg)" : "rotate(0deg)",
            "transition-timing-function": EASE_SMOOTH,
          }}
        >
          <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>

        {/* Collapsed count badge */}
        <Show when={!expanded() && props.txCount > 0}>
          <span
            class="ml-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-1 text-[8px] font-bold tabular-nums"
            style={{
              background: `${props.eraColor}18`,
              color: props.eraColor,
              border: `1px solid ${props.eraColor}30`,
            }}
          >
            {props.txCount}
          </span>
        </Show>
      </button>

      {/* Expandable list — CSS max-height transition 300ms ease-out */}
      <div
        class="overflow-hidden transition-all duration-300"
        style={{
          "max-height": expanded() ? `${Math.max(props.txs.length, props.txCount) * 60 + 16}px` : "0px",
          opacity: expanded() ? "1" : "0",
          "transition-timing-function": "ease-out",
        }}
      >
        <div class="flex flex-col gap-1 pt-1.5 pl-1">
          <Show
            when={props.txs.length > 0}
            fallback={
              <div class="flex items-center gap-2 px-2 py-2 text-[10px] text-text-muted">
                <div class="h-1.5 w-1.5 rounded-full bg-text-muted/30 pulse-live" />
                Transaction details not available
              </div>
            }
          >
            <For each={props.txs}>
              {(tx) => <TxCard tx={tx} />}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default TxStack;
