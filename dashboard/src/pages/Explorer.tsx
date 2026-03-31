import { createSignal, createResource, createMemo, For, Show, type Component } from "solid-js";
import { TransitionGroup } from "solid-transition-group";
import { Motion } from "@motionone/solid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchUtxos, fetchRecentDeltas, type UtxoEntry, type DeltaEntry } from "@/lib/api";

const ACTION_VARIANT = {
  spend: "danger" as const,
  create: "success" as const,
  cert: "neon" as const,
  fee: "warning" as const,
  withdrawal: "purple" as const,
};

const Explorer: Component = () => {
  const [query, setQuery] = createSignal("");
  const [searchTerm, setSearchTerm] = createSignal("");
  const [utxos] = createResource(searchTerm, (q) => (q ? fetchUtxos(q) : Promise.resolve([])));
  const [deltas, { refetch }] = createResource(() => fetchRecentDeltas(50));
  const [selected, setSelected] = createSignal<UtxoEntry | null>(null);
  setInterval(refetch, 5000);

  const displayUtxos = createMemo(() => utxos() ?? []);
  const effectiveDeltas = createMemo(() => deltas() ?? []);

  function search() { setSearchTerm(query().trim()); }

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      class="flex h-full flex-col gap-5"
    >
      {/* Search bar */}
      <div class="flex gap-3" role="search" aria-label="UTxO search">
        <div class="relative flex-1">
          <svg class="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search by tx hash, utxo ref (hash:idx), or address prefix..."
            aria-label="Search by transaction hash, UTxO reference, or address prefix"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            class="w-full rounded-[var(--radius)] border border-border bg-bg-input pl-11 pr-4 py-3 font-mono text-[13px] text-text outline-none placeholder:text-text-muted/50 focus:border-accent/30 focus:ring-1 focus:ring-accent/15 transition-all"
          />
        </div>
        <button
          onClick={search}
          aria-label="Search UTxOs"
          class="rounded-[var(--radius)] border border-accent/20 bg-accent-dim px-6 py-3 text-[13px] font-semibold text-accent transition-all hover:bg-accent-mid hover:border-accent/30"
        >
          Search
        </button>
      </div>

      <div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Results */}
        <div class="lg:col-span-2">
          <Card class="glass-card-accent">
            <CardHeader>
              <div class="flex items-center gap-3">
                <CardTitle>UTxO Results</CardTitle>
                <Badge variant="muted">{displayUtxos().length}</Badge>
              </div>
            </CardHeader>
            <div class="flex-1 overflow-y-auto">
              <table class="wallet-table w-full table-fixed" aria-label="UTxO search results">
                <thead class="sticky top-0 z-10">
                  <tr>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[60%]">Tx Hash</th>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[10%]">Idx</th>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-right text-sm font-semibold uppercase tracking-wider text-text-muted w-[30%]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <TransitionGroup name="row">
                    <For each={displayUtxos()}>
                      {(utxo) => (
                        <tr
                          class="cursor-pointer border-b border-border-subtle/50 transition-colors"
                          classList={{
                            "bg-accent/[0.04]": selected()?.ref === utxo.ref,
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`Select UTxO ${utxo.txHash.slice(0, 12)}:${utxo.outputIndex}`}
                          onClick={() => setSelected(utxo)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelected(utxo);
                            }
                          }}
                        >
                          <td class="px-6 py-4 font-mono text-sm text-text-dim truncate">{utxo.txHash.slice(0, 20)}...</td>
                          <td class="px-6 py-4 font-mono tabular-nums text-sm text-text">{utxo.outputIndex}</td>
                          <td class="px-6 py-4 text-right font-mono tabular-nums text-sm text-accent">
                            {(parseInt(utxo.amount) / 1_000_000).toLocaleString()} ADA
                          </td>
                        </tr>
                      )}
                    </For>
                  </TransitionGroup>
                </tbody>
              </table>
              <Show when={!utxos.loading && searchTerm() && (utxos()?.length ?? 0) === 0}>
                <div class="px-4 py-16 text-center text-[13px] text-text-secondary">No UTxOs found</div>
              </Show>
              <Show when={!searchTerm()}>
                <div class="flex flex-col items-center gap-3 px-4 py-16">
                  <span class="text-[13px] text-text-secondary">Search for a tx hash, utxo ref, or address prefix</span>
                </div>
              </Show>
            </div>
          </Card>
        </div>

        {/* Inspector */}
        <Card class="glass-card-accent self-start">
          <CardHeader>
            <div class="flex items-center gap-3">
              <CardTitle>Inspector</CardTitle>
              <Show when={selected()}>
                <Badge variant="neon">selected</Badge>
              </Show>
            </div>
          </CardHeader>
          <CardContent>
            <Show
              when={selected()}
              fallback={
                <div class="flex flex-col items-center gap-3 py-10">
                  <div class="h-10 w-10 rounded-[var(--radius-sm)] border border-border bg-bg-sunken flex items-center justify-center">
                    <svg class="h-5 w-5 text-text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </div>
                  <span class="text-[12px] text-text-secondary">Select a UTxO to inspect</span>
                </div>
              }
            >
              {(utxo) => (
                <Motion.div
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25 }}
                  class="flex flex-col gap-4 text-[13px]"
                >
                  <div>
                    <div class="mb-1.5 text-[11px] uppercase tracking-wider text-text-muted font-medium">Reference</div>
                    <div class="break-all rounded-[var(--radius-sm)] border border-border bg-bg-sunken p-3 font-mono text-[11px] text-text-dim">{utxo().ref}</div>
                  </div>
                  <div>
                    <div class="mb-1.5 text-[11px] uppercase tracking-wider text-text-muted font-medium">Address</div>
                    <div class="break-all rounded-[var(--radius-sm)] border border-border bg-bg-sunken p-3 font-mono text-[11px] text-text-dim">{utxo().address || "\u2014"}</div>
                  </div>
                  <div>
                    <div class="mb-1.5 text-[11px] uppercase tracking-wider text-text-muted font-medium">Lovelace</div>
                    <div class="font-mono text-[20px] font-bold tabular-nums text-accent text-glow">
                      {parseInt(utxo().amount).toLocaleString()}
                    </div>
                  </div>
                  <Show when={Object.keys(utxo().assets).length > 0}>
                    <div>
                      <div class="mb-1.5 text-[11px] uppercase tracking-wider text-text-muted font-medium">Native Assets</div>
                      <For each={Object.entries(utxo().assets)}>
                        {([policy, assets]) => (
                          <div class="mt-2 rounded-[var(--radius-sm)] border border-border bg-bg-sunken p-3">
                            <div class="mb-2 break-all font-mono text-[10px] text-text-muted">{policy}</div>
                            <For each={Object.entries(assets)}>
                              {([name, qty]) => (
                                <div class="flex justify-between text-[12px] py-0.5">
                                  <span class="font-mono text-purple">{name || "(empty)"}</span>
                                  <span class="font-mono tabular-nums text-text-dim">{qty}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Motion.div>
              )}
            </Show>
          </CardContent>
        </Card>
      </div>

      {/* Recent Deltas */}
      <Card class="glass-card-accent">
        <CardHeader>
          <div class="flex items-center gap-3">
            <CardTitle>Recent UTxO Deltas</CardTitle>
            <Badge variant="muted">{effectiveDeltas().length}</Badge>
          </div>
        </CardHeader>
        <div class="flex-1 overflow-y-auto">
          <table class="wallet-table w-full table-fixed" aria-label="Recent UTxO deltas">
            <thead class="sticky top-0 z-10">
              <tr>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[12%]">Action</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[28%]">Block Hash</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[40%]">Data</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted w-[20%]">Time</th>
              </tr>
            </thead>
            <tbody>
              <TransitionGroup name="row">
                <For each={effectiveDeltas()}>
                  {(d) => (
                    <tr class="border-b border-border-subtle/50">
                      <td class="px-6 py-4"><Badge variant={ACTION_VARIANT[d.action]}>{d.action}</Badge></td>
                      <td class="px-6 py-4 font-mono text-sm text-text-dim truncate">{d.blockHash.slice(0, 16)}...</td>
                      <td class="truncate px-6 py-4 font-mono text-sm text-text-muted">{d.utxo}</td>
                      <td class="px-6 py-4 text-sm text-text-dim">{new Date(d.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  )}
                </For>
              </TransitionGroup>
            </tbody>
          </table>
          <Show when={effectiveDeltas().length === 0}>
            <div class="flex flex-col items-center gap-3 px-4 py-16">
              <span class="text-[13px] text-text-secondary">No UTxO deltas yet</span>
              <span class="text-[11px] text-text-muted">Deltas will appear as the node processes blocks.</span>
            </div>
          </Show>
        </div>
      </Card>
    </Motion.div>
  );
};

export default Explorer;
