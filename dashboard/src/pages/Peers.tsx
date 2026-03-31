import { createResource, createMemo, For, Show, type Component } from "solid-js";
import { Motion } from "@motionone/solid";
import {
  createSolidTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/solid-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { fetchPeers, fetchStatus, type PeerInfo } from "@/lib/api";
import { mockPeers } from "@/mocks";

const catVariant = {
  hot: "success" as const,
  warm: "warning" as const,
  cold: "muted" as const,
  bootstrap: "neon" as const,
  new: "purple" as const,
};

const columns: ColumnDef<PeerInfo>[] = [
  {
    accessorKey: "host",
    header: "Host",
    cell: (info) => <span class="font-mono text-[13px] text-text-dim">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: "port",
    header: "Port",
    cell: (info) => <span class="font-mono tabular-nums text-[13px] text-accent/70">{info.getValue<number>()}</span>,
  },
  {
    accessorKey: "category",
    header: "Role",
    cell: (info) => {
      const cat = info.getValue<PeerInfo["category"]>();
      return <Badge variant={catVariant[cat]}>{cat}</Badge>;
    },
  },
  {
    accessorKey: "slot",
    header: "Tip Slot",
    cell: (info) => (
      <span class="font-mono tabular-nums text-[13px]">
        {info.getValue<number>() > 0 ? info.getValue<number>().toLocaleString() : <span class="text-text-muted">{"\u2014"}</span>}
      </span>
    ),
  },
  {
    accessorKey: "connected",
    header: "Status",
    cell: (info) => (
      <div class="flex items-center gap-2">
        <div
          class="h-[6px] w-[6px] rounded-full"
          classList={{
            "bg-green pulse-live": info.getValue<boolean>(),
            "bg-text-muted": !info.getValue<boolean>(),
          }}
          aria-hidden="true"
        />
        <span class="text-[12px] text-text-dim">
          {info.getValue<boolean>() ? "Connected" : "Offline"}
        </span>
      </div>
    ),
  },
];

const Peers: Component = () => {
  const [peers, { refetch }] = createResource(fetchPeers);
  const [status] = createResource(fetchStatus);
  setInterval(refetch, 10000);

  // Fall back to mock peers if API returns empty or only unconnected bootstrap peers
  const isDemo = createMemo(() => {
    const p = peers() ?? [];
    if (p.length === 0) return true;
    const hasConnected = p.some((peer) => peer.connected);
    const hasHotOrWarm = p.some((peer) => peer.category === "hot" || peer.category === "warm");
    return !hasConnected && !hasHotOrWarm;
  });

  const effectivePeers = createMemo<PeerInfo[]>(() => {
    const p = peers() ?? [];
    if (isDemo()) return mockPeers;
    return p;
  });

  const table = createSolidTable({
    get data() { return effectivePeers(); },
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const hot = () => effectivePeers().filter((p) => p.category === "hot").length;
  const warm = () => effectivePeers().filter((p) => p.category === "warm").length;
  const total = () => effectivePeers().length;
  const network = () => status()?.network ?? "preprod";

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      class="flex flex-col gap-5"
    >
      {/* Demo banner */}
      <Show when={isDemo()}>
        <div class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-accent/15 bg-accent/[0.04] px-4 py-2">
          <div class="h-1.5 w-1.5 rounded-full bg-accent/50 pulse-live" />
          <span class="text-[12px] text-text-secondary">
            Demo mode — showing simulated peer connections
          </span>
        </div>
      </Show>

      {/* Summary stats */}
      <div class="stagger grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Hot Peers" value={hot()} accent glow size="md" />
          </CardContent>
        </Card>
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Warm Peers" value={warm()} size="md" />
          </CardContent>
        </Card>
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Total Peers" value={total()} size="md" />
          </CardContent>
        </Card>
        <Card class="glass-card-accent">
          <CardContent>
            <Stat label="Network" value={network()} accent size="md" />
          </CardContent>
        </Card>
      </div>

      {/* Peer table */}
      <Card class="glass-card-accent">
        <CardHeader>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <CardTitle>Peer Connections</CardTitle>
              <Badge variant="muted">{total()}</Badge>
            </div>
            <span class="text-[11px] text-text-dim font-mono">
              {hot()} active · {warm()} standby
            </span>
          </div>
        </CardHeader>
        <div class="overflow-x-auto">
          <table class="wallet-table w-full" aria-label="Peer connections">
            <thead>
              <For each={table.getHeaderGroups()}>
                {(hg) => (
                  <tr>
                    <For each={hg.headers}>
                      {(h) => (
                        <th scope="col" class="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-text-muted">
                          {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                        </th>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        </div>
        {total() === 0 && (
          <div class="flex flex-col items-center gap-3 px-4 py-20">
            <div class="h-10 w-10 rounded-[var(--radius-sm)] border border-border bg-bg-sunken flex items-center justify-center">
              <svg class="h-5 w-5 text-text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
              </svg>
            </div>
            <span class="text-[13px] text-text-secondary">No peers connected</span>
            <span class="text-[11px] text-text-muted">Start the node to join the Cardano network.</span>
          </div>
        )}
      </Card>
    </Motion.div>
  );
};

export default Peers;
