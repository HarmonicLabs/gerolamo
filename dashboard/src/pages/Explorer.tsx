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

// ---------------------------------------------------------------------------
// Mock UTxO entries for demo mode
// ---------------------------------------------------------------------------

const MOCK_UTXOS: UtxoEntry[] = [
  {
    ref: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:0",
    txHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    outputIndex: 0,
    address: "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
    amount: "5000000",
    assets: {},
  },
  {
    ref: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3:1",
    txHash: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    outputIndex: 1,
    address: "addr_test1qpq42zurawfczgafnfmjuqptv8d0dlhmm60g4g3r0sx0evfvaulnzk7dwkfmgf5cdkghjuqpf07kdrh6ansg2rquc0wsaqv5gc",
    amount: "150000000",
    assets: {
      "aabb001122334455667788990011223344556677889900aabbccddeeff": {
        "474552": "1000000",
      },
    },
  },
  {
    ref: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4:0",
    txHash: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4",
    outputIndex: 0,
    address: "addr_test1qz8fg2e9yn0ga6sav0760cxmx0antql96mfuhqgzcc5swugvaulnzk7dwkfmgf5cdkghjuqpf07kdrh6ansg2rquc0wsaqeq2h",
    amount: "250000000",
    assets: {},
  },
  {
    ref: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5:2",
    txHash: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
    outputIndex: 2,
    address: "addr_test1qruhwxcf0zj9cey0pfjksh67qavdr2gazkyldnqtt2nsn4fvaulnzk7dwkfmgf5cdkghjuqpf07kdrh6ansg2rquc0wsaqxmv7",
    amount: "75000000",
    assets: {
      "ddee334455667788990011223344556677889900aabbccddeeff001122": {
        "4e465431": "1",
        "4e465432": "1",
      },
    },
  },
  {
    ref: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6:0",
    txHash: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
    outputIndex: 0,
    address: "addr_test1wrv40rn87n5pqglm9v68rkraqhfxz3svewm0aw4fuys3w0q4l8ahp",
    amount: "50000000",
    assets: {},
  },
];

