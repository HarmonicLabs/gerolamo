import { createSignal, createResource, For, Show, type Component } from "solid-js";
import { TransitionGroup } from "solid-transition-group";
import { Motion } from "@motionone/solid";
import {
  createSolidTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/solid-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { fetchMempool, fetchStatus, useSSE, type MempoolTx, type NodeStatus } from "@/lib/api";

function loadMempool(): Promise<MempoolTx[]> {
  return fetchMempool().catch(() => [] as MempoolTx[]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function formatAda(lovelaces: number): string {
  return (lovelaces / 1_000_000).toFixed(6);
}

function shortAda(lovelaces: number): string {
  const ada = lovelaces / 1_000_000;
  if (ada >= 1_000) return `${(ada / 1_000).toFixed(2)}K`;
  return ada.toFixed(2);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Sort direction indicator
// ---------------------------------------------------------------------------

function SortIcon(props: { direction: false | "asc" | "desc" }) {
  if (!props.direction) return <span class="text-text-muted/40 ml-1">&#x21C5;</span>;
  return (
    <span class="text-accent ml-1">
      {props.direction === "asc" ? "\u2191" : "\u2193"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<MempoolTx>[] = [
  {
    accessorKey: "hash",
    header: "Tx Hash",
    enableSorting: false,
    cell: (info) => (
      <span class="font-mono text-[12px] text-text-dim" title={info.getValue<string>()}>
        {info.getValue<string>().slice(0, 16)}...
      </span>
    ),
  },
  {
    accessorKey: "fee",
    header: "Fee",
    cell: (info) => (
      <span class="font-mono text-[12px] tabular-nums text-orange">
        {formatAda(info.getValue<number>())} <span class="text-text-muted text-[10px]">ADA</span>
      </span>
    ),
  },
  {
    accessorKey: "size",
    header: "Size",
    cell: (info) => (
      <span class="font-mono text-[12px] tabular-nums text-text">
        {formatBytes(info.getValue<number>())}
      </span>
    ),
  },
  {
    accessorKey: "arrivedAt",
    header: "Arrived",
    cell: (info) => (
      <span class="text-[12px] text-text-dim">
        {relativeTime(info.getValue<string>())}
      </span>
    ),
  },
  {
    accessorKey: "ttl",
    header: "TTL Slot",
    cell: (info) => (
      <span class="font-mono text-[12px] tabular-nums text-text-secondary">
        {info.getValue<number>().toLocaleString()}
      </span>
    ),
  },
  {
    id: "io",
    header: "I/O",
    enableSorting: false,
    cell: (info) => {
      const tx = info.row.original;
      return (
        <span class="font-mono text-[12px] tabular-nums">
          <span class="text-accent">{tx.inputs.length}</span>
          <span class="text-text-muted mx-1">/</span>
          <span class="text-green">{tx.outputs.length}</span>
        </span>
      );
    },
  },
  {
    id: "scripts",
    header: "Scripts",
    enableSorting: false,
    cell: (info) => {
      const scripts = info.row.original.scripts;
      if (!scripts || scripts.length === 0) {
        return <span class="text-text-muted text-[11px]">--</span>;
      }
      return (
        <Badge variant="purple">
          {scripts.length} {scripts.length === 1 ? "script" : "scripts"}
        </Badge>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Mempool: Component = () => {
  const [mempool, { refetch }] = createResource(loadMempool);
  const [status] = createResource(fetchStatus);
  const { data: liveStatus } = useSSE<NodeStatus | null>("/sse/status", null);
  const [sorting, setSorting] = createSignal<SortingState>([]);

  // Poll every 5s
  setInterval(refetch, 5000);

  const txs = () => mempool() ?? [];

  // Derived stats
  const totalFees = () => txs().reduce((sum, tx) => sum + tx.fee, 0);
  const totalSize = () => txs().reduce((sum, tx) => sum + tx.size, 0);
  const avgFee = () => (txs().length > 0 ? totalFees() / txs().length : 0);
  const oldestAge = () => {
    if (txs().length === 0) return "--";
    const oldest = txs().reduce((min, tx) =>
      new Date(tx.arrivedAt).getTime() < new Date(min.arrivedAt).getTime() ? tx : min
    );
    return relativeTime(oldest.arrivedAt);
  };

  const mempoolCount = () => {
    const live = liveStatus();
    if (live) return live.mempoolSize;
    const s = status();
    if (s) return s.mempoolSize;
    return txs().length;
  };

  const table = createSolidTable({
    get data() { return txs(); },
    columns,
    state: {
      get sorting() { return sorting(); },
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div class="flex flex-col gap-6">
      {/* ─── HEADER ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, easing: [0.16, 1, 0.3, 1] }}
      >
        <div class="glass-card-accent p-6">
          <div class="flex items-center justify-between mb-5">
            <div class="flex items-center gap-3">
              <h1 class="text-h2 text-text">Mempool</h1>
              <Badge variant="neon">{mempoolCount()} pending</Badge>
            </div>
            <span class="text-[11px] font-mono text-text-dim">
              Auto-refresh: 5s
            </span>
          </div>

          {/* Summary stats row */}
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
              <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Pending Txs</span>
              <span class="font-mono text-[18px] font-bold tabular-nums text-green text-glow-green">{txs().length}</span>
            </div>
            <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
              <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Total Size</span>
              <span class="font-mono text-[18px] font-bold tabular-nums text-text">{formatBytes(totalSize())}</span>
            </div>
            <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
              <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Avg Fee</span>
              <span class="font-mono text-[18px] font-bold tabular-nums text-orange text-glow-orange">{shortAda(avgFee())}</span>
              <span class="text-[10px] text-text-muted">ADA</span>
            </div>
            <div class="flex flex-col items-center text-center rounded-[var(--radius-sm)] bg-bg-sunken/50 py-3 px-2 min-h-[72px]">
              <span class="text-[10px] uppercase tracking-wider text-text-dim font-medium mb-1">Oldest</span>
              <span class="font-mono text-[14px] font-bold tabular-nums text-text">{oldestAge()}</span>
            </div>
          </div>
        </div>
      </Motion.div>

      {/* ─── TOTAL FEES CARD ─── */}
      <div class="stagger grid grid-cols-3 gap-4">
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Total Fees" value={`${shortAda(totalFees())}`} sub="ADA" accent glow size="md" glowColor="orange" />
          </CardContent>
        </Card>
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Scripted Txs" value={txs().filter(t => t.scripts && t.scripts.length > 0).length} size="md" accent glow glowColor="red" />
          </CardContent>
        </Card>
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Simple Txs" value={txs().filter(t => !t.scripts || t.scripts.length === 0).length} size="md" />
          </CardContent>
        </Card>
      </div>

      {/* ─── TRANSACTION TABLE ─── */}
      <Motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.15 }}
      >
        <Card class="glass-card-accent">
          <CardHeader>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <CardTitle>Pending Transactions</CardTitle>
                <Badge variant="muted">{txs().length}</Badge>
              </div>
              <span class="text-[11px] text-text-dim">Click headers to sort</span>
            </div>
          </CardHeader>

          <Show
            when={txs().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-3 px-4 py-20">
                <div class="h-10 w-10 rounded-[var(--radius-sm)] border border-border bg-bg-sunken flex items-center justify-center">
                  <svg class="h-5 w-5 text-text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                    <path d="M4 4h16v16H4z" />
                    <path d="M9 9h6M9 13h4" />
                  </svg>
                </div>
                <span class="text-[13px] text-text-secondary">
                  Mempool is empty
                </span>
                <span class="text-[11px] text-text-muted">
                  No pending transactions at this time. New transactions will appear here.
                </span>
              </div>
            }
          >
            <div class="overflow-x-auto">
              <table class="wallet-table w-full" aria-label="Pending mempool transactions">
                <thead>
                  <For each={table.getHeaderGroups()}>
                    {(hg) => (
                      <tr>
                        <For each={hg.headers}>
                          {(h) => (
                            <th
                              scope="col"
                              class="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted select-none"
                              classList={{ "cursor-pointer hover:text-text-secondary": h.column.getCanSort() }}
                              onClick={h.column.getToggleSortingHandler()}
                              aria-sort={
                                h.column.getIsSorted() === "asc" ? "ascending"
                                  : h.column.getIsSorted() === "desc" ? "descending"
                                  : undefined
                              }
                            >
                              <span class="inline-flex items-center gap-0.5">
                                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                                <Show when={h.column.getCanSort()}>
                                  <SortIcon direction={h.column.getIsSorted()} />
                                </Show>
                              </span>
                            </th>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </thead>
                <tbody>
                  <TransitionGroup name="row">
                    <For each={table.getRowModel().rows}>
                      {(row) => (
                        <tr class="border-b border-border-subtle/50">
                          <For each={row.getVisibleCells()}>
                            {(cell) => (
                              <td class="px-6 py-4 text-sm">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </TransitionGroup>
                </tbody>
              </table>
            </div>
          </Show>
        </Card>
      </Motion.div>
    </div>
  );
};

export default Mempool;
