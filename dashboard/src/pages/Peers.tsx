import { createResource, For, type Component } from "solid-js";
import {
  createSolidTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/solid-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { fetchPeers, type PeerInfo } from "@/lib/api";

const categoryVariant = {
  hot: "success" as const,
  warm: "warning" as const,
  cold: "muted" as const,
  bootstrap: "info" as const,
  new: "default" as const,
};

const columns: ColumnDef<PeerInfo>[] = [
  {
    accessorKey: "host",
    header: "Host",
    cell: (info) => <span class="font-mono text-xs">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: "port",
    header: "Port",
    cell: (info) => <span class="font-mono tabular-nums">{info.getValue<number>()}</span>,
  },
  {
    accessorKey: "category",
    header: "Category",
    cell: (info) => {
      const cat = info.getValue<PeerInfo["category"]>();
      return <Badge variant={categoryVariant[cat]}>{cat}</Badge>;
    },
  },
  {
    accessorKey: "slot",
    header: "Tip Slot",
    cell: (info) => (
      <span class="font-mono text-accent tabular-nums">
        {info.getValue<number>() > 0 ? info.getValue<number>().toLocaleString() : "—"}
      </span>
    ),
  },
  {
    accessorKey: "connected",
    header: "Status",
    cell: (info) =>
      info.getValue<boolean>() ? (
        <div class="flex items-center gap-1.5">
          <div class="h-1.5 w-1.5 rounded-full bg-green" />
          <span class="text-xs text-green">Connected</span>
        </div>
      ) : (
        <div class="flex items-center gap-1.5">
          <div class="h-1.5 w-1.5 rounded-full bg-red" />
          <span class="text-xs text-red">Disconnected</span>
        </div>
      ),
  },
];

const Peers: Component = () => {
  const [peers, { refetch }] = createResource(fetchPeers);
  setInterval(refetch, 10000);

  const table = createSolidTable({
    get data() { return peers() ?? []; },
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const hotCount = () => (peers() ?? []).filter((p) => p.category === "hot").length;
  const warmCount = () => (peers() ?? []).filter((p) => p.category === "warm").length;
  const totalCount = () => (peers() ?? []).length;

  return (
    <div class="flex flex-col gap-4">
      <div class="grid grid-cols-3 gap-4">
        <Card>
          <CardContent class="flex items-center justify-center py-4">
            <Stat label="Hot Peers" value={hotCount()} accent />
          </CardContent>
        </Card>
        <Card>
          <CardContent class="flex items-center justify-center py-4">
            <Stat label="Warm Peers" value={warmCount()} />
          </CardContent>
        </Card>
        <Card>
          <CardContent class="flex items-center justify-center py-4">
            <Stat label="Total Peers" value={totalCount()} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Peer Connections</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead>
                <For each={table.getHeaderGroups()}>
                  {(headerGroup) => (
                    <tr class="border-b border-border">
                      <For each={headerGroup.headers}>
                        {(header) => (
                          <th class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
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
                    <tr class="border-b border-border/50 transition-colors hover:bg-bg-sunken">
                      <For each={row.getVisibleCells()}>
                        {(cell) => (
                          <td class="px-3 py-2">
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
        </CardContent>
      </Card>
    </div>
  );
};

export default Peers;
