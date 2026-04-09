import { createSignal, Show, For, onMount, type Component } from "solid-js";
import { fetchRecentBlocks, type BlockInfo } from "@/lib/api";
import { getApiBase, initSettings } from "@/lib/settings";

const Blocks: Component = () => {
  const [blocks, setBlocks] = createSignal<BlockInfo[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const apiBase = getApiBase();
      const data = await fetchRecentBlocks(apiBase, 20);
      setBlocks(data);
    } catch (e: any) {
      setError(e.message || "Failed to fetch blocks");
    }
    setLoading(false);
  }

  onMount(async () => {
    await initSettings();
    await refresh();
  });

  function truncateHash(hash: string): string {
    if (hash.length <= 16) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return (
    <div class="flex flex-col gap-3 p-3">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-[16px] font-bold text-text mb-0.5">Blocks</h1>
          <p class="text-[11px] text-text-muted leading-relaxed">
            Recent blocks from the Gerolamo node.
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

      <Show
        when={blocks().length > 0}
        fallback={
          <div class="glass-card rounded-lg border border-border p-4 text-center">
            <div class="text-[11px] text-text-muted">
              {loading() ? "Loading blocks..." : "No blocks found. Is the node running?"}
            </div>
          </div>
        }
      >
        {/* Table header */}
        <div class="glass-card rounded-lg border border-border overflow-hidden">
          <div class="grid grid-cols-[1fr_1.5fr_0.5fr_0.7fr] gap-1 px-3 py-2 border-b border-border bg-bg-raised/50 text-[9px] text-text-muted uppercase tracking-wider font-medium">
            <span>Slot</span>
            <span>Hash</span>
            <span class="text-center">Txs</span>
            <span class="text-right">Size</span>
          </div>

          {/* Block rows */}
          <div class="max-h-[400px] overflow-y-auto">
            <For each={blocks()}>
              {(block) => (
                <div class="grid grid-cols-[1fr_1.5fr_0.5fr_0.7fr] gap-1 px-3 py-1.5 border-b border-border-subtle hover:bg-bg-raised/30 transition-colors">
                  <span class="font-mono text-[10px] text-accent tabular-nums">
                    {block.slot.toLocaleString()}
                  </span>
                  <span class="font-mono text-[10px] text-text truncate" title={block.hash}>
                    {truncateHash(block.hash)}
                  </span>
                  <span class="font-mono text-[10px] text-text text-center tabular-nums">
                    {block.txCount}
                  </span>
                  <span class="font-mono text-[10px] text-text-muted text-right tabular-nums">
                    {formatSize(block.size)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="text-[9px] text-text-dim text-center">
          Showing {blocks().length} most recent blocks
        </div>
      </Show>
    </div>
  );
};

export default Blocks;
