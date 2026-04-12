import { useState } from "react";
import { useBlocks, useSSE, type Block } from "@/lib/api";
import { CopyHash } from "@/components/CopyHash";
import { formatNumber } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const eraNames: Record<number, string> = { 1: "Byron", 2: "Shelley", 3: "Allegra", 4: "Mary", 5: "Alonzo", 6: "Babbage", 7: "Conway" };

export default function BlocksPage() {
  const { data: blocks = [], isLoading } = useBlocks(100);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [expandedSlot, setExpandedSlot] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const perPage = 15;

  useSSE<Block>("blocks", () => qc.invalidateQueries({ queryKey: ["blocks"] }));

  const filtered = search
    ? blocks.filter((b) => b.slot.toString().includes(search) || b.hash.includes(search))
    : blocks;

  const paged = filtered.slice(page * perPage, (page + 1) * perPage);

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading blocks...</div>;
  }

  return (
    <div className="space-y-4 animate-fade-in-up">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold neon-text-red">Blocks</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8 w-60 bg-muted/30 border-border"
              placeholder="Search slot or hash..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
          <Button variant="outline" size="sm" className="border-border neon-text-cyan border-secondary/30" onClick={() => qc.invalidateQueries({ queryKey: ["blocks"] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="glass-panel rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground uppercase">
              <th className="text-left p-3">Slot</th>
              <th className="text-left p-3">Hash</th>
              <th className="text-left p-3">Era</th>
              <th className="text-right p-3">Txs</th>
              <th className="text-right p-3">Size</th>
              <th className="p-3 w-8" />
            </tr>
          </thead>
          <tbody>
            {paged.map((block) => (
              <Fragment key={block.slot}>
                <tr
                  className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => setExpandedSlot(expandedSlot === block.slot ? null : block.slot)}
                >
                  <td className="p-3 neon-text-cyan font-mono">{formatNumber(block.slot)}</td>
                  <td className="p-3"><CopyHash hash={block.hash} /></td>
                  <td className="p-3 text-muted-foreground">{eraNames[block.era] ?? block.era}</td>
                  <td className="p-3 text-right">{block.txCount}</td>
                  <td className="p-3 text-right text-muted-foreground">{(block.size / 1024).toFixed(1)} KB</td>
                  <td className="p-3">
                    {expandedSlot === block.slot ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </td>
                </tr>
                {expandedSlot === block.slot && (
                  <tr>
                    <td colSpan={6} className="p-4 bg-muted/20">
                      <div className="text-xs space-y-1">
                        <p><span className="text-muted-foreground">Previous Hash:</span> <CopyHash hash={block.prevHash} /></p>
                        <p><span className="text-muted-foreground">Epoch:</span> {block.epoch}</p>
                        <p><span className="text-muted-foreground">Inserted At:</span> {new Date(block.insertedAt).toLocaleString()}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {paged.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No blocks found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Showing {filtered.length > 0 ? page * perPage + 1 : 0}-{Math.min((page + 1) * perPage, filtered.length)} of {filtered.length}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button>
          <Button variant="outline" size="sm" disabled={(page + 1) * perPage >= filtered.length} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}

import { Fragment } from "react";
