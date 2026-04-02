import { createSignal, createEffect, onMount, For, onCleanup, Show, type Component } from "solid-js";
import { Motion, Presence } from "@motionone/solid";
import { useSSE, fetchRecentBlocks, type BlockInfo } from "@/lib/api";
import { mockBlocks } from "@/mocks";

interface BlockNode {
  slot: number;
  hash: string;
  era: number;
  txCount: number;
  id: string;
  isNew: boolean;
  timestamp: number;
}

const ERA_COLORS: Record<number, string> = {
  0: "#5a6f8f", // Byron — muted
  1: "#00d4ff", // Shelley — accent
  2: "#9366ff", // Allegra — purple
  3: "#9366ff", // Mary — purple
  4: "#ff4488", // Alonzo — magenta
  5: "#00e68a", // Babbage — green
  6: "#00d4ff", // Conway — accent
};

const ERA_NAMES: Record<number, string> = {
  0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary",
  4: "Alonzo", 5: "Babbage", 6: "Conway",
};

const ChainViz: Component = () => {
  const [blocks, setBlocks] = createSignal<BlockNode[]>([]);
  const [particles, setParticles] = createSignal<{ id: number; x: number; color: string }[]>([]);
  const [pulse, setPulse] = createSignal(false);
  const [blockCount, setBlockCount] = createSignal(0);
  const { data: liveBlock } = useSSE<BlockInfo | null>("/sse/blocks", null);
  let particleId = 0;

  // Seed with data on mount if no live blocks arrive
  onMount(async () => {
    try {
      const recent = await fetchRecentBlocks(20);
      if (recent.length > 0) {
        setBlocks(recent.slice(0, 20).map((b) => ({
          slot: b.slot,
          hash: b.hash,
          era: b.era,
          txCount: b.txCount,
          id: `${b.slot}-${b.hash.slice(0, 8)}`,
          isNew: false,
          timestamp: new Date(b.insertedAt).getTime(),
        })));
        setBlockCount(recent.length);
        return;
      }
    } catch { /* fallthrough to mocks */ }
    // Fall back to mock blocks
    const demoBlocks = (mockBlocks as unknown as BlockInfo[]).slice(0, 20);
    if (demoBlocks.length > 0) {
      setBlocks(demoBlocks.map((b) => ({
        slot: b.slot,
        hash: b.hash,
        era: b.era,
        txCount: b.txCount,
        id: `${b.slot}-${b.hash.slice(0, 8)}`,
        isNew: false,
        timestamp: Date.now() - (demoBlocks[0].slot - b.slot) * 1000,
      })));
      setBlockCount(demoBlocks.length);
    }
  });

  createEffect(() => {
    const block = liveBlock();
    if (!block) return;

    setBlocks((prev) => {
      const exists = prev.some((b) => b.slot === block.slot);
      if (exists) return prev;
      const node: BlockNode = {
        slot: block.slot,
        hash: block.hash,
        era: block.era,
        txCount: block.txCount,
        id: `${block.slot}-${block.hash.slice(0, 8)}`,
        isNew: true,
        timestamp: Date.now(),
      };
      setBlockCount((c) => c + 1);
      const updated = prev.map((b) => ({ ...b, isNew: false }));
      return [node, ...updated].slice(0, 20);
    });

    setPulse(true);
    setTimeout(() => setPulse(false), 800);

    const eraColor = ERA_COLORS[block.era] ?? "#00d4ff";
    for (let i = 0; i < Math.min(block.txCount, 6); i++) {
      const pid = particleId++;
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          { id: pid, x: 10 + Math.random() * 80, color: eraColor },
        ]);
        setTimeout(() => {
          setParticles((prev) => prev.filter((p) => p.id !== pid));
        }, 1200);
      }, i * 150);
    }
  });

  return (
    <div class="flex h-full flex-col bg-bg-raised/50">
      {/* Header */}
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <div
            class="h-[6px] w-[6px] rounded-full"
            classList={{
              "bg-green pulse-live": blocks().length > 0,
              "bg-text-muted": blocks().length === 0,
            }}
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

      {/* Chain visualization */}
      <div class="relative flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        {/* Chain backbone */}
        <div
          class="absolute left-[22px] top-3 bottom-3 w-[2px] rounded-full transition-all duration-500"
          style={{
            background: pulse()
              ? "linear-gradient(180deg, rgba(0,212,255,0.5) 0%, rgba(0,212,255,0.08) 100%)"
              : "linear-gradient(180deg, rgba(0,212,255,0.12) 0%, rgba(0,212,255,0.02) 100%)",
            "box-shadow": pulse() ? "0 0 6px rgba(0,212,255,0.2)" : "none",
          }}
        />

        {/* Particles */}
        <Presence>
          <For each={particles()}>
            {(particle) => (
              <Motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: [0, 1, 1, 0], y: [0, 40] }}
                transition={{ duration: 1, easing: "ease-out" }}
                class="absolute h-1 w-1 rounded-full"
                style={{
                  left: `${particle.x}%`,
                  top: "24px",
                  background: particle.color,
                  "box-shadow": `0 0 4px ${particle.color}`,
                }}
              />
            )}
          </For>
        </Presence>

        {/* Block nodes */}
        <div class="relative flex flex-col gap-1">
          <Presence>
            <For each={blocks()}>
              {(block, i) => {
                const eraColor = ERA_COLORS[block.era] ?? "#5a6f8f";
                const timeSince = () => {
                  const sec = Math.floor((Date.now() - block.timestamp) / 1000);
                  if (sec < 60) return `${sec}s ago`;
                  return `${Math.floor(sec / 60)}m ago`;
                };

                return (
                  <Motion.div
                    initial={{ opacity: 0, x: 20, scale: 0.92 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: -20, scale: 0.92 }}
                    transition={{ duration: 0.35, delay: i() * 0.03 }}
                    class="group relative"
                  >
                    <div
                      class="relative flex items-start gap-2.5 rounded-[var(--radius-sm)] border px-2.5 py-2 transition-all duration-300"
                      classList={{
                        "border-accent/20 bg-accent/[0.03]": block.isNew,
                        "border-border-subtle hover:border-border": !block.isNew,
                      }}
                    >
                      {/* Chain node dot */}
                      <div class="relative mt-1 shrink-0">
                        <div
                          class="h-3 w-3 rounded-full border-2 transition-all duration-300"
                          style={{
                            "border-color": block.isNew ? eraColor : `${eraColor}40`,
                            background: block.isNew ? eraColor : `${eraColor}20`,
                            "box-shadow": block.isNew ? `0 0 6px ${eraColor}40` : "none",
                          }}
                        />
                      </div>

                      {/* Block info */}
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex items-center gap-2">
                          <span class="font-mono text-[12px] font-semibold tabular-nums text-text">
                            {block.slot.toLocaleString()}
                          </span>
                          <span
                            class="rounded-sm px-1 py-[1px] text-[9px] font-bold uppercase tracking-wider"
                            style={{
                              color: eraColor,
                              background: `${eraColor}10`,
                              border: `1px solid ${eraColor}20`,
                            }}
                          >
                            {ERA_NAMES[block.era] ?? "?"}
                          </span>
                        </div>
                        <div class="flex items-center gap-2 text-[10px]">
                          <span class="font-mono text-text-muted truncate">
                            {block.hash.slice(0, 16)}...
                          </span>
                        </div>
                        <div class="flex items-center gap-2 text-[10px] text-text-muted">
                          {block.txCount > 0 && (
                            <span class="font-mono">
                              <span style={{ color: eraColor }}>{block.txCount}</span> tx{block.txCount !== 1 ? "s" : ""}
                            </span>
                          )}
                          <span>{timeSince()}</span>
                        </div>
                      </div>
                    </div>
                  </Motion.div>
                );
              }}
            </For>
          </Presence>

          {blocks().length === 0 && (
            <div class="flex flex-col items-center gap-3 py-16">
              <div class="h-3 w-3 rounded-full bg-accent/10 animate-border-breathe border border-accent/15" />
              <span class="text-[11px] text-text-muted text-center leading-relaxed">
                Waiting for blocks<br />from the network...
              </span>
              <div class="flex gap-1.5">
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "0ms" }} />
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "300ms" }} />
                <div class="h-1 w-1 rounded-full bg-accent/20 pulse-live" style={{ "animation-delay": "600ms" }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer stats */}
      <div class="border-t border-border px-4 py-2.5">
        <div class="flex items-center justify-between text-[10px] text-text-muted">
          <span>
            Tip: <span class="font-mono text-text-dim">
              {blocks().length > 0 ? blocks()[0].slot.toLocaleString() : "\u2014"}
            </span>
          </span>
          <span class="font-mono">{blocks().length} visible</span>
        </div>
      </div>
    </div>
  );
};

export default ChainViz;
