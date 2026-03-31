import { type Component, Show, For, createSignal, onMount, onCleanup } from "solid-js";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import type { TxDetail as TxDetailType } from "@/lib/api";

export interface TxDetailPanelProps {
  tx: TxDetailType | null;
  onClose: () => void;
}

function formatAda(lovelace: number): string {
  return (lovelace / 1_000_000).toFixed(6);
}

function truncateHash(hash: string, front = 10, back = 6): string {
  if (hash.length <= front + back + 3) return hash;
  return `${hash.slice(0, front)}...${hash.slice(-back)}`;
}

function copyToClipboard(text: string, setCopied: (v: string | null) => void, field: string) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(field);
    setTimeout(() => setCopied(null), 1500);
  });
}

const CopyButton: Component<{ text: string; field: string; copied: string | null; setCopied: (v: string | null) => void }> = (props) => (
  <button
    class="flex-shrink-0 p-0.5 rounded hover:bg-accent-dim transition-colors"
    onClick={(e) => { e.stopPropagation(); copyToClipboard(props.text, props.setCopied, props.field); }}
    aria-label={props.copied === props.field ? "Copied" : "Copy to clipboard"}
    title="Copy"
  >
    {props.copied === props.field ? (
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
);

const SectionHeader: Component<{ title: string; count?: number }> = (props) => (
  <div class="flex items-center gap-2 mb-2 mt-4 first:mt-0">
    <span class="text-[11px] uppercase tracking-[0.08em] text-text-muted font-semibold">{props.title}</span>
    <Show when={props.count !== undefined}>
      <Badge variant="muted" class="text-[9px] px-1.5 py-0">{props.count}</Badge>
    </Show>
    <div class="flex-1 h-px bg-border-subtle/50" />
  </div>
);

export const TxDetailPanel: Component<TxDetailPanelProps> = (props) => {
  const [copied, setCopied] = createSignal<string | null>(null);
  let panelRef: HTMLDivElement | undefined;

  // Focus trap and Escape key handler
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      props.onClose();
      return;
    }
    // Basic focus trap within the panel
    if (e.key === "Tab" && panelRef) {
      const focusable = panelRef.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <Show when={props.tx}>
      {(tx) => {
        onMount(() => {
          document.addEventListener("keydown", handleKeyDown);
          // Focus the close button on open
          requestAnimationFrame(() => {
            const closeBtn = panelRef?.querySelector<HTMLElement>("button");
            closeBtn?.focus();
          });
        });
        onCleanup(() => {
          document.removeEventListener("keydown", handleKeyDown);
        });

        return (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Transaction detail"
          class="fixed inset-y-0 right-0 w-full sm:w-[480px] z-50 flex flex-col"
          style={{
            background: "linear-gradient(165deg, rgba(15, 20, 24, 0.98) 0%, rgba(11, 15, 19, 0.99) 100%)",
            "border-left": "1px solid var(--border-stroke)",
            "backdrop-filter": "blur(16px)",
          }}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle/50">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span class="text-[13px] font-semibold text-text">Transaction Detail</span>
            </div>
            <button
              class="p-1.5 rounded-[var(--radius-sm)] hover:bg-accent-dim transition-colors"
              onClick={() => props.onClose()}
              aria-label="Close transaction detail"
              title="Close"
            >
              <svg class="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable content */}
          <div class="flex-1 overflow-y-auto p-4 space-y-1">
            {/* Summary */}
            <div class="glass-card p-3 space-y-2">
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted font-medium">Tx Hash</span>
                <CopyButton text={tx().hash} field="txHash" copied={copied()} setCopied={setCopied} />
              </div>
              <span class="font-mono text-[11px] text-text-secondary break-all">{tx().hash}</span>

              <div class="grid grid-cols-2 gap-3 mt-3">
                <div class="flex flex-col gap-0.5">
                  <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted">Fee</span>
                  <span class="font-mono text-[12px] text-text-secondary">{formatAda(tx().fee)} ADA</span>
                </div>
                <div class="flex flex-col gap-0.5">
                  <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted">Size</span>
                  <span class="font-mono text-[12px] text-text-secondary">{tx().size.toLocaleString()} bytes</span>
                </div>
                <div class="flex flex-col gap-0.5">
                  <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted">Valid Contract</span>
                  <span class={cn("text-[12px] font-semibold", tx().validContract ? "text-green" : "text-red")}>
                    {tx().validContract ? "Yes" : "No"}
                  </span>
                </div>
                <div class="flex flex-col gap-0.5">
                  <span class="text-[10px] uppercase tracking-[0.08em] text-text-muted">Block</span>
                  <span class="font-mono text-[11px] text-text-dim truncate" title={tx().blockHash}>
                    {truncateHash(tx().blockHash, 8, 4)}
                  </span>
                </div>
              </div>
            </div>

            {/* Inputs */}
            <SectionHeader title="Inputs" count={tx().inputs.length} />
            <div class="space-y-1.5">
              <For each={tx().inputs}>
                {(input) => (
                  <div class="glass-card p-2.5 space-y-1">
                    <div class="flex items-center gap-1.5">
                      <span class="font-mono text-[10px] text-text-dim">
                        {truncateHash(input.txHash)}:{input.index}
                      </span>
                      <CopyButton text={`${input.txHash}#${input.index}`} field={`in-${input.txHash}-${input.index}`} copied={copied()} setCopied={setCopied} />
                    </div>
                    <div class="font-mono text-[10px] text-text-muted truncate" title={input.address}>
                      {truncateHash(input.address, 14, 8)}
                    </div>
                    <div class="text-[11px] text-text-secondary">{input.value}</div>
                  </div>
                )}
              </For>
            </div>

            {/* Outputs */}
            <SectionHeader title="Outputs" count={tx().outputs.length} />
            <div class="space-y-1.5">
              <For each={tx().outputs}>
                {(output, i) => (
                  <div class="glass-card p-2.5 space-y-1">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] text-text-muted font-mono">#{i()}</span>
                      <Show when={output.datum}>
                        <Badge variant="cyan" class="text-[9px] px-1 py-0">Datum</Badge>
                      </Show>
                    </div>
                    <div class="font-mono text-[10px] text-text-dim truncate" title={output.address}>
                      {truncateHash(output.address, 14, 8)}
                    </div>
                    <div class="text-[11px] text-text-secondary">{output.value}</div>
                    <Show when={output.datum}>
                      <div class="font-mono text-[9px] text-cyan truncate" title={output.datum}>
                        Datum: {truncateHash(output.datum!, 12, 6)}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            {/* Scripts */}
            <Show when={tx().scripts.length > 0}>
              <SectionHeader title="Scripts" count={tx().scripts.length} />
              <div class="space-y-1.5">
                <For each={tx().scripts}>
                  {(script) => (
                    <div class="glass-card p-2.5 flex items-center gap-2">
                      <span
                        class={cn(
                          "w-2 h-2 rounded-full flex-shrink-0",
                          script.result === "pass" ? "bg-green" : "bg-red",
                        )}
                      />
                      <span class="font-mono text-[10px] text-text-dim truncate flex-1" title={script.hash}>
                        {truncateHash(script.hash)}
                      </span>
                      <Badge
                        variant={script.type.startsWith("Plutus") ? "purple" : "muted"}
                        class="text-[9px] px-1.5 py-0"
                      >
                        {script.type}
                      </Badge>
                      <Badge
                        variant={script.result === "pass" ? "success" : "danger"}
                        class="text-[9px] px-1.5 py-0"
                      >
                        {script.result}
                      </Badge>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Collateral */}
            <Show when={tx().collateral.length > 0}>
              <SectionHeader title="Collateral Inputs" count={tx().collateral.length} />
              <div class="space-y-1.5">
                <For each={tx().collateral}>
                  {(col) => (
                    <div class="glass-card p-2.5">
                      <span class="font-mono text-[10px] text-text-dim">
                        {truncateHash(col.txHash)}:{col.index}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Mint/Burn */}
            <Show when={tx().mint.length > 0}>
              <SectionHeader title="Mint / Burn" count={tx().mint.length} />
              <div class="space-y-1.5">
                <For each={tx().mint}>
                  {(m) => (
                    <div class="glass-card p-2.5 space-y-1">
                      <div class="font-mono text-[10px] text-text-dim truncate" title={m.policyId}>
                        Policy: {truncateHash(m.policyId)}
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-[11px] text-text-secondary">
                          {m.assetName || "(empty)"}
                        </span>
                        <span
                          class={cn(
                            "font-mono text-[11px] font-semibold",
                            BigInt(m.quantity) > 0n ? "text-green" : "text-red",
                          )}
                        >
                          {BigInt(m.quantity) > 0n ? "+" : ""}{m.quantity}
                        </span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Metadata */}
            <Show when={tx().metadata}>
              <SectionHeader title="Metadata" />
              <div class="glass-card p-2.5">
                <pre class="font-mono text-[10px] text-text-dim whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
                  {JSON.stringify(tx().metadata, null, 2)}
                </pre>
              </div>
            </Show>
          </div>
        </div>
        );
      }}
    </Show>
  );
};