const MOCK_DELTAS: DeltaEntry[] = [
  { id: 1, blockHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2", action: "create", utxo: "a1b2c3d4...f0a1b2:0 -> 5 ADA", createdAt: new Date(Date.now() - 20_000).toISOString() },
  { id: 2, blockHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2", action: "spend", utxo: "f6a7b8c9...e5f6a7:1 -> 3.2 ADA", createdAt: new Date(Date.now() - 20_000).toISOString() },
  { id: 3, blockHash: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3", action: "create", utxo: "b2c3d4e5...a1b2c3:1 -> 150 ADA + GER", createdAt: new Date(Date.now() - 40_000).toISOString() },
  { id: 4, blockHash: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3", action: "fee", utxo: "fee: 0.437 ADA", createdAt: new Date(Date.now() - 40_000).toISOString() },
  { id: 5, blockHash: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4", action: "create", utxo: "c3d4e5f6...b2c3d4:0 -> 250 ADA", createdAt: new Date(Date.now() - 60_000).toISOString() },
  { id: 6, blockHash: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5", action: "spend", utxo: "0a1b2c3d...f00102:0 -> 100 ADA", createdAt: new Date(Date.now() - 80_000).toISOString() },
  { id: 7, blockHash: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5", action: "create", utxo: "d4e5f6a7...c3d4e5:2 -> 75 ADA + NFTs", createdAt: new Date(Date.now() - 80_000).toISOString() },
  { id: 8, blockHash: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5", action: "cert", utxo: "stake registration", createdAt: new Date(Date.now() - 80_000).toISOString() },
  { id: 9, blockHash: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6", action: "withdrawal", utxo: "rewards: 12.5 ADA", createdAt: new Date(Date.now() - 100_000).toISOString() },
  { id: 10, blockHash: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6", action: "create", utxo: "e5f6a7b8...d4e5f6:0 -> 50 ADA", createdAt: new Date(Date.now() - 100_000).toISOString() },
];

const Explorer: Component = () => {
  const [query, setQuery] = createSignal("");
  const [searchTerm, setSearchTerm] = createSignal("");
  const [utxos] = createResource(searchTerm, (q) => (q ? fetchUtxos(q) : Promise.resolve([])));
  const [deltas, { refetch }] = createResource(() => fetchRecentDeltas(50));
  const [selected, setSelected] = createSignal<UtxoEntry | null>(null);
  setInterval(refetch, 5000);

  // Demo mode: show mock UTxOs when no search has been performed
  const isDeltasDemo = createMemo(() => (deltas() ?? []).length === 0);

  const effectiveDeltas = createMemo(() => {
    const d = deltas() ?? [];
    return d.length > 0 ? d : MOCK_DELTAS;
  });

  // Show mock UTxOs when search is empty (pre-populated)
  const displayUtxos = createMemo(() => {
    if (!searchTerm()) return MOCK_UTXOS;
    return utxos() ?? [];
  });

  const isUtxoDemo = createMemo(() => !searchTerm());

  function search() { setSearchTerm(query().trim()); }

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      class="flex flex-col gap-5"
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

      <Show when={isDeltasDemo()}>
        <div class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-accent/15 bg-accent/[0.04] px-4 py-2">
          <div class="h-1.5 w-1.5 rounded-full bg-accent/50 pulse-live" />
          <span class="text-[12px] text-text-secondary">
            Demo data — connect a live node for real UTxO queries
          </span>
        </div>
      </Show>
      <div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Results */}
        <div class="lg:col-span-2">
          <Card class="glass-card-accent">
            <CardHeader>
              <div class="flex items-center gap-3">
                <CardTitle>UTxO Results</CardTitle>
                <Badge variant="muted">{displayUtxos().length}</Badge>
                <Show when={isUtxoDemo()}>
                  <Badge variant="purple">demo</Badge>
                </Show>
              </div>
            </CardHeader>
            <div class="max-h-[500px] overflow-y-auto">
              <table class="wallet-table w-full" aria-label="UTxO search results">
                <thead class="sticky top-0 z-10">
                  <tr>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Tx Hash</th>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Idx</th>
                    <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-text-muted">Amount</th>
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
                          <td class="px-5 py-3 font-mono text-[12px] text-text-dim">{utxo.txHash.slice(0, 20)}...</td>
                          <td class="px-5 py-3 font-mono tabular-nums text-[13px] text-text">{utxo.outputIndex}</td>
                          <td class="px-5 py-3 text-right font-mono tabular-nums text-[13px] text-accent">
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
            <Show when={isDeltasDemo()}>
              <Badge variant="purple">demo</Badge>
            </Show>
          </div>
        </CardHeader>
        <div class="max-h-[300px] overflow-y-auto">
          <table class="wallet-table w-full" aria-label="Recent UTxO deltas">
            <thead class="sticky top-0 z-10">
              <tr>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Action</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Block Hash</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Data</th>
                <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Time</th>
              </tr>
            </thead>
            <tbody>
              <TransitionGroup name="row">
                <For each={effectiveDeltas()}>
                  {(d) => (
                    <tr class="border-b border-border-subtle/50">
                      <td class="px-5 py-3"><Badge variant={ACTION_VARIANT[d.action]}>{d.action}</Badge></td>
                      <td class="px-5 py-3 font-mono text-[12px] text-text-dim">{d.blockHash.slice(0, 16)}...</td>
                      <td class="max-w-[300px] truncate px-5 py-3 font-mono text-[11px] text-text-muted">{d.utxo}</td>
                      <td class="px-5 py-3 text-[12px] text-text-dim">{new Date(d.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  )}
                </For>
              </TransitionGroup>
            </tbody>
          </table>
        </div>
      </Card>
    </Motion.div>
  );
};

export default Explorer;
