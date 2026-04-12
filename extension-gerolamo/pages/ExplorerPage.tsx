import { createSignal, Show, For } from "solid-js";
import { toast } from "solid-sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyHash } from "@/components/CopyHash";
import { useUtxoLookup, submitTransaction } from "@/lib/cardano-api";
import { formatLovelace } from "@/lib/format";
import { Search, Send, Loader2 } from "lucide-solid";

export default function ExplorerPage() {
  const [query, setQuery] = createSignal("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [txCbor, setTxCbor] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  const utxoQuery = useUtxoLookup(searchQuery);

  const handleSearch = () => {
    if (query().trim()) setSearchQuery(query().trim());
  };

  const handleSubmit = async () => {
    if (!txCbor().trim()) return;
    setSubmitting(true);
    try {
      const result = await submitTransaction(txCbor().trim());
      if (result.ok) {
        toast.success(result.message);
        setTxCbor("");
      } else {
        toast.error(result.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="space-y-3">
      <div>
        <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">UTxO Lookup</h3>
        <div class="flex gap-2">
          <Input
            placeholder="Address, tx hash, or utxo ref..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            class="text-xs h-8"
          />
          <Button size="icon" class="h-8 w-8 shrink-0" onClick={handleSearch}>
            <Search size={12} />
          </Button>
        </div>
      </div>

      <Show when={utxoQuery.isLoading}>
        <div class="flex items-center justify-center py-4">
          <Loader2 size={16} class="animate-spin text-muted-foreground" />
        </div>
      </Show>

      <Show when={utxoQuery.error}>
        <div class="glass-panel rounded-md p-2 border border-destructive text-xs text-destructive">
          {(utxoQuery.error as Error).message}
        </div>
      </Show>

      <Show when={utxoQuery.data && utxoQuery.data.length > 0}>
        <div class="space-y-1">
          <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground">
            Results ({utxoQuery.data!.length})
          </h3>
          <For each={utxoQuery.data}>
            {(u) => (
              <div class="glass-panel rounded-md p-2 border border-border text-[10px] space-y-1">
                <div class="flex justify-between">
                  <span class="text-muted-foreground">Ref</span>
                  <CopyHash hash={`${u.tx_hash}#${u.tx_index}`} chars={10} />
                </div>
                <div class="flex justify-between">
                  <span class="text-muted-foreground">ADA</span>
                  <span class="neon-text-cyan">{formatLovelace(Number(u.value))}</span>
                </div>
                <Show when={u.asset_list.length > 0}>
                  <div class="flex justify-between">
                    <span class="text-muted-foreground">Assets</span>
                    <span>{u.asset_list.length} tokens</span>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={utxoQuery.data && utxoQuery.data.length === 0 && searchQuery()}>
        <div class="text-center text-xs text-muted-foreground py-4">No UTxOs found</div>
      </Show>

      <div>
        <h3 class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Submit Transaction</h3>
        <Textarea
          placeholder="Paste CBOR hex..."
          value={txCbor()}
          onInput={(e) => setTxCbor(e.currentTarget.value)}
          class="text-[10px] h-20 resize-none"
        />
        <Button size="sm" class="mt-1.5 w-full" onClick={handleSubmit} disabled={submitting() || !txCbor().trim()}>
          <Show when={submitting()} fallback={<><Send size={12} /> Submit</>}>
            <Loader2 size={12} class="animate-spin" />
          </Show>
        </Button>
      </div>
    </div>
  );
}
