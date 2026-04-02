import type { Component } from "solid-js";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";

export interface TxRowData {
  hash: string;
  fee: number;
  inputCount: number;
  outputCount: number;
  hasScripts: boolean;
  hasCollateral: boolean;
  hasMint: boolean;
  scriptResult?: boolean;
}

export interface TxRowProps {
  tx: TxRowData;
  onClick?: () => void;
}

function formatAda(lovelace: number): string {
  return (lovelace / 1_000_000).toFixed(3);
}

export const TxRow: Component<TxRowProps> = (props) => {
  return (
    <div
      class={cn(
        "flex items-center gap-3 px-4 h-[40px] cursor-pointer select-none",
        "border-b border-border-subtle/30 last:border-b-0",
        "hover:bg-accent-dim/40 transition-colors duration-150",
      )}
      onClick={() => props.onClick?.()}
      role="button"
      tabIndex={0}
      aria-label={`Transaction ${props.tx.hash.slice(0, 8)}, fee ${(props.tx.fee / 1_000_000).toFixed(3)} ADA`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick?.();
        }
      }}
    >
      {/* Tx hash truncated: 8...4 */}
      <span class="font-mono text-[11px] text-text-secondary min-w-[110px]" title={props.tx.hash}>
        {props.tx.hash.slice(0, 8)}...{props.tx.hash.slice(-4)}
      </span>

      {/* Inputs -> Outputs */}
      <span class="flex items-center gap-1 text-[11px] text-text-dim min-w-[60px]">
        <span class="font-mono tabular-nums">{props.tx.inputCount}</span>
        <svg class="w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
        <span class="font-mono tabular-nums">{props.tx.outputCount}</span>
      </span>

      {/* Fee in ADA */}
      <span class="font-mono text-[11px] text-text-dim tabular-nums min-w-[70px]">
        {formatAda(props.tx.fee)} ADA
      </span>

      {/* Badge indicators */}
      <div class="flex items-center gap-1 flex-1">
        {props.tx.hasScripts && (
          <span class="flex items-center gap-1">
            <svg class="w-3 h-3 text-purple" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M10 12l-2 2 2 2M14 12l2 2-2 2" />
            </svg>
            {props.tx.scriptResult !== undefined && (
              <span
                class={cn(
                  "w-1.5 h-1.5 rounded-full",
                  props.tx.scriptResult ? "bg-green" : "bg-red",
                )}
                title={props.tx.scriptResult ? "Scripts passed" : "Scripts failed"}
              />
            )}
          </span>
        )}
        {props.tx.hasCollateral && (
          <Badge variant="orange" class="text-[9px] px-1 py-0 leading-[14px]">C</Badge>
        )}
        {props.tx.hasMint && (
          <Badge variant="purple" class="text-[9px] px-1 py-0 leading-[14px]">M</Badge>
        )}
      </div>

      {/* Arrow indicator */}
      <svg class="w-3.5 h-3.5 text-text-muted/50 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </div>
  );
};
