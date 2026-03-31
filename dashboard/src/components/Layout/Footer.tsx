import { type Component, Show, createMemo } from "solid-js";
import { useSSE, type NodeStatus } from "@/lib/api";

// ---------------------------------------------------------------------------
// Empty initial status
// ---------------------------------------------------------------------------
const emptyStatus: NodeStatus = {
  tip: { slot: 0, hash: "", epoch: 0, era: 0 },
  sync: { progress: 0, speed: 0, startedAt: "" },
  uptime: 0,
  network: "",
  volatileBlocks: 0,
  immutableBlocks: 0,
  utxoCount: 0,
  mempoolSize: 0,
  gcCycles: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncateHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const Footer: Component = () => {
  const { data: status } = useSSE<NodeStatus>("/sse/status", emptyStatus);

  const peerEstimate = createMemo(() => {
    // Peer count is not directly on NodeStatus; use volatileBlocks > 0 as proxy for connectivity.
    // A dedicated /api/peers endpoint would be better — this is a UI-only approximation.
    return status().volatileBlocks > 0 ? "connected" : "no peers";
  });

  return (
    <footer
      class="relative z-30 flex items-center h-8 shrink-0 border-t border-border bg-bg-raised/80 backdrop-blur-sm px-5 gap-5"
      role="contentinfo"
      aria-label="Node status footer"
    >
      {/* Slot */}
      <Show when={status().tip.slot > 0}>
        <span class="text-[11px] font-mono text-text-dim tabular-nums">
          Slot {status().tip.slot.toLocaleString()}
        </span>
      </Show>

      {/* Tip hash */}
      <Show when={status().tip.hash}>
        <span class="text-[11px] font-mono text-text-muted tabular-nums hide-mobile">
          {truncateHash(status().tip.hash)}
        </span>
      </Show>

      {/* Peer connectivity */}
      <span class="text-[11px] text-text-dim hide-mobile">{peerEstimate()}</span>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Runtime badge */}
      <span class="text-[11px] font-mono text-text-muted">Bun v1.3.10</span>
    </footer>
  );
};
