import { createSignal, Show, For, onMount, type Component } from "solid-js";
import {
  createWallet,
  loadWallet,
  saveWallet,
  deleteWallet,
  queryWalletUtxos,
  type WalletInfo,
  type WalletUtxo,
} from "@/lib/wallet";
import { getApiBase, initSettings } from "@/lib/settings";

const Wallet: Component = () => {
  const [wallet, setWallet] = createSignal<WalletInfo | null>(null);
  const [utxos, setUtxos] = createSignal<WalletUtxo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [showKey, setShowKey] = createSignal(false);
  const [copied, setCopied] = createSignal("");

  onMount(async () => {
    await initSettings();
    const stored = loadWallet();
    if (stored) {
      setWallet(stored);
      refreshUtxos(stored.address);
    }
  });

  function handleGenerate() {
    const w = createWallet("preprod");
    saveWallet(w);
    setWallet(w);
    setUtxos([]);
  }

  function handleDelete() {
    deleteWallet();
    setWallet(null);
    setUtxos([]);
    setShowKey(false);
  }

  async function refreshUtxos(address: string) {
    setLoading(true);
    try {
      const apiBase = getApiBase();
      const result = await queryWalletUtxos(apiBase, address);
      setUtxos(result);
    } catch {}
    setLoading(false);
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  }

  const balance = () => {
    const total = utxos().reduce((acc, u) => acc + BigInt(u.amount || "0"), 0n);
    return (Number(total) / 1_000_000).toFixed(6);
  };

  return (
    <div class="flex flex-col gap-3 p-3">
      <div>
        <h1 class="text-[16px] font-bold text-text mb-0.5">Wallet</h1>
        <p class="text-[11px] text-text-muted leading-relaxed">
          Generate keys, derive addresses, query UTxOs — all in the browser.
        </p>
      </div>

      <Show
        when={wallet()}
        fallback={
          <div class="glass-card rounded-lg border border-border p-4 flex flex-col items-center gap-3">
            <div class="text-[12px] text-text-muted text-center">
              No wallet found. Generate a new preprod wallet.
            </div>
            <button
              onClick={handleGenerate}
              class="px-4 py-2 rounded-md bg-accent/10 border border-accent/30 text-accent text-[12px] font-semibold hover:bg-accent/20 transition-colors"
            >
              Generate Wallet
            </button>
          </div>
        }
      >
        {(w) => (
          <>
            {/* Address card */}
            <div class="glass-card rounded-lg border border-border p-3">
              <div class="flex items-center justify-between mb-2">
                <h2 class="text-[12px] font-semibold text-text">Address</h2>
                <div class="flex gap-1.5">
                  <button
                    onClick={() => refreshUtxos(w().address)}
                    class="px-2 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent text-[9px] font-medium hover:bg-accent/20 transition-colors"
                  >
                    {loading() ? "..." : "Refresh"}
                  </button>
                  <button
                    onClick={handleDelete}
                    class="px-2 py-1 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-[9px] font-medium hover:bg-red-500/20 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <button
                onClick={() => copyToClipboard(w().address, "address")}
                class="w-full text-left p-2 rounded-md bg-bg-raised/50 border border-border-subtle hover:border-accent/20 transition-colors group"
              >
                <div class="flex items-center justify-between">
                  <span class="font-mono text-[10px] text-text break-all leading-relaxed">
                    {w().address}
                  </span>
                  <span class="shrink-0 ml-2 text-[9px] text-text-muted group-hover:text-accent transition-colors">
                    {copied() === "address" ? "Copied" : "Copy"}
                  </span>
                </div>
              </button>

              <div class="mt-2 flex items-center gap-3 text-[10px]">
                <span class="text-text-muted">Network:</span>
                <span class="font-mono text-accent">{w().network}</span>
                <span class="text-text-muted">Created:</span>
                <span class="font-mono text-text-dim">{new Date(w().createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Private key */}
            <div class="glass-card rounded-lg border border-border p-3">
              <div class="flex items-center justify-between mb-2">
                <h2 class="text-[12px] font-semibold text-text">Private Key</h2>
                <button
                  onClick={() => setShowKey(!showKey())}
                  class="px-2 py-1 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-[9px] font-medium hover:bg-yellow-500/20 transition-colors"
                >
                  {showKey() ? "Hide" : "Reveal"}
                </button>
              </div>
              <Show
                when={showKey()}
                fallback={
                  <div class="p-2 rounded-md bg-bg-raised/50 border border-border-subtle text-[10px] text-text-muted">
                    Hidden for security. Click Reveal to show.
                  </div>
                }
              >
                <button
                  onClick={() => copyToClipboard(w().xprvHex, "key")}
                  class="w-full text-left p-2 rounded-md bg-red-500/5 border border-red-500/20 hover:border-red-500/30 transition-colors group"
                >
                  <div class="flex items-center justify-between">
                    <span class="font-mono text-[9px] text-red-300 break-all leading-relaxed">
                      {w().xprvHex}
                    </span>
                    <span class="shrink-0 ml-2 text-[9px] text-text-muted group-hover:text-red-400 transition-colors">
                      {copied() === "key" ? "Copied" : "Copy"}
                    </span>
                  </div>
                </button>
              </Show>
            </div>

            {/* Balance & UTxOs */}
            <div class="glass-card rounded-lg border border-border p-3">
              <div class="flex items-center justify-between mb-2">
                <h2 class="text-[12px] font-semibold text-text">Balance & UTxOs</h2>
                <div class="text-[14px] font-mono font-bold text-accent tabular-nums">
                  {balance()} ADA
                </div>
              </div>

              <Show
                when={utxos().length > 0}
                fallback={
                  <div class="p-2 rounded-md bg-bg-raised/50 border border-border-subtle text-[10px] text-text-muted text-center">
                    {loading() ? "Querying UTxOs..." : "No UTxOs found. Fund via preprod faucet."}
                  </div>
                }
              >
                <div class="space-y-1.5 max-h-[180px] overflow-y-auto">
                  <For each={utxos()}>
                    {(utxo) => (
                      <div class="p-2 rounded-md bg-bg-raised/50 border border-border-subtle">
                        <div class="flex items-center justify-between">
                          <span class="font-mono text-[9px] text-text truncate max-w-[65%]">
                            {utxo.ref}
                          </span>
                          <span class="font-mono text-[9px] text-accent tabular-nums">
                            {(Number(BigInt(utxo.amount || "0")) / 1_000_000).toFixed(2)} ADA
                          </span>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default Wallet;
