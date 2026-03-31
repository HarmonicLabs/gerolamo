import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useSSE, fetchRecentBlocks, type BlockInfo } from "@/lib/api";
import { mockBlocks } from "@/mocks";
import type { DiagramBlock } from "./types";
import { VOLATILE_WINDOW, EASE_SMOOTH } from "./types";
import BlockNode from "./BlockNode";

/** Convert a raw BlockInfo to a DiagramBlock */
function toDiagramBlock(b: BlockInfo, tipSlot: number, isNew: boolean): DiagramBlock {
  const depth = tipSlot - b.slot;
  return {
    ...b,
    id: `${b.slot}-${b.hash.slice(0, 8)}`,
    health: depth >= VOLATILE_WINDOW ? "finalized" : "volatile",
    isNew,
    receivedAt: Date.now(),
    totalFees: 0, // populated when block detail is fetched
  };
}

/** Maximum blocks to keep in memory */
const MAX_BLOCKS = 500;

/** Estimated row height for the virtualizer (px) */
const ESTIMATED_ROW_HEIGHT = 76;

const ChainDiagram: Component = () => {
  // ---- State ----
  const [blocks, setBlocks] = createSignal<DiagramBlock[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [blockCount, setBlockCount] = createSignal(0);
  const [pulse, setPulse] = createSignal(false);
  const [newBlockAnnouncement, setNewBlockAnnouncement] = createSignal("");
  let scrollRef: HTMLDivElement | undefined;

  // ---- SSE live blocks ----
  const { data: liveBlock, connected } = useSSE<BlockInfo | null>("/sse/blocks", null);

  // ---- Throttle SSE updates to ~60fps ----
  let pendingBlock: BlockInfo | null = null;
  let rafId: number | null = null;

  function flushPending() {
    rafId = null;
    const block = pendingBlock;
    if (!block) return;
    pendingBlock = null;

    setBlocks((prev) => {
      if (prev.some((b) => b.slot === block.slot && b.hash === block.hash)) return prev;

      const tipSlot = prev.length > 0 ? Math.max(prev[0].slot, block.slot) : block.slot;
      const node = toDiagramBlock(block, tipSlot, true);

      setBlockCount((c) => c + 1);

      // Mark previous blocks as not new
      const updated = prev.map((b) => (b.isNew ? { ...b, isNew: false } : b));

      // Insert at correct position (descending by slot)
      const insertIdx = updated.findIndex((b) => b.slot < block.slot);
      if (insertIdx === -1) {
        return [...updated, node].slice(0, MAX_BLOCKS);
      }
      const result = [...updated.slice(0, insertIdx), node, ...updated.slice(insertIdx)];
      return result.slice(0, MAX_BLOCKS);
    });

    // Announce new block to screen readers
    setNewBlockAnnouncement(`New block at slot ${block.slot.toLocaleString()}`);
    setTimeout(() => setNewBlockAnnouncement(""), 2000);

    setPulse(true);
    setTimeout(() => setPulse(false), 800);
  }

  createEffect(() => {
    const block = liveBlock();
    if (!block) return;
    pendingBlock = block;
    if (rafId === null) {
      rafId = requestAnimationFrame(flushPending);
    }
  });

  onCleanup(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  // ---- Initial load from REST, fallback to mock data ----
  onMount(async () => {
    try {
      const recent = await fetchRecentBlocks(50);
      if (recent.length > 0) {
        const tipSlot = recent[0].slot;
        setBlocks(recent.map((b) => toDiagramBlock(b, tipSlot, false)));
        setBlockCount(recent.length);
        return;
      }
    } catch {
      // API may not be available
    }
    // Fall back to mock blocks for demo mode
    const demoBlocks = mockBlocks as unknown as BlockInfo[];
    if (demoBlocks.length > 0) {
      const tipSlot = demoBlocks[0].slot;
      setBlocks(demoBlocks.map((b) => toDiagramBlock(b, tipSlot, false)));
      setBlockCount(demoBlocks.length);
    }
  });

  // ---- Virtualizer ----
  const virtualizer = createVirtualizer({
    get count() {
      return blocks().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  });

  const virtualItems = () => virtualizer.getVirtualItems();
  const totalSize = () => virtualizer.getTotalSize();

  // ---- Selection + keyboard nav ----
  const selectedIndex = createMemo(() => {
    const id = selectedId();
    if (id === null) return -1;
    return blocks().findIndex((b) => b.id === id);
  });

  function handleSelect(block: DiagramBlock) {
    const currentId = selectedId();
    if (currentId === block.id) {
      setSelectedId(null); // deselect
      return;
    }
    setSelectedId(block.id);
    // Smooth scroll to center the selected block
    const idx = blocks().findIndex((b) => b.id === block.id);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const bl = blocks();
    if (bl.length === 0) return;

    const current = selectedIndex();

    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      const next = Math.min(current + 1, bl.length - 1);
      setSelectedId(bl[next].id);
      virtualizer.scrollToIndex(next, { align: "center", behavior: "smooth" });
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      const prev = Math.max(current <= 0 ? 0 : current - 1, 0);
      setSelectedId(bl[prev].id);
      virtualizer.scrollToIndex(prev, { align: "center", behavior: "smooth" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current >= 0) {
        // Toggle select (trigger expand in BlockNode)
        handleSelect(bl[current]);
      }
    } else if (e.key === "Escape") {
      setSelectedId(null);
    }
  }

  return (
    <>
      {/* ---- Desktop vertical diagram ---- */}
      <div
        class="chain-diagram-vertical flex h-full flex-col bg-bg-raised/50"
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="listbox"
        aria-label="Live chain diagram"
        aria-activedescendant={selectedId() ? `block-${selectedId()}` : undefined}
      >
        {/* Screen reader announcements for new blocks */}
        <div
          aria-live="polite"
          aria-atomic="true"
          class="absolute w-px h-px overflow-hidden"
          style={{ clip: "rect(0,0,0,0)", "clip-path": "inset(50%)" }}
        >
          {newBlockAnnouncement()}
        </div>

        {/* ---- Header ---- */}
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <div class="flex items-center gap-2">
            <div
              class="h-[6px] w-[6px] rounded-full"
              classList={{
                "bg-green pulse-live": connected(),
                "bg-text-muted": !connected(),
              }}
              role="status"
              aria-label={connected() ? "Connected to live feed" : "Disconnected from live feed"}
            />
            <span class="text-[12px] font-semibold text-text">
              Live Chain
            </span>
          </div>
          <Show when={blocks().length > 0}>
            <span class="text-[10px] font-mono text-text-muted">
              {blockCount()} synced
            </span>
          </Show>
        </div>

        {/* ---- Virtualized scroll area ---- */}
        <div
          ref={(el) => (scrollRef = el)}
          class="relative flex-1 overflow-y-auto overflow-x-hidden"
          style={{ "scroll-behavior": "smooth" }}
        >
          {/* Neon left-side rail */}
          <div
            class="absolute left-[22px] top-0 bottom-0 w-[2px] rounded-full transition-all duration-500 z-0"
            style={{
              background: pulse()
                ? "linear-gradient(180deg, rgba(0,212,255,0.5) 0%, rgba(0,212,255,0.08) 100%)"
                : "linear-gradient(180deg, rgba(0,212,255,0.12) 0%, rgba(0,212,255,0.02) 100%)",
              "box-shadow": pulse() ? "0 0 6px rgba(0,212,255,0.2)" : "none",
            }}
            aria-hidden="true"
          />

          {/* Virtual list container */}
          <div
            class="relative w-full"
            style={{ height: `${totalSize()}px` }}
          >
            <For each={virtualItems()}>
              {(vItem) => {
                const block = () => blocks()[vItem.index];
                return (
                  <Show when={block()}>
                    <div
                      id={`block-${block()!.id}`}
                      class="absolute left-0 top-0 w-full px-3"
                      classList={{
                        "animate-block-pop": block()!.isNew,
                      }}
                      style={{
                        height: `${vItem.size}px`,
                        transform: `translateY(${vItem.start}px)`,
                      }}
                      role="option"
                      aria-selected={selectedId() === block()!.id}
                      aria-label={`Block at slot ${block()!.slot.toLocaleString()}, ${block()!.txCount} transactions, ${block()!.health}`}
                    >
                      <BlockNode
                        block={block()!}
                        selected={selectedId() === block()!.id}
                        onSelect={handleSelect}
                      />
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>

          {/* Empty state */}
          <Show when={blocks().length === 0}>
            <div class="flex flex-col items-center gap-3 py-16">
              <div class="h-3 w-3 rounded-full bg-accent/10 animate-border-breathe border border-accent/15" />
              <span class="text-[11px] text-text-muted text-center leading-relaxed">
                Waiting for blocks<br />from the network...
              </span>
              <div class="flex gap-1.5" aria-hidden="true">
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "0ms" }} />
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "300ms" }} />
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "600ms" }} />
              </div>
            </div>
          </Show>
        </div>

        {/* ---- Footer stats ---- */}
        <div class="border-t border-border px-4 py-2.5">
          <div class="flex items-center justify-between text-[10px] text-text-muted">
            <span>
              Tip:{" "}
              <span class="font-mono text-text-dim">
                {blocks().length > 0 ? blocks()[0].slot.toLocaleString() : "\u2014"}
              </span>
            </span>
            <span class="font-mono">{blocks().length} loaded</span>
          </div>
        </div>
      </div>

      {/* ---- Mobile horizontal strip ---- */}
      <div
        class="chain-diagram-mobile flex h-[80px] items-center gap-2 overflow-x-auto overflow-y-hidden bg-bg-raised/50 px-3"
        role="listbox"
        aria-label="Live chain diagram (compact)"
      >
        {/* Screen reader announcements (mobile) */}
        <div
          aria-live="polite"
          aria-atomic="true"
          class="absolute w-px h-px overflow-hidden"
          style={{ clip: "rect(0,0,0,0)", "clip-path": "inset(50%)" }}
        >
          {newBlockAnnouncement()}
        </div>

        <Show
          when={blocks().length > 0}
          fallback={
            <div class="flex items-center gap-2 px-2 text-[11px] text-text-muted">
              <div class="h-1.5 w-1.5 rounded-full bg-accent/20 pulse-live" />
              Waiting for blocks...
            </div>
          }
        >
          {/* Connection indicator */}
          <div class="flex shrink-0 flex-col items-center gap-1 pr-2 border-r border-border">
            <div
              class="h-[6px] w-[6px] rounded-full"
              classList={{
                "bg-green pulse-live": connected(),
                "bg-text-muted": !connected(),
              }}
            />
            <span class="text-[9px] text-text-muted">{blockCount()}</span>
          </div>

          {/* Horizontal block pills */}
          <For each={blocks().slice(0, 20)}>
            {(block) => (
              <button
                class="flex shrink-0 flex-col items-center gap-0.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 transition-all duration-150"
                classList={{
                  "border-accent/30 bg-accent/[0.06]": selectedId() === block.id,
                  "border-border-subtle hover:border-border bg-transparent": selectedId() !== block.id,
                  "animate-slide-in": block.isNew,
                }}
                role="option"
                aria-selected={selectedId() === block.id}
                aria-label={`Slot ${block.slot.toLocaleString()}`}
                onClick={() => handleSelect(block)}
              >
                <span class="font-mono text-[10px] font-semibold tabular-nums text-text">
                  {block.slot.toLocaleString()}
                </span>
                <span class="text-[8px] text-text-muted">
                  {block.txCount} tx
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </>
  );
};

export default ChainDiagram;
