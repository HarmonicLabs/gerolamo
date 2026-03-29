import { createResource, For, Show, type Component } from "solid-js";
import {
  createSolidTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/solid-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchRecentBlocks, useSSE, type BlockInfo } from "@/lib/api";

const ERA_NAMES: Record<number, string> = {
  0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary",
  4: "Alonzo", 5: "Babbage", 6: "Conway",
};

const columns: ColumnDef<BlockInfo>[] = [
  {
    accessorKey: "slot",
    header: "Slot",
    cell: (info) => (
      <span class="font-mono text-accent tabular-nums">{info.getValue<number>().toLocaleString()}</span>
    ),
  },
  {
    accessorKey: "hash",
    header: "Hash",
    cell: (info) => (
      <span class="font-mono text-xs text-text-dim" title={info.getValue<string>()}>
        {info.getValue<string>().slice(0, 16)}...
      </span>
    ),
  },
  {
    accessorKey: "era",
    header: "Era",
    cell: (info) => <Badge variant="info">{ERA_NAMES[info.getValue<number>()] ?? `Era ${info.getValue()}`}</Badge>,
  },
  {
    accessorKey: "epoch",
    header: "Epoch",
    cell: (info) => <span class="font-mono tabular-nums">{info.getValue<number>()}</span>,
  },
  {
    accessorKey: "txCount",
    header: "Txs",
    cell: (info) => <span class="font-mono tabular-nums">{info.getValue<number>()}</span>,
  },
  {
    accessorKey: "insertedAt",
    header: "Received",
    cell: (info) => (
      <span class="text-xs text-text-dim">
        {new Date(info.getValue<string>()).toLocaleTimeString()}
      </span>
    ),
  },
];

const Blocks: Component = () => {
  const [blocks, { refetch }] = createResource(() => fetchRecentBlocks(50));
  const { data: liveBlock } = useSSE<BlockInfo | null>("/sse/blocks", null);

  setInterval(refetch, 5000);

  const tableData = () => {
    const base = blocks() ?? [];
    const live = liveBlock();
    if (live && base.length > 0 && live.slot !== base[0]?.slot) {
      return [live, ...base].slice(0, 50);
    }
    return base;
  };

  const table = createSolidTable({
    get data() { return tableData(); },
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Blocks</CardTitle>
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
          <Show when={!blocks.loading && (blocks()?.length ?? 0) === 0}>
            <div class="py-12 text-center text-text-dim">No blocks yet. Node may still be starting.</div>
          </Show>
        </div>
      </CardContent>
    </Card>
  );
};

export default Blocks;
