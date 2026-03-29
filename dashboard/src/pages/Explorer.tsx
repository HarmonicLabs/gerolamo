import { createSignal, createResource, For, Show, type Component } from "solid-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchUtxos, fetchRecentDeltas, type UtxoEntry, type DeltaEntry } from "@/lib/api";

const ACTION_VARIANT = {
  spend: "danger" as const,
  create: "success" as const,
  cert: "info" as const,
  fee: "warning" as const,
  withdrawal: "default" as const,
};

const Explorer: Component = () => {
  const [query, setQuery] = createSignal("");
  const [searchTerm, setSearchTerm] = createSignal("");
  const [utxos] = createResource(searchTerm, (q) => (q ? fetchUtxos(q) : Promise.resolve([])));
  const [deltas, { refetch: refetchDeltas }] = createResource(() => fetchRecentDeltas(50));
  const [selected, setSelected] = createSignal<UtxoEntry | null>(null);

  setInterval(refetchDeltas, 5000);

  function search() {
    setSearchTerm(query().trim());
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Search */}
      <Card>
        <CardContent class="flex gap-2 pt-4">
          <input
            type="text"
            placeholder="Search by tx hash, utxo ref (hash:idx), or address prefix..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            class="flex-1 rounded-[var(--radius-sm)] border border-border bg-bg-sunken px-3 py-2 font-mono text-xs text-text outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
          <button
            onClick={search}
            class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-80"
          >
            Search
          </button>
        </CardContent>
      </Card>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Results */}
        <div class="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>
                UTxO Results
                <Show when={utxos()}>
                  <Badge variant="muted" class="ml-2">{utxos()!.length}</Badge>
                </Show>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div class="max-h-[500px] overflow-y-auto">
                <table class="w-full text-left">
                  <thead class="sticky top-0 bg-bg-raised">
                    <tr class="border-b border-border">
                      <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Tx Hash</th>
                      <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Idx</th>
                      <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={utxos() ?? []}>
                      {(utxo) => (
                        <tr
                          class="cursor-pointer border-b border-border/50 transition-colors hover:bg-accent-dim"
                          classList={{ "bg-accent-dim": selected()?.ref === utxo.ref }}
                          onClick={() => setSelected(utxo)}
                        >
                          <td class="px-3 py-2 font-mono text-xs text-text-dim">{utxo.txHash.slice(0, 16)}...</td>
                          <td class="px-3 py-2 font-mono tabular-nums">{utxo.outputIndex}</td>
                          <td class="px-3 py-2 font-mono text-xs tabular-nums text-accent">
                            {(parseInt(utxo.amount) / 1_000_000).toLocaleString()} ADA
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <Show when={!utxos.loading && searchTerm() && (utxos()?.length ?? 0) === 0}>
                  <div class="py-8 text-center text-text-dim">No UTxOs found</div>
                </Show>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Inspector */}
        <div>
          <Card class="sticky top-4">
            <CardHeader>
              <CardTitle>Inspector</CardTitle>
            </CardHeader>
            <CardContent>
              <Show
                when={selected()}
                fallback={<p class="py-8 text-center text-xs text-text-dim">Select a UTxO to inspect</p>}
              >
                {(utxo) => (
                  <div class="flex flex-col gap-3 text-xs">
                    <div>
                      <span class="text-text-muted">Ref</span>
                      <p class="mt-0.5 break-all font-mono text-accent">{utxo().ref}</p>
                    </div>
                    <div>
                      <span class="text-text-muted">Address</span>
                      <p class="mt-0.5 break-all font-mono">{utxo().address || "—"}</p>
                    </div>
                    <div>
                      <span class="text-text-muted">Lovelace</span>
                      <p class="mt-0.5 font-mono text-accent">{parseInt(utxo().amount).toLocaleString()}</p>
                    </div>
                    <Show when={Object.keys(utxo().assets).length > 0}>
                      <div>
                        <span class="text-text-muted">Assets</span>
                        <For each={Object.entries(utxo().assets)}>
                          {([policy, assets]) => (
                            <div class="mt-1 rounded bg-bg-sunken p-2">
                              <p class="mb-1 break-all font-mono text-[10px] text-text-dim">{policy}</p>
                              <For each={Object.entries(assets)}>
                                {([name, qty]) => (
                                  <div class="flex justify-between">
                                    <span class="font-mono text-purple">{name || "(empty)"}</span>
                                    <span class="font-mono tabular-nums">{qty}</span>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Deltas */}
      <Card>
        <CardHeader>
          <CardTitle>Recent UTxO Deltas</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="max-h-[300px] overflow-y-auto">
            <table class="w-full text-left">
              <thead class="sticky top-0 bg-bg-raised">
                <tr class="border-b border-border">
                  <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Action</th>
                  <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Block</th>
                  <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Data</th>
                  <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Time</th>
                </tr>
              </thead>
              <tbody>
                <For each={deltas() ?? []}>
                  {(d) => (
                    <tr class="border-b border-border/50">
                      <td class="px-3 py-2"><Badge variant={ACTION_VARIANT[d.action]}>{d.action}</Badge></td>
                      <td class="px-3 py-2 font-mono text-xs text-text-dim">{d.blockHash.slice(0, 12)}...</td>
                      <td class="max-w-[300px] truncate px-3 py-2 font-mono text-[10px] text-text-dim">{d.utxo}</td>
                      <td class="px-3 py-2 text-xs text-text-dim">{new Date(d.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Explorer;
