import { createSignal, onMount, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyHash } from "@/components/CopyHash";
import { createWallet, loadWallet, saveWallet, deleteWallet, type WalletInfo } from "@/lib/wallet";
import { useUtxoLookup } from "@/lib/cardano-api";
import { formatLovelace } from "@/lib/format";
import { Key, Trash2, Eye, EyeOff, RefreshCw, Loader2 } from "lucide-solid";

export default function WalletPage() {
  const [wallet, setWallet] = createSignal<WalletInfo | null>(null);
  const [showKey, setShowKey] = createSignal(false);
  const [loading, setLoading] = createSignal(true);

  const address = () => wallet()?.address ?? "";
  const utxoQuery = useUtxoLookup(address);

  onMount(async () => {
    const w = await loadWallet();
    setWallet(w);
    setLoading(false);
  });

  const handleGenerate = async () => {
    const w = createWallet("preprod");
    await saveWallet(w);
    setWallet(w);
    toast.success("Wallet generated");
  };

  const handleDelete = async () => {
    await deleteWallet();
    setWallet(null);
    setShowKey(false);
    toast.success("Wallet deleted");
  };

  const totalLovelace = () => utxoQuery.data?.reduce((sum, u) => sum + Number(u.value), 0) ?? 0;

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <Loader2 size={20} class="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Show
        when={wallet()}
        fallback={
          <div class="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div class="h-16 w-16 rounded-full border-2 border-muted flex items-center justify-center">
              <Key size={24} class="text-muted-foreground" />
            </div>
            <div>
              <p class="text-sm font-medium">No Wallet</p>
              <p class="text-xs text-muted-foreground mt-1">Generate a new preprod wallet</p>
            </div>
            <Button onClick={handleGenerate}>
              <Key size={12} /> Generate Wallet
            </Button>
          </div>
        }
      >
        {(w) => (
          <div class="space-y-3">
            <div class="glass-panel rounded-lg p-3 border border-border">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Wallet</span>
                <Badge variant="outline" class="text-[9px] py-0 px-1.5">{w().network}</Badge>
              </div>

              <div class="space-y-2">
                <div>
                  <p class="text-[9px] text-muted-foreground mb-0.5">Address</p>
                  <div class="bg-muted/50 rounded p-1.5 break-all text-[9px] font-mono">{w().address}</div>
                  <CopyHash hash={w().address} chars={16} />
                </div>

                <div class="flex items-center justify-between">
                  <span class="text-[9px] text-muted-foreground">Balance</span>
                  <div class="flex items-center gap-1">
                    <span class="text-sm font-bold neon-text-cyan">
                      {totalLovelace() > 0 ? formatLovelace(totalLovelace()) : "—"}
                    </span>
                    <button onClick={() => utxoQuery.refetch()} class="text-muted-foreground hover:text-secondary">
                      <Show when={utxoQuery.isLoading} fallback={<RefreshCw size={12} />}>
                        <Loader2 size={12} class="animate-spin" />
                      </Show>
                    </button>
                  </div>
                </div>

                <Show when={utxoQuery.data && utxoQuery.data.length > 0}>
                  <div class="flex items-center justify-between">
                    <span class="text-[9px] text-muted-foreground">UTxOs</span>
                    <span class="text-[9px]">{utxoQuery.data!.length}</span>
                  </div>
                </Show>

                <div>
                  <div class="flex items-center justify-between mb-0.5">
                    <span class="text-[9px] text-muted-foreground">Private Key</span>
                    <button onClick={() => setShowKey(!showKey())} class="text-muted-foreground hover:text-foreground">
                      <Show when={showKey()} fallback={<Eye size={12} />}><EyeOff size={12} /></Show>
                    </button>
                  </div>
                  <Show when={showKey()}>
                    <div class="bg-destructive/10 border border-destructive/30 rounded p-1.5 break-all text-[8px] font-mono text-destructive">
                      {w().xprvHex}
                    </div>
                  </Show>
                </div>

                <div class="flex items-center justify-between text-[9px]">
                  <span class="text-muted-foreground">Created</span>
                  <span>{new Date(w().createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>

            <Button variant="destructive" size="sm" class="w-full" onClick={handleDelete}>
              <Trash2 size={12} /> Delete Wallet
            </Button>

            <p class="text-[8px] text-muted-foreground text-center">
              Preprod faucet: testnets.cardano.org/en/testnets/cardano/tools/faucet
            </p>
          </div>
        )}
      </Show>
    </Show>
  );
}
