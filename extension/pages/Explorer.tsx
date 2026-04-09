import { createSignal, Show, For, type Component } from "solid-js";
import { fetchUtxos, type UtxoEntry } from "@/lib/api";
import { getApiBase, initSettings } from "@/lib/settings";

const Explorer: Component = () => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<UtxoEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [searched, setSearched] = createSignal(false);

  async function handleSearch(e?: Event) {
    e?.preventDefault();
    const q = query().trim();
    if (!q) return;

    setLoading(true);
    setError("");
    setSearched(true);
    try {
      await initSettings();
      const apiBase = getApiBase();
      const data = await fetchUtxos(apiBase, q);
      setResults(data);
    } catch (err: any) {
      setError(err.message || "Failed to query UTxOs");
      setResults([]);
    }
    setLoading(false);
  }

  function truncateHash(hash: string): string {
    if (hash.length <= 20) return hash;
    return `${hash.slice(0, 10)}...${hash.slice(-10)}`;
  }

  function truncateAddress(addr: string): string {
    if (addr.length <= 24) return addr;
    return `${addr.slice(0, 12)}...${addr.slice(-12)}`;
  }

  function formatLovelace(amount: string): string {
    const n = Number(BigInt(amount || "0"));
    return (n / 1_000_000).toFixed(6);
  }

  return (
    <div class="flex flex-col gap-3 p-3">
      <div>
        <h1 class="text-[16px] font-bold text-text mb-0.5">Explorer</h1>
        <p class="text-[11px] text-text-muted leading-relaxed">
          Look up UTxOs by transaction hash or UTxO reference.
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} class="glass-card rounded-lg border border-border p-3">
        <label class="text-[10px] text-text-muted uppercase tracking-wider block mb-1.5">
          Tx Hash / UTxO Ref
        </label>
        <div class="flex gap-2">
          <input
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="e.g. abcd1234...ef56 or abcd1234...ef56:0"
            class="flex-1 px-2.5 py-1.5 rounded-md bg-bg-raised/50 border border-border-subtle text-[11px] font-mono text-text placeholder:text-text-dim focus:outline-none focus:border-accent/40 transition-colors"
          />
          <button
            type="submit"
            disabled={loading() || !query().trim()}
            class="px-3 py-1.5 rounded-md bg-accent/10 border border-accent/30 text-accent text-[11px] font-medium hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading() ? "..." : "Search"}
          </button>
        </div>
      </form>

      <Show when={error()}>
        <div class="p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-[10px]">
          {error()}
        </div>
      </Show>

      <Show when={searched() && !loading()}>
        <Show
          when={results().length > 0}
          fallback={
            <div class="glass-card rounded-lg border border-border p-4 text-center">
              <div class="text-[11px] text-text-muted">
                No UTxOs found for this query.
              </div>
            </div>
          }
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10px] text-text-muted">
              Found {results().length} UTxO{results().length !== 1 ? "s" : ""}
            </span>
          </div>

          <div class="space-y-1.5 max-h-[340px] overflow-y-auto">
            <For each={results()}>
              {(utxo) => (
                <div class="glass-card rounded-lg border border-border p-2.5">
                  <div class="flex items-center justify-between mb-1">
                    <span class="font-mono text-[10px] text-accent" title={utxo.ref}>
                      {truncateHash(utxo.ref)}
                    </span>
                    <span class="font-mono text-[10px] text-green-400 tabular-nums font-semibold">
                      {formatLovelace(utxo.amount)} ADA
                    </span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <div class="flex items-center gap-1 text-[9px]">
                      <span class="text-text-muted">Addr:</span>
                      <span class="font-mono text-text-dim" title={utxo.address}>
                        {truncateAddress(utxo.address)}
                      </span>
                    </div>
                    <div class="flex items-center gap-1 text-[9px]">
                      <span class="text-text-muted">Tx:</span>
                      <span class="font-mono text-text-dim" title={utxo.txHash}>
                        {truncateHash(utxo.txHash)}
                      </span>
                      <span class="text-text-muted">#{utxo.outputIndex}</span>
                    </div>
                    <Show when={Object.keys(utxo.assets).length > 0}>
                      <div class="mt-1 text-[9px] text-text-muted">
                        Assets: {Object.keys(utxo.assets).length} policy(ies)
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default Explorer;
