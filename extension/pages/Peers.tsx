import { createSignal, Show, For, onMount, type Component } from "solid-js";
import { fetchPeers, type PeerInfo } from "@/lib/api";
import { getApiBase, initSettings } from "@/lib/settings";

const CATEGORY_COLORS: Record<string, string> = {
  hot: "text-green-400 bg-green-500/10 border-green-500/20",
  warm: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  cold: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  bootstrap: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  localRoot: "text-accent bg-accent/10 border-accent/20",
  new: "text-text-muted bg-bg-raised/50 border-border-subtle",
};

const Peers: Component = () => {
  const [peers, setPeers] = createSignal<PeerInfo[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const apiBase = getApiBase();
      const data = await fetchPeers(apiBase);
      setPeers(data);
    } catch (e: any) {
      setError(e.message || "Failed to fetch peers");
    }
    setLoading(false);
  }

  onMount(async () => {
    await initSettings();
    await refresh();
  });

  const connectedCount = () => peers().filter((p) => p.connected).length;

  return (
    <div class="flex flex-col gap-3 p-3">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-[16px] font-bold text-text mb-0.5">Peers</h1>
          <p class="text-[11px] text-text-muted leading-relaxed">
            Network peers from topology configuration.
          </p>
        </div>
        <button
          onClick={refresh}
          class="px-2 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent text-[9px] font-medium hover:bg-accent/20 transition-colors"
        >
          {loading() ? "..." : "Refresh"}
        </button>
      </div>

      <Show when={error()}>
        <div class="p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-[10px]">
          {error()}
        </div>
      </Show>

      {/* Summary */}
      <div class="glass-card rounded-lg border border-border p-3">
        <div class="grid grid-cols-3 gap-2">
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Total</div>
            <div class="text-[16px] font-mono font-bold text-text tabular-nums">
              {peers().length}
            </div>
          </div>
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Connected</div>
            <div class="text-[16px] font-mono font-bold text-green-400 tabular-nums">
              {connectedCount()}
            </div>
          </div>
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Disconnected</div>
            <div class="text-[16px] font-mono font-bold text-red-400 tabular-nums">
              {peers().length - connectedCount()}
            </div>
          </div>
        </div>
      </div>

      <Show
        when={peers().length > 0}
        fallback={
          <div class="glass-card rounded-lg border border-border p-4 text-center">
            <div class="text-[11px] text-text-muted">
              {loading() ? "Loading peers..." : "No peers found. Is the node running?"}
            </div>
          </div>
        }
      >
        {/* Peer list */}
        <div class="space-y-1.5 max-h-[340px] overflow-y-auto">
          <For each={peers()}>
            {(peer) => {
              const catClass = () => CATEGORY_COLORS[peer.category] ?? CATEGORY_COLORS.new;
              return (
                <div class="glass-card rounded-lg border border-border p-2.5">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-2">
                      <div
                        class="h-2 w-2 rounded-full"
                        classList={{
                          "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)]": peer.connected,
                          "bg-red-400": !peer.connected,
                        }}
                      />
                      <span class="font-mono text-[11px] text-text">{peer.host}</span>
                      <span class="font-mono text-[10px] text-text-dim">:{peer.port}</span>
                    </div>
                    <span class={`px-1.5 py-0.5 rounded text-[8px] font-medium border ${catClass()}`}>
                      {peer.category}
                    </span>
                  </div>
                  <div class="flex items-center gap-3 text-[9px]">
                    <span class="text-text-muted">
                      Status: <span class={peer.connected ? "text-green-400" : "text-red-400"}>
                        {peer.connected ? "Connected" : "Disconnected"}
                      </span>
                    </span>
                    <Show when={peer.slot > 0}>
                      <span class="text-text-muted">
                        Slot: <span class="font-mono text-text-dim">{peer.slot.toLocaleString()}</span>
                      </span>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default Peers;
