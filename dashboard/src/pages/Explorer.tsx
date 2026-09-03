import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Motion } from "@motionone/solid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonTable } from "@/components/ui/skeleton";
import {
  absoluteTime,
  explorer,
  explorerHref,
  lovelaceOf,
  lovelaceToAda,
  parseExplorerRoute,
  relativeTime,
  shortHash,
  type BfAmount,
  type BfBlock,
  type ExplorerRoute,
  type NodeMetrics,
} from "@/lib/explorer";

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const Link: Component<{ href: string; class?: string; title?: string; children: JSX.Element }> = (props) => (
  <a href={props.href} class={`font-mono text-accent hover:underline ${props.class ?? ""}`} title={props.title}>
    {props.children}
  </a>
);

const Row: Component<{ label: string; children: JSX.Element; mono?: boolean }> = (props) => (
  <div class="flex items-start justify-between gap-4 border-b border-border-subtle/40 py-2 text-[12px]">
    <span class="shrink-0 text-text-dim">{props.label}</span>
    <span class={`min-w-0 text-right break-all text-text ${props.mono ? "font-mono" : ""}`}>{props.children}</span>
  </div>
);

const Amounts: Component<{ amount: BfAmount[] | null | undefined }> = (props) => {
  const assets = () => (props.amount ?? []).filter((a) => a.unit !== "lovelace");
  return (
    <span class="font-mono tabular-nums">
      {lovelaceToAda(lovelaceOf(props.amount).toString())}
      <Show when={assets().length > 0}>
        <span class="ml-2 text-[10px] text-text-dim" title={assets().map((a) => `${a.unit}: ${a.quantity}`).join("\n")}>
          +{assets().length} asset{assets().length === 1 ? "" : "s"}
        </span>
      </Show>
    </span>
  );
};

const ErrorBox: Component<{ error: unknown; what: string }> = (props) => (
  <div class="rounded-[var(--radius)] border border-red/20 bg-red-dim px-4 py-3 text-[12px] text-red">
    {props.what}: {(props.error as Error)?.message ?? String(props.error)}
  </div>
);

function useTip() {
  const [tip, { refetch }] = createResource<NodeMetrics | null>(() => explorer.metrics().catch(() => null));
  const timer = setInterval(() => void refetch(), 5000);
  onCleanup(() => clearInterval(timer));
  return tip;
}

// ---------------------------------------------------------------------------
// Blocks list
// ---------------------------------------------------------------------------

