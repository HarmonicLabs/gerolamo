import { type Component, Show, createMemo } from "solid-js";
import { cn } from "@/lib/cn";
import { useSSE, type NodeStatus } from "@/lib/api";
import { NAV_ITEMS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface TopbarProps {
  activePage: string;
}

// ---------------------------------------------------------------------------
// Empty initial status (all zeros) used before SSE delivers data
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
// Component
// ---------------------------------------------------------------------------
export const Topbar: Component<TopbarProps> = (props) => {
  const { data: status, connected } = useSSE<NodeStatus>("/sse/status", emptyStatus);

  const pageTitle = createMemo(() => {
    const item = NAV_ITEMS.find((n) => n.id === props.activePage);
    return item?.label ?? "Dashboard";
  });

  const syncPct = createMemo(() => {
    const p = status().sync.progress;
    return Math.min(100, Math.round(p * 10000) / 100);
  });

  return (
    <header
      class="relative z-40 flex items-center h-12 shrink-0 border-b border-border bg-bg-card/90 backdrop-blur-md px-5"
      role="banner"
    >
      {/* Top edge glow */}
      <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/20 to-transparent" />

      {/* Left — page title */}
      <h1 class="text-[15px] font-semibold text-text tracking-tight">
        {pageTitle()}
      </h1>

      {/* Right — status cluster */}
      <div class="ml-auto flex items-center gap-4" role="status" aria-live="polite" aria-label="Node connection status">
        {/* Connection indicator */}
        <div class="flex items-center gap-2">
          <div
            class={cn(
              "h-[7px] w-[7px] rounded-full",
              connected()
                ? "bg-green pulse-live-green"
                : "bg-red pulse-live",
            )}
            aria-hidden="true"
          />
          <span class="text-[11px] font-medium text-text-secondary">
            {connected() ? "Connected" : "Disconnected"}
          </span>
        </div>

        {/* Sync percentage */}
        <Show when={status().sync.progress > 0}>
          <span
            class={cn(
              "text-[11px] font-mono font-semibold tabular-nums",
              syncPct() >= 99.9 ? "text-green" : "text-amber",
            )}
          >
            {syncPct().toFixed(2)}%
          </span>
        </Show>

        {/* Current slot */}
        <Show when={status().tip.slot > 0}>
          <span class="text-[11px] font-mono text-text-dim tabular-nums hide-mobile">
            Slot {status().tip.slot.toLocaleString()}
          </span>
        </Show>
      </div>
    </header>
  );
};
