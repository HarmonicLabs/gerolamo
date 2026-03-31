import { Show, type Component } from "solid-js";
import type { DiagramTx } from "./types";

interface TxCardProps {
  tx: DiagramTx;
}

const TxCard: Component<TxCardProps> = (props) => {
  return (
    <div class="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border-subtle bg-bg-sunken/50 px-2.5 py-2 transition-colors duration-150 hover:border-border">
      {/* Hash row */}
      <div class="flex items-center gap-2">
        <span class="font-mono text-[11px] text-text-dim truncate" title={props.tx.hash}>
          {props.tx.hash.slice(0, 16)}...
        </span>
        <Show when={props.tx.hasScripts}>
          <div
            class="h-[6px] w-[6px] rounded-full shrink-0"
            style={{
              background: props.tx.scriptValid ? "#00E676" : "#FF4466",
              "box-shadow": `0 0 4px ${props.tx.scriptValid ? "rgba(0,230,138,0.4)" : "rgba(255,68,102,0.4)"}`,
            }}
            title={props.tx.scriptValid ? "Script passed" : "Script failed"}
          />
        </Show>
      </div>

      {/* Info row */}
      <div class="flex items-center gap-2 text-[10px] text-text-muted">
        {/* Fee */}
        <span class="font-mono tabular-nums">
          {props.tx.fee > 0
            ? `${(props.tx.fee / 1_000_000).toFixed(3)} ADA`
            : "—"}
        </span>

        {/* I/O flow */}
        <span class="flex items-center gap-0.5 font-mono">
          <span class="text-accent">{props.tx.inputCount}</span>
          <svg width="10" height="8" viewBox="0 0 10 8" class="text-text-muted">
            <path d="M1 4h6M5 1.5L7.5 4 5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="text-green">{props.tx.outputCount}</span>
        </span>

        {/* Badges */}
        <Show when={props.tx.hasCollateral}>
          <span class="rounded-sm bg-amber-dim px-1 py-px text-[9px] font-bold uppercase tracking-wider text-amber">
            col
          </span>
        </Show>
        <Show when={props.tx.hasMint}>
          <span class="rounded-sm bg-purple-dim px-1 py-px text-[9px] font-bold uppercase tracking-wider text-purple">
            mint
          </span>
        </Show>
      </div>
    </div>
  );
};

export default TxCard;
