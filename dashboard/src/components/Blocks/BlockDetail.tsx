import { type Component, createSignal } from "solid-js";
import { cn } from "@/lib/cn";
import type { BlockInfo } from "@/lib/api";

export interface BlockDetailProps {
  block: BlockInfo;
}

function copyToClipboard(text: string, setCopied: (v: string | null) => void, field: string) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(field);
    setTimeout(() => setCopied(null), 1500);
  });
}

const DetailCell: Component<{
  label: string;
  value: string | number;
  mono?: boolean;
  copyable?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}> = (props) => (
  <div class="flex flex-col gap-1 min-w-0">
    <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted font-medium">
      {props.label}
    </span>
    <div class="flex items-center gap-1.5 min-w-0">
      <span
        class={cn(
          "text-[12px] text-text-secondary truncate",
          props.mono && "font-mono",
        )}
        title={String(props.value)}
      >
        {props.value}
      </span>
      {props.copyable && (
        <button
          class="flex-shrink-0 p-0.5 rounded hover:bg-accent-dim transition-colors"
          onClick={props.onCopy}
          aria-label={`Copy ${props.label} to clipboard`}
          title="Copy to clipboard"
        >
          {props.copied ? (
            <svg class="w-3 h-3 text-green" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg class="w-3 h-3 text-text-muted hover:text-text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
        </button>
      )}
    </div>
  </div>
);

export const BlockDetail: Component<BlockDetailProps> = (props) => {
  const [copied, setCopied] = createSignal<string | null>(null);

  return (
    <div class="p-4 glass-card mx-3 mb-3 mt-2 bg-bg-overlay/50">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <DetailCell
          label="Block Hash"
          value={props.block.hash}
          mono
          copyable
          copied={copied() === "hash"}
          onCopy={() => copyToClipboard(props.block.hash, setCopied, "hash")}
        />
        <DetailCell
          label="Parent Hash"
          value={props.block.prevHash}
          mono
          copyable
          copied={copied() === "prevHash"}
          onCopy={() => copyToClipboard(props.block.prevHash, setCopied, "prevHash")}
        />
        <DetailCell
          label="Epoch"
          value={props.block.epoch.toLocaleString()}
        />
        <DetailCell
          label="Slot"
          value={props.block.slot.toLocaleString()}
          mono
        />
        <DetailCell
          label="Block Size"
          value={`${(props.block.size / 1024).toFixed(2)} KB (${props.block.size.toLocaleString()} bytes)`}
        />
        <DetailCell
          label="Transactions"
          value={props.block.txCount}
        />
        <DetailCell
          label="Received At"
          value={new Date(props.block.insertedAt).toLocaleString()}
        />
        <DetailCell
          label="Era"
          value={
            ({ 0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary", 4: "Alonzo", 5: "Babbage", 6: "Conway" } as Record<number, string>)[props.block.era] ?? `Era ${props.block.era}`
          }
        />
      </div>
    </div>
  );
};
