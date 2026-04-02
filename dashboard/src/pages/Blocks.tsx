import {
  createResource,
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
  type Component,
} from "solid-js";
import { Motion } from "@motionone/solid";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonTable } from "@/components/ui/skeleton";
import {
  BlockCard,
  BlockDetail,
  TxRow,
  TxDetailPanel,
  FilterBar,
  type BlockFilters,
  type TxRowData,
} from "@/components/Blocks";
import {
  fetchRecentBlocks,
  useSSE,
  type BlockInfo,
  type TxDetail,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Default filters
// ---------------------------------------------------------------------------

const DEFAULT_FILTERS: BlockFilters = {
  slotFrom: null,
  slotTo: null,
  hashPrefix: "",
  era: null,
  status: "all",
  sort: "newest",
};

// ---------------------------------------------------------------------------
// Blocks page component
// ---------------------------------------------------------------------------

const Blocks: Component = () => {
  const [blocks, { refetch }] = createResource(() => fetchRecentBlocks(50));
  const { data: liveBlock } = useSSE<BlockInfo | null>("/sse/blocks", null);

  const [expandedHash, setExpandedHash] = createSignal<string | null>(null);
  const [selectedTxHash, setSelectedTxHash] = createSignal<string | null>(null);
  const [selectedTxDetail, setSelectedTxDetail] = createSignal<TxDetail | null>(null);
  const [filters, setFilters] = createSignal<BlockFilters>(DEFAULT_FILTERS);
  const [newBlockHashes, setNewBlockHashes] = createSignal<Set<string>>(new Set());

  // Poll for new blocks
  setInterval(refetch, 5000);

  // Merge live block into list
  const allBlocks = createMemo<BlockInfo[]>(() => {
    const base = blocks() ?? [];
    const live = liveBlock();
    if (live && base.length > 0 && live.slot !== base[0]?.slot) {
      return [live, ...base].slice(0, 50);
    }
    return base;
  });

  // Animate new blocks arriving via SSE
  createEffect(() => {
    const live = liveBlock();
    if (live) {
      setNewBlockHashes((prev) => {
        const next = new Set(prev);
        next.add(live.hash);
        return next;
      });
      setTimeout(() => {
        setNewBlockHashes((prev) => {
          const next = new Set(prev);
          next.delete(live.hash);
          return next;
        });
      }, 500);
    }
  });

  // Apply filters
  const filteredBlocks = createMemo<BlockInfo[]>(() => {
    const f = filters();
    let result = allBlocks();

    if (f.slotFrom !== null) {
      result = result.filter((b) => b.slot >= f.slotFrom!);
    }
    if (f.slotTo !== null) {
      result = result.filter((b) => b.slot <= f.slotTo!);
    }
    if (f.hashPrefix) {
      const prefix = f.hashPrefix.toLowerCase();
      result = result.filter((b) => b.hash.toLowerCase().startsWith(prefix));
    }
    if (f.era !== null) {
      result = result.filter((b) => b.era === f.era);
    }
    if (f.status !== "all") {
      const threshold = 20 * 60 * 1000;
      const now = Date.now();
      result = result.filter((b) => {
        const age = now - new Date(b.insertedAt).getTime();
        return f.status === "finalized" ? age > threshold : age <= threshold;
      });
    }

    if (f.sort === "oldest") {
      result = [...result].reverse();
    }

    return result;
  });

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      class="flex flex-col h-full"
    >
      <Card class="glass-card-accent flex flex-col flex-1 min-h-0">
        <CardHeader>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <CardTitle>Recent Blocks</CardTitle>
              <Badge variant="muted">{filteredBlocks().length}</Badge>
            </div>
            <Show when={allBlocks().length > 0}>
              <span class="text-[11px] font-mono text-text-dim">
                Latest: slot {allBlocks()[0]?.slot.toLocaleString()}
              </span>
            </Show>
          </div>
        </CardHeader>

        {/* Filter bar */}
        <FilterBar filters={filters()} onChange={setFilters} />

        {/* Block list */}
        <div class="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Loading skeleton while blocks fetch */}
          <Show when={blocks.loading && filteredBlocks().length === 0}>
            <div class="flex flex-col gap-2">
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
            </div>
          </Show>
          <For each={filteredBlocks()}>
            {(block) => (
              <div
                class={
                  newBlockHashes().has(block.hash) ? "animate-fade-up" : ""
                }
              >
                <BlockCard
                  block={block}
                  isExpanded={expandedHash() === block.hash}
                  onToggle={() =>
                    setExpandedHash((prev) =>
                      prev === block.hash ? null : block.hash
                    )
                  }
                  onSelectTx={() => {}}
                >
                  {/* Block detail metadata */}
                  <BlockDetail block={block} />

                  {/* Transaction count */}
                  <Show when={block.txCount > 0}>
                    <div class="mx-3 mb-3 glass-card overflow-hidden">
                      <div class="flex items-center justify-between px-3 py-2 border-b border-border-subtle/30">
                        <span class="text-[11px] uppercase tracking-[0.08em] text-text-muted font-semibold">
                          Transactions
                        </span>
                        <Badge variant="success" class="text-[9px] px-1.5 py-0">
                          {block.txCount}
                        </Badge>
                      </div>
                      <div class="px-3 py-4 text-center text-[12px] text-text-muted">
                        {block.txCount} transaction{block.txCount > 1 ? "s" : ""} in this block
                      </div>
                    </div>
                  </Show>

                  {/* Empty tx state */}
                  <Show when={block.txCount === 0}>
                    <div class="flex items-center justify-center py-4 mx-3 mb-3">
                      <span class="text-[12px] text-text-muted">
                        No transactions in this block
                      </span>
                    </div>
                  </Show>
                </BlockCard>
              </div>
            )}
          </For>

          {/* Empty state */}
          <Show when={!blocks.loading && filteredBlocks().length === 0}>
            <div class="flex flex-col items-center gap-3 px-4 py-20">
              <div class="h-10 w-10 rounded-[var(--radius-sm)] border border-border bg-bg-sunken flex items-center justify-center">
                <svg
                  class="h-5 w-5 text-text-muted/50"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
              </div>
              <span class="text-[13px] text-text-secondary">
                {allBlocks().length === 0
                  ? "No blocks synced yet"
                  : "No blocks match your filters"}
              </span>
              <span class="text-[11px] text-text-muted">
                {allBlocks().length === 0
                  ? "Start the Gerolamo node to begin receiving blocks from the network."
                  : "Try adjusting your filter criteria."}
              </span>
            </div>
          </Show>
        </div>
      </Card>

      {/* Transaction detail side panel */}
      <Show when={selectedTxDetail()}>
        <div
          class="fixed inset-0 z-40 bg-black/40"
          aria-hidden="true"
          onClick={() => {
            setSelectedTxHash(null);
            setSelectedTxDetail(null);
          }}
        />
        <TxDetailPanel
          tx={selectedTxDetail()}
          onClose={() => {
            setSelectedTxHash(null);
            setSelectedTxDetail(null);
          }}
        />
      </Show>
    </Motion.div>
  );
};

export default Blocks;
