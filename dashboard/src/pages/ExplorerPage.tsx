import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyHash } from "@/components/CopyHash";
import { useUtxoLookup, submitTransaction, type UtxoResult } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Search, Send } from "lucide-react";
import { toast } from "sonner";

export default function ExplorerPage() {
  const [utxoQuery, setUtxoQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [cborHex, setCborHex] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: utxoResults, isLoading: utxoLoading } = useUtxoLookup(activeQuery);

  const handleLookup = () => {
    if (!utxoQuery.trim()) return;
    setActiveQuery(utxoQuery.trim());
  };

  const handleSubmit = async () => {
    if (!cborHex.trim()) return;
    setSubmitting(true);
    try {
      const result = await submitTransaction(cborHex.trim());
      if (result.ok) {
        toast.success("Transaction relayed successfully");
        setCborHex("");
      } else {
        toast.error(`Submission failed: ${result.message}`);
      }
    } catch (e: unknown) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Explorer</h1>

      {/* UTxO Lookup */}
      <div className="glass-panel rounded-lg p-4 space-y-4">
        <h3 className="text-sm text-muted-foreground">UTxO Lookup</h3>
        <div className="flex gap-2">
          <Input
            className="bg-muted/30 border-border flex-1"
            placeholder="Enter tx hash or utxo ref (hash:index)..."
            value={utxoQuery}
            onChange={(e) => setUtxoQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <Button variant="outline" className="border-primary/30 hover:border-primary" onClick={handleLookup}>
            <Search className="h-4 w-4" />
          </Button>
        </div>

        {utxoLoading && <p className="text-xs text-muted-foreground">Searching...</p>}

        {utxoResults && utxoResults.length > 0 && (
          <div className="space-y-3">
            {utxoResults.map((utxo, i) => (
              <div key={i} className="space-y-2 text-sm animate-fade-in-up border-b border-border/30 pb-3 last:border-0">
                <div className="flex justify-between"><span className="text-muted-foreground">UTxO Ref</span><CopyHash hash={utxo.ref} chars={12} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Address</span><CopyHash hash={utxo.address} chars={16} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="neon-text-cyan">{utxo.amount} lovelace</span></div>
                {utxo.assets && Object.keys(utxo.assets).length > 0 && (
                  <div>
                    <p className="text-muted-foreground mb-1">Assets:</p>
                    {Object.entries(utxo.assets).map(([key, val]) => (
                      <div key={key} className="flex justify-between text-xs ml-4">
                        <CopyHash hash={key} chars={10} />
                        <span className="neon-text-cyan">{String(val)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {utxoResults && utxoResults.length === 0 && activeQuery && (
          <p className="text-xs text-muted-foreground">No UTxOs found for this query.</p>
        )}
      </div>

      {/* Tx Submission */}
      <div className="glass-panel rounded-lg p-4 space-y-4">
        <h3 className="text-sm text-muted-foreground">Transaction Submission</h3>
        <Textarea
          className="bg-muted/30 border-border font-mono text-xs min-h-[120px]"
          placeholder="Paste CBOR hex..."
          value={cborHex}
          onChange={(e) => setCborHex(e.target.value)}
        />
        <Button variant="outline" className="border-primary/30 hover:border-primary" onClick={handleSubmit} disabled={!cborHex.trim() || submitting}>
          <Send className="h-4 w-4 mr-2" /> {submitting ? "Submitting..." : "Submit Transaction"}
        </Button>
      </div>
    </div>
  );
}
