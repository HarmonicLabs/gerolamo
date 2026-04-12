import { createSignal, Show, For } from "solid-js";
import { useNodeBlocks } from "@/lib/background-bridge";
import { formatNumber, formatBytes, truncateHash } from "@/lib/format";
import { CopyHash } from "@/components/CopyHash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw } from "lucide-solid";

export default function BlocksPage() {
  const blocks = useNodeBlocks();
  const [search, setSearch] = createSignal("");
  const [expanded, setExpanded] = createSignal<number | null>(null);

  const filtered = () => {
    const s = search();
    if (!s) return blocks();
    return blocks().filter((b) => String(b.slot).includes(s) || String(b.height).includes(s) || b.hash.includes(s.toLowerCase()));
  };

  return (
    <div class="space-y-3">
      <div class="flex gap-2">
        <Input
          placeholder="Search by slot, height, or hash..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="text-xs h-8"
        />
        <Button variant="outline" size="icon" class="h-8 w-8 shrink-0" onClick={() => setSearch("")}>
          <RefreshCw size={12} />
        </Button>
      </div>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="text-center text-sm text-muted-foreground py-8">
            {blocks().length === 0 ? "No blocks yet. Connect to Koios first." : "No matching blocks."}
          </div>
        }
      >
        <div class="space-y-1">
          <For each={filtered().slice(0, 20)}>
            {(block, i) => (
              <div>
                <button
                  onClick={() => setExpanded(expanded() === i() ? null : i())}
                  class="w-full glass-panel rounded-md p-2 border border-border hover:neon-border-cyan transition-all text-left"
                >
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <span class="text-xs neon-text-cyan font-medium">{formatNumber(block.slot)}</span>
                      <span class="text-[9px] text-muted-foreground">h:{formatNumber(block.height)}</span>
                    </div>
                    <div class="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>{block.txCount} txs</span>
                      <span>{formatBytes(block.size)}</span>
                    </div>
                  </div>
                </button>
                <Show when={expanded() === i()}>
                  <div class="glass-panel rounded-b-md p-2 border border-t-0 border-border space-y-1 text-[10px]">
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Hash</span>
                      <CopyHash hash={block.hash} chars={12} />
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Epoch</span>
                      <span>{block.epoch} / slot {block.epochSlot}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Slot Leader</span>
                      <span class="font-mono text-[9px]">{truncateHash(block.slotLeader, 10)}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Fees</span>
                      <span>{(parseInt(block.fees) / 1_000_000).toFixed(6)} ADA</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Time</span>
                      <span>{new Date(block.time * 1000).toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Size</span>
                      <span>{formatBytes(block.size)}</span>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <p class="text-[9px] text-muted-foreground text-center">
        Showing {Math.min(filtered().length, 20)} of {blocks().length} blocks
      </p>
    </div>
  );
}
