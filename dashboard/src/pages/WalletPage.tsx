import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/StatCard";
import { CopyHash } from "@/components/CopyHash";
import { useChainState } from "@/lib/api";
import { formatNumber, formatLovelace } from "@/lib/format";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { submitTransaction } from "@/lib/api";

export default function WalletPage() {
  const { data: chainState } = useChainState();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [cborHex, setCborHex] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!cborHex.trim()) return;
    setSubmitting(true);
    try {
      const result = await submitTransaction(cborHex.trim());
      if (result.ok) {
        toast.success("Transaction submitted");
        setCborHex("");
      } else {
        toast.error(`Failed: ${result.message}`);
      }
    } catch (e: any) {
      toast.error(`Error: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Wallet</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <StatCard label="Stake Accounts" value={formatNumber(chainState?.stakeCount ?? 0)} accent="cyan" />
        <StatCard label="Delegations" value={formatNumber(chainState?.delegationCount ?? 0)} accent="cyan" />
        <StatCard label="Pools" value={formatNumber(chainState?.poolCount ?? 0)} accent="cyan" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Chain Account State</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Treasury</span>
              <span className="neon-text-cyan">{formatLovelace(chainState?.treasury ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reserves</span>
              <span className="neon-text-cyan">{formatLovelace(chainState?.reserves ?? 0)}</span>
            </div>
          </div>
        </div>

        <div className="glass-panel rounded-lg p-4">
          <h3 className="text-sm text-muted-foreground mb-3">Network Participation</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active Pools</span>
              <span className="neon-text-cyan">{formatNumber(chainState?.poolCount ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Stake Accounts</span>
              <span className="neon-text-cyan">{formatNumber(chainState?.stakeCount ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active Delegations</span>
              <span className="neon-text-cyan">{formatNumber(chainState?.delegationCount ?? 0)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tx Submission */}
      <div className="glass-panel rounded-lg p-4 space-y-4">
        <h3 className="text-sm text-muted-foreground">Submit Signed Transaction (CBOR Hex)</h3>
        <textarea
          className="w-full bg-muted/30 border border-border rounded p-3 font-mono text-xs min-h-[120px] text-foreground resize-y"
          placeholder="Paste signed transaction CBOR hex..."
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