const BlocksPage: Component<{ before?: string }> = (props) => {
  const [pages, setPages] = createSignal<BfBlock[][]>([]);
  const [cursor, setCursor] = createSignal<string | undefined>(props.before);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(null);
  const all = createMemo(() => pages().flat());

  const loadMore = async () => {
    if (loading()) return;
    setLoading(true);
    setError(null);
    try {
      const page = await explorer.blocks(25, cursor());
      setPages((p) => [...p, page]);
      const last = page[page.length - 1];
      setCursor(last ? last.hash : undefined);
      if (page.length === 0) setCursor(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void loadMore());

  // live prepend: poll the tip every 5 s and fetch anything newer than the first row
  const timer = setInterval(async () => {
    const first = all()[0];
    if (!first || props.before) return;
    try {
      const fresh = await explorer.blocks(10);
      const newer = fresh.filter((b) => b.slot > first.slot || (b.slot === first.slot && b.hash !== first.hash && !all().some((x) => x.hash === b.hash)));
      if (newer.length) setPages((p) => [newer, ...p]);
    } catch {
      /* transient */
    }
  }, 5000);
  onCleanup(() => clearInterval(timer));

  return (
    <Card class="glass-card-accent flex flex-col flex-1 min-h-0">
      <CardHeader>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <CardTitle>Blocks</CardTitle>
            <Badge variant="muted">{all().length}</Badge>
          </div>
          <span class="text-[11px] text-text-dim">newest first · click a row for the block, an epoch, or the leader</span>
        </div>
      </CardHeader>
      <div class="flex-1 overflow-y-auto">
        <table class="wallet-table w-full" aria-label="Blocks">
          <thead class="sticky top-0 z-10">
            <tr>
              <For each={["Height", "Slot", "Epoch", "Time", "Txs", "Size", "Leader", "Hash"]}>
                {(h) => <th scope="col" class="bg-bg-raised/95 backdrop-blur-sm px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-text-muted">{h}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={all()}>
              {(b) => (
                <tr class="border-b border-border-subtle/40 hover:bg-accent/[0.03]">
                  <td class="px-3 py-2 font-mono tabular-nums text-[12px]">
                    <Link href={explorerHref({ page: "block", id: b.hash })}>{b.height ?? (b.ebb ? "EBB" : "—")}</Link>
                  </td>
                  <td class="px-3 py-2 font-mono tabular-nums text-[12px] text-text-secondary">{b.slot.toLocaleString()}</td>
                  <td class="px-3 py-2 font-mono tabular-nums text-[12px]">
                    <Link href={explorerHref({ page: "epoch", epoch: b.epoch })}>{b.epoch}</Link>
                    <span class="text-text-dim"> / {b.epoch_slot ?? "—"}</span>
                  </td>
                  <td class="px-3 py-2 text-[12px] text-text-secondary" title={absoluteTime(b.time)}>{relativeTime(b.time)}</td>
                  <td class="px-3 py-2 text-[12px]"><Badge variant={(b.tx_count ?? 0) > 0 ? "success" : "muted"}>{b.tx_count ?? 0}</Badge></td>
                  <td class="px-3 py-2 font-mono tabular-nums text-[12px] text-text-secondary">{b.size != null ? `${(b.size / 1024).toFixed(1)} KB` : "—"}</td>
                  <td class="px-3 py-2 font-mono text-[11px] text-text-dim" title={b.slot_leader ?? ""}>{shortHash(b.slot_leader, 6, 4)}</td>
                  <td class="px-3 py-2 font-mono text-[11px]"><Link href={explorerHref({ page: "block", id: b.hash })} title={b.hash}>{shortHash(b.hash)}</Link></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={loading() && all().length === 0}><div class="p-3"><SkeletonTable rows={8} /></div></Show>
        <Show when={error()}><div class="p-3"><ErrorBox error={error()} what="Could not load blocks" /></div></Show>
        <div class="flex items-center justify-center gap-3 p-3">
          <Show when={cursor() && !loading()}>
            <button class="rounded-[var(--radius)] border border-accent/20 bg-accent-dim px-4 py-2 text-[12px] font-semibold text-accent hover:bg-accent-mid" onClick={() => void loadMore()}>
              Load older blocks
            </button>
          </Show>
          <Show when={!cursor() && all().length > 0}><span class="text-[11px] text-text-muted">Genesis reached</span></Show>
          <Show when={!loading() && !error() && all().length === 0}><span class="text-[12px] text-text-secondary">No blocks yet. Start the node to sync.</span></Show>
        </div>
      </div>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

const BlockPage: Component<{ id: string }> = (props) => {
  const [block] = createResource(() => props.id, (id) => explorer.block(id));
  const [txs] = createResource(() => props.id, (id) => explorer.blockTxs(id).catch(() => [] as string[]));
  return (
    <div class="flex flex-col gap-4">
      <Show when={block.error}><ErrorBox error={block.error} what="Block" /></Show>
      <Show when={block.loading}><SkeletonCard lines={6} /></Show>
      <Show when={block()}>
        {(b) => (
          <Card class="glass-card-accent">
            <CardHeader>
              <div class="flex items-center justify-between">
                <CardTitle>Block {b().height ?? (b().ebb ? "(epoch boundary)" : "")}</CardTitle>
                <div class="flex gap-2">
                  <Show when={b().previous_block}><Link href={explorerHref({ page: "block", id: b().previous_block! })} class="text-[11px]">← previous</Link></Show>
                  <Show when={b().next_block}><Link href={explorerHref({ page: "block", id: b().next_block! })} class="text-[11px]">next →</Link></Show>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Row label="Hash" mono>{b().hash}</Row>
              <Row label="Slot" mono>{b().slot.toLocaleString()}</Row>
              <Row label="Epoch"><Link href={explorerHref({ page: "epoch", epoch: b().epoch })}>{b().epoch}</Link> <span class="text-text-dim">slot {b().epoch_slot ?? "—"} of epoch</span></Row>
              <Row label="Time">{absoluteTime(b().time)} <span class="text-text-dim">({relativeTime(b().time)})</span></Row>
              <Row label="Slot leader" mono>{b().slot_leader ?? "—"}</Row>
              <Row label="Size">{b().size != null ? `${b().size!.toLocaleString()} bytes` : "—"}</Row>
              <Row label="Transactions">{b().tx_count ?? 0}</Row>
              <Row label="Confirmations">{b().confirmations ?? "—"}</Row>
              <Row label="Previous block" mono><Show when={b().previous_block} fallback="—"><Link href={explorerHref({ page: "block", id: b().previous_block! })}>{b().previous_block}</Link></Show></Row>
            </CardContent>
          </Card>
        )}
      </Show>
      <Show when={(txs() ?? []).length > 0}>
        <Card class="glass-card">
          <CardHeader><div class="flex items-center gap-3"><CardTitle>Transactions</CardTitle><Badge variant="success">{txs()!.length}</Badge></div></CardHeader>
          <CardContent>
            <div class="flex flex-col gap-1">
              <For each={txs()}>
                {(t, i) => (
                  <div class="flex items-center gap-3 text-[12px]">
                    <span class="w-8 text-right font-mono text-text-dim">{i()}</span>
                    <Link href={explorerHref({ page: "tx", hash: t })}>{t}</Link>
                  </div>
                )}
              </For>
            </div>
          </CardContent>
        </Card>
      </Show>
      <Show when={block() && (txs() ?? []).length === 0 && (block()!.tx_count ?? 0) > 0}>
        <div class="text-[12px] text-text-muted">This block's transactions are not indexed yet (forward index paused or backfill pending).</div>
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

const TxPage: Component<{ hash: string }> = (props) => {
  const [tx] = createResource(() => props.hash, (h) => explorer.tx(h));
  const [io] = createResource(() => props.hash, (h) => explorer.txUtxos(h).catch(() => null));
  return (
    <div class="flex flex-col gap-4">
      <Show when={tx.error}><ErrorBox error={tx.error} what="Transaction" /></Show>
      <Show when={tx.loading}><SkeletonCard lines={6} /></Show>
      <Show when={tx()}>
        {(t) => (
          <Card class="glass-card-accent">
            <CardHeader><CardTitle>Transaction</CardTitle></CardHeader>
            <CardContent>
              <Row label="Hash" mono>{t().hash}</Row>
              <Row label="Block" mono><Show when={t().block} fallback="—"><Link href={explorerHref({ page: "block", id: t().block! })}>{t().block}</Link></Show></Row>
              <Row label="Height / index">{t().block_height ?? "—"} / {t().index ?? "—"}</Row>
              <Row label="Slot / time" mono>{t().slot.toLocaleString()} <span class="text-text-dim">{absoluteTime(t().block_time)}</span></Row>
              <Row label="Fee">{t().fees != null ? lovelaceToAda(t().fees!) : "—"}</Row>
              <Row label="Total output"><Amounts amount={t().output_amount} /></Row>
              <Row label="Size">{t().size != null ? `${t().size} bytes` : "—"}</Row>
              <Row label="Validity">{t().invalid_before ?? "—"} … {t().invalid_hereafter ?? "—"}</Row>
              <Row label="UTxOs">{t().utxo_count ?? "—"}</Row>
            </CardContent>
          </Card>
        )}
      </Show>
      <Show when={io()}>
        {(u) => (
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card class="glass-card">
              <CardHeader><div class="flex items-center gap-3"><CardTitle>Inputs</CardTitle><Badge variant="muted">{u().inputs.length}</Badge></div></CardHeader>
              <CardContent>
                <For each={u().inputs}>
                  {(inp) => (
                    <div class="border-b border-border-subtle/40 py-2 text-[12px]">
                      <div class="flex items-center justify-between gap-2">
                        <Link href={explorerHref({ page: "tx", hash: inp.tx_hash })} title={inp.tx_hash}>{shortHash(inp.tx_hash)}#{inp.output_index}</Link>
                        <Show when={inp.collateral}><Badge variant="warning">collateral</Badge></Show>
                        <Show when={inp.reference}><Badge variant="info">reference</Badge></Show>
                      </div>
                      <Show when={inp.address}><div class="truncate"><Link href={explorerHref({ page: "address", address: inp.address! })} class="text-[11px]" title={inp.address!}>{inp.address}</Link></div></Show>
                      <Amounts amount={inp.amount} />
                    </div>
                  )}
                </For>
              </CardContent>
            </Card>
            <Card class="glass-card">
              <CardHeader><div class="flex items-center gap-3"><CardTitle>Outputs</CardTitle><Badge variant="muted">{u().outputs.length}</Badge></div></CardHeader>
              <CardContent>
                <For each={u().outputs}>
                  {(out) => (
                    <div class="border-b border-border-subtle/40 py-2 text-[12px]">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-mono text-text-dim">#{out.output_index}</span>
                        <Show when={out.collateral}><Badge variant="warning">collateral return</Badge></Show>
                      </div>
                      <div class="truncate"><Link href={explorerHref({ page: "address", address: out.address })} class="text-[11px]" title={out.address}>{out.address}</Link></div>
                      <Amounts amount={out.amount} />
                      <Show when={out.data_hash}><div class="font-mono text-[10px] text-text-dim">datum {shortHash(out.data_hash, 10, 8)}</div></Show>
                      <Show when={out.inline_datum}><div class="font-mono text-[10px] text-text-dim break-all">inline datum {shortHash(out.inline_datum, 16, 8)}</div></Show>
                      <Show when={out.reference_script_hash}><div class="font-mono text-[10px] text-text-dim">script {out.reference_script_hash}</div></Show>
                    </div>
                  )}
                </For>
              </CardContent>
            </Card>
          </div>
        )}
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

const AddressPage: Component<{ address: string }> = (props) => {
  const [info] = createResource(() => props.address, (a) => explorer.address(a));
  const [utxos] = createResource(() => props.address, (a) => explorer.addressUtxos(a).catch(() => []));
  const [page, setPage] = createSignal(1);
  const [txs] = createResource(() => [props.address, page()] as const, ([a, p]) => explorer.addressTxs(a, p, 50).catch(() => []));
  return (
    <div class="flex flex-col gap-4">
      <Show when={info.error}><ErrorBox error={info.error} what="Address" /></Show>
      <Show when={info.loading}><SkeletonCard lines={4} /></Show>
      <Show when={info()}>
        {(a) => (
          <Card class="glass-card-accent">
            <CardHeader><CardTitle>Address</CardTitle></CardHeader>
            <CardContent>
              <Row label="Address" mono>{a().address}</Row>
              <Row label="Balance"><Amounts amount={a().amount} /></Row>
              <Row label="Stake key" mono>{a().stake_address ?? "—"}</Row>
              <Row label="Type">{a().type ?? "—"}{a().script ? " · script" : ""}</Row>
              <Row label="UTxOs / txs">{a().utxo_count ?? "—"} / {a().tx_count ?? "—"}</Row>
            </CardContent>
          </Card>
        )}
      </Show>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card class="glass-card">
          <CardHeader><div class="flex items-center gap-3"><CardTitle>UTxOs</CardTitle><Badge variant="muted">{(utxos() ?? []).length}</Badge></div></CardHeader>
          <CardContent>
            <For each={utxos() ?? []}>
              {(u) => (
                <div class="flex items-center justify-between gap-2 border-b border-border-subtle/40 py-2 text-[12px]">
                  <Link href={explorerHref({ page: "tx", hash: u.tx_hash })} title={u.tx_hash}>{shortHash(u.tx_hash)}#{u.output_index}</Link>
                  <Amounts amount={u.amount} />
                </div>
              )}
            </For>
          </CardContent>
        </Card>
        <Card class="glass-card">
          <CardHeader><div class="flex items-center justify-between"><CardTitle>Transactions</CardTitle><div class="flex items-center gap-2 text-[11px]"><button class="text-accent disabled:text-text-muted" disabled={page() <= 1} onClick={() => setPage(page() - 1)}>‹</button><span class="text-text-dim">page {page()}</span><button class="text-accent disabled:text-text-muted" disabled={(txs() ?? []).length < 50} onClick={() => setPage(page() + 1)}>›</button></div></div></CardHeader>
          <CardContent>
            <For each={txs() ?? []}>
              {(t) => (
                <div class="flex items-center justify-between gap-2 border-b border-border-subtle/40 py-2 text-[12px]">
                  <Link href={explorerHref({ page: "tx", hash: t.tx_hash })} title={t.tx_hash}>{shortHash(t.tx_hash, 12, 8)}</Link>
                  <span class="font-mono text-text-dim">{t.slot != null ? `slot ${t.slot.toLocaleString()}` : ""} {t.direction ?? ""}</span>
                </div>
              )}
            </For>
            <Show when={(txs() ?? []).length === 0 && !txs.loading}><div class="py-3 text-[12px] text-text-muted">No indexed transactions for this address.</div></Show>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Epoch
// ---------------------------------------------------------------------------

const EpochPage: Component<{ epoch: number }> = (props) => {
  const [epoch] = createResource(() => props.epoch, (n) => explorer.epoch(n));
  const [params] = createResource(() => props.epoch, (n) => explorer.epochParameters(n).catch(() => null));
  const [page, setPage] = createSignal(1);
  const [hashes] = createResource(() => [props.epoch, page()] as const, ([n, p]) => explorer.epochBlocks(n, p, 50).catch(() => []));
  createEffect(() => {
    props.epoch;
    setPage(1);
  });
  return (
    <div class="flex flex-col gap-4">
      <Show when={epoch.error}><ErrorBox error={epoch.error} what="Epoch" /></Show>
      <Show when={epoch()}>
        {(e) => (
          <Card class="glass-card-accent">
            <CardHeader>
              <div class="flex items-center justify-between">
                <CardTitle>Epoch {e().epoch}</CardTitle>
                <div class="flex gap-3 text-[11px]">
                  <Show when={e().epoch > 0}><Link href={explorerHref({ page: "epoch", epoch: e().epoch - 1 })}>← {e().epoch - 1}</Link></Show>
                  <Link href={explorerHref({ page: "epoch", epoch: e().epoch + 1 })}>{e().epoch + 1} →</Link>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Row label="Start">{absoluteTime(e().start_time)}</Row>
              <Row label="End">{absoluteTime(e().end_time)}</Row>
              <Row label="Slots" mono>{e().first_slot.toLocaleString()} – {e().last_slot.toLocaleString()}</Row>
              <Row label="Blocks synced">{e().block_count.toLocaleString()} <Badge variant={e().synced === "complete" ? "success" : e().synced === "partial" ? "warning" : "muted"}>{e().synced}</Badge></Row>
              <Row label="First block" mono><Show when={e().first_block} fallback="—"><Link href={explorerHref({ page: "block", id: e().first_block! })}>{e().first_block}</Link></Show></Row>
              <Row label="Last block" mono><Show when={e().last_block} fallback="—"><Link href={explorerHref({ page: "block", id: e().last_block! })}>{e().last_block}</Link></Show></Row>
            </CardContent>
          </Card>
        )}
      </Show>
      <Show when={params()}>
        {(p) => (
          <Card class="glass-card">
            <CardHeader><CardTitle>Protocol parameters</CardTitle></CardHeader>
            <CardContent>
              <div class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
                <For each={Object.entries(p()).filter(([k, v]) => k !== "epoch" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))}>
                  {([k, v]) => <Row label={k} mono>{String(v)}</Row>}
                </For>
              </div>
            </CardContent>
          </Card>
        )}
      </Show>
      <Card class="glass-card">
        <CardHeader><div class="flex items-center justify-between"><CardTitle>Blocks</CardTitle><div class="flex items-center gap-2 text-[11px]"><button class="text-accent disabled:text-text-muted" disabled={page() <= 1} onClick={() => setPage(page() - 1)}>‹</button><span class="text-text-dim">page {page()}</span><button class="text-accent disabled:text-text-muted" disabled={(hashes() ?? []).length < 50} onClick={() => setPage(page() + 1)}>›</button></div></div></CardHeader>
        <CardContent>
          <div class="grid grid-cols-1 gap-1 md:grid-cols-2">
            <For each={hashes() ?? []}>{(h) => <Link href={explorerHref({ page: "block", id: h })} class="truncate text-[11px]">{h}</Link>}</For>
          </div>
          <Show when={(hashes() ?? []).length === 0 && !hashes.loading}><div class="py-3 text-[12px] text-text-muted">No blocks of this epoch are synced.</div></Show>
        </CardContent>
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchPage: Component<{ q: string }> = (props) => {
  const [result] = createResource(() => props.q, (q) => (q ? explorer.search(q) : Promise.resolve(null)));
  createEffect(() => {
    const r = result();
    if (!r) return;
    if (r.kind === "tx") location.hash = explorerHref({ page: "tx", hash: r.id });
    else if (r.kind === "block") location.hash = explorerHref({ page: "block", id: r.id });
    else if (r.kind === "address") location.hash = explorerHref({ page: "address", address: r.id });
  });
  return (
    <Card class="glass-card">
      <CardContent>
        <Show when={result.loading}><span class="text-[12px] text-text-secondary">Searching…</span></Show>
        <Show when={result() && ["unknown", "stake", "pool"].includes(result()!.kind)}>
          <div class="text-[12px] text-text-secondary">
            {result()!.kind === "unknown" ? `Nothing found for "${props.q}"${result()!.message ? ` — ${result()!.message}` : ""}.` : `${result()!.kind} pages are not available yet (staking view is a later milestone).`}
          </div>
        </Show>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Explorer shell: search box, tip banner, hash router
// ---------------------------------------------------------------------------

const Explorer: Component = () => {
  const [route, setRoute] = createSignal<ExplorerRoute>(parseExplorerRoute(location.hash));
  const [query, setQuery] = createSignal("");
  const onHash = () => setRoute(parseExplorerRoute(location.hash));
  onMount(() => {
    window.addEventListener("hashchange", onHash);
    if (!location.hash.startsWith("#/explorer")) location.hash = "#/explorer";
  });
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  const tip = useTip();
  const go = () => {
    const q = query().trim();
    if (q) location.hash = explorerHref({ page: "search", q });
  };
  return (
    <Motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} class="flex h-full flex-col gap-4">
      <div class="flex gap-3" role="search" aria-label="Explorer search">
        <div class="relative flex-1">
          <svg class="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Block hash or height, slot, transaction hash, address…"
            aria-label="Search the chain"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            class="w-full rounded-[var(--radius)] border border-border bg-bg-input pl-11 pr-4 py-3 font-mono text-[13px] text-text outline-none placeholder:text-text-muted/50 focus:border-accent/30 focus:ring-1 focus:ring-accent/15 transition-all"
          />
        </div>
        <button onClick={go} class="rounded-[var(--radius)] border border-accent/20 bg-accent-dim px-6 py-3 text-[13px] font-semibold text-accent transition-all hover:bg-accent-mid">Search</button>
        <a href="#/explorer" class="rounded-[var(--radius)] border border-border px-4 py-3 text-[13px] text-text-secondary hover:text-text">Blocks</a>
      </div>

      <Show when={tip()}>
        {(t) => (
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-dim">
            <span>network <span class="font-mono text-text">{t().network}</span></span>
            <span>tip slot <span class="font-mono text-text">{Number(t().tipSlot).toLocaleString()}</span></span>
            <span>epoch <span class="font-mono text-text">{t().epoch ?? "—"}</span></span>
            <Show when={t().eraName}><span>era <span class="font-mono text-text">{t().eraName}</span></span></Show>
            <Show when={(t().sync?.blocksPerSec ?? 0) > 1}>
              <Badge variant="warning">syncing · {t().sync!.blocksPerSec!.toFixed(0)} blocks/s</Badge>
            </Show>
          </div>
        )}
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show when={route().page === "blocks"}><BlocksPage before={(route() as any).before} /></Show>
        <Show when={route().page === "block"}><BlockPage id={(route() as any).id} /></Show>
        <Show when={route().page === "tx"}><TxPage hash={(route() as any).hash} /></Show>
        <Show when={route().page === "address"}><AddressPage address={(route() as any).address} /></Show>
        <Show when={route().page === "epoch"}><EpochPage epoch={(route() as any).epoch} /></Show>
        <Show when={route().page === "search"}><SearchPage q={(route() as any).q} /></Show>
      </div>
    </Motion.div>
  );
};

export default Explorer;
