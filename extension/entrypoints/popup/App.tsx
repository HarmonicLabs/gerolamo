import { createSignal, Show, For, type Component } from "solid-js";
import { useBackgroundNode } from "@/lib/background-bridge";
import { NAV_ITEMS, type NavItemId } from "@/lib/constants";
import Overview from "@/pages/Overview";
import NodePage from "@/pages/Node";
import Wallet from "@/pages/Wallet";
import Blocks from "@/pages/Blocks";
import Peers from "@/pages/Peers";
import Explorer from "@/pages/Explorer";

// ---------------------------------------------------------------------------
// Icons for navigation tabs
// ---------------------------------------------------------------------------
const NAV_ICONS: Record<string, () => any> = {
  grid: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  ),
  cpu: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <line x1="8" y1="1" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="15" />
      <line x1="1" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="15" y2="8" />
    </svg>
  ),
  key: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="5" cy="8" r="3" />
      <line x1="8" y1="8" x2="15" y2="8" />
      <line x1="13" y1="6" x2="13" y2="8" />
    </svg>
  ),
  blocks: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="1" y="1" width="14" height="4" rx="1" />
      <rect x="1" y="6" width="14" height="4" rx="1" />
      <rect x="1" y="11" width="14" height="4" rx="1" />
    </svg>
  ),
  users: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="6" cy="5" r="2.5" />
      <path d="M1 14c0-2.8 2.2-5 5-5s5 2.2 5 14" />
      <circle cx="11" cy="4.5" r="2" />
      <path d="M15 13.5c0-2-1.5-3.5-3.5-4" />
    </svg>
  ),
  search: () => (
    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="14.5" y2="14.5" />
    </svg>
  ),
};

const App: Component = () => {
  const [activePage, setActivePage] = createSignal<NavItemId>("overview");
  // Background bridge — consensus runs in the service worker
  const bg = useBackgroundNode();

  return (
    <div class="w-[400px] h-[600px] flex flex-col bg-bg bg-mesh bg-grid-subtle overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-raised/50">
        <div class="flex items-center gap-2">
          <div class="w-5 h-5 rounded bg-accent/20 flex items-center justify-center">
            <span class="text-[10px] font-bold text-accent">G</span>
          </div>
          <span class="text-[13px] font-bold text-text tracking-tight">Gerolamo</span>
          <span class="text-[9px] font-mono text-text-muted bg-bg-raised px-1.5 py-0.5 rounded border border-border-subtle">
            preprod
          </span>
        </div>
        <div class="flex items-center gap-2">
          <div
            class="h-2 w-2 rounded-full"
            classList={{
              "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]": bg.state() === "synced",
              "bg-yellow-400 animate-pulse": bg.state() === "connecting" || bg.state() === "handshaking" || bg.state() === "syncing",
              "bg-red-400": bg.state() === "error",
              "bg-text-muted": bg.state() === "disconnected",
            }}
          />
          <span class="text-[9px] font-mono text-text-dim">v0.1.0</span>
        </div>
      </div>

      {/* Tab navigation — scrollable for 6 tabs */}
      <div class="flex border-b border-border bg-bg-raised/30 overflow-x-auto">
        <For each={NAV_ITEMS}>
          {(item) => (
            <button
              onClick={() => setActivePage(item.id)}
              class="flex-none flex items-center justify-center gap-1 px-2.5 py-2 text-[10px] font-medium transition-colors relative whitespace-nowrap"
              classList={{
                "text-accent": activePage() === item.id,
                "text-text-muted hover:text-text": activePage() !== item.id,
              }}
            >
              {NAV_ICONS[item.icon]?.()}
              {item.label}
              <Show when={activePage() === item.id}>
                <div class="absolute bottom-0 left-1/4 right-1/4 h-[2px] bg-accent rounded-full" />
              </Show>
            </button>
          )}
        </For>
      </div>

      {/* Page content — passes background state down */}
      <div class="flex-1 overflow-y-auto">
        <Show when={activePage() === "overview"}>
          <Overview state={bg.state} tipSlot={bg.tipSlot} blocksReceived={bg.blocksReceived} />
        </Show>
        <Show when={activePage() === "node"}>
          <NodePage
            state={bg.state}
            tipSlot={bg.tipSlot}
            blocksReceived={bg.blocksReceived}
            connect={bg.connect}
            disconnect={bg.disconnect}
          />
        </Show>
        <Show when={activePage() === "wallet"}>
          <Wallet />
        </Show>
        <Show when={activePage() === "blocks"}>
          <Blocks />
        </Show>
        <Show when={activePage() === "peers"}>
          <Peers />
        </Show>
        <Show when={activePage() === "explorer"}>
          <Explorer />
        </Show>
      </div>

      {/* Footer */}
      <div class="px-3 py-1.5 border-t border-border bg-bg-raised/30 flex items-center justify-between">
        <span class="text-[9px] text-text-dim">Harmonic Labs</span>
        <span class="text-[9px] text-text-dim font-mono">websockify | Ouroboros Praos</span>
      </div>
    </div>
  );
};

export default App;
