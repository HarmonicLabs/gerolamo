import { Show, createSignal, type Accessor, type Component } from "solid-js";
import type { NodeState } from "@/lib/browser-node";

interface Props {
  state: Accessor<NodeState>;
  tipSlot: Accessor<number>;
  blocksReceived: Accessor<number>;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const STATE_LABELS: Record<string, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: "text-text-muted" },
  connecting: { label: "Connecting to websockify...", color: "text-yellow-400" },
  handshaking: { label: "Ouroboros Handshake", color: "text-yellow-400" },
  syncing: { label: "ChainSync active", color: "text-blue-400" },
  synced: { label: "Synced to tip", color: "text-green-400" },
  error: { label: "Error", color: "text-red-400" },
};

const Node: Component<Props> = (props) => {
  const [connectError, setConnectError] = createSignal("");

  async function handleConnect() {
    setConnectError("");
    try {
      await props.connect();
    } catch (e: any) {
      setConnectError(e.message);
    }
  }

  const stateInfo = () => STATE_LABELS[props.state()] ?? STATE_LABELS.disconnected;

  return (
    <div class="flex flex-col gap-3 p-3">
      <div>
        <h1 class="text-[16px] font-bold text-text mb-0.5">Browser Node</h1>
        <p class="text-[11px] text-text-muted leading-relaxed">
          Ouroboros mini-protocols via{" "}
          <span class="text-accent font-semibold">websockify</span>.
          Consensus runs in the <span class="text-purple-400">background service worker</span>.
        </p>
      </div>

      {/* Connection card */}
      <div class="glass-card rounded-lg border border-border p-3">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <div
              class="h-2.5 w-2.5 rounded-full"
              classList={{
                "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.4)]": props.state() === "synced",
                "bg-yellow-400 animate-pulse": props.state() === "connecting" || props.state() === "handshaking" || props.state() === "syncing",
                "bg-red-400": props.state() === "error",
                "bg-text-muted": props.state() === "disconnected",
              }}
            />
            <span class={`text-[12px] font-semibold ${stateInfo().color}`}>
              {stateInfo().label}
            </span>
          </div>

          <Show
            when={props.state() === "disconnected" || props.state() === "error"}
            fallback={
              <button
                onClick={props.disconnect}
                class="px-3 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-medium hover:bg-red-500/20 transition-colors"
              >
                Disconnect
              </button>
            }
          >
            <button
              onClick={handleConnect}
              class="px-3 py-1.5 rounded-md bg-accent/10 border border-accent/30 text-accent text-[11px] font-medium hover:bg-accent/20 transition-colors"
            >
              Connect
            </button>
          </Show>
        </div>

        <Show when={connectError()}>
          <div class="mb-2 p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-[10px]">
            {connectError()}
          </div>
        </Show>

        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Tip Slot</div>
            <div class="text-[16px] font-mono font-bold text-text tabular-nums">
              {props.tipSlot() > 0 ? props.tipSlot().toLocaleString() : "\u2014"}
            </div>
          </div>
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Blocks Received</div>
            <div class="text-[16px] font-mono font-bold text-text tabular-nums">
              {props.blocksReceived() > 0 ? props.blocksReceived().toLocaleString() : "\u2014"}
            </div>
          </div>
        </div>
      </div>

      {/* Architecture */}
      <div class="glass-card rounded-lg border border-border p-3">
        <h2 class="text-[12px] font-semibold text-text mb-2">websockify pipeline</h2>
        <div class="flex items-center gap-1.5 text-[10px] font-mono text-text-muted flex-wrap">
          <span class="px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-400">Background SW</span>
          <span class="text-text-dim">&rarr;</span>
          <span class="px-1.5 py-0.5 rounded bg-accent/10 border border-accent/20 text-accent">WebSocket</span>
          <span class="text-text-dim">&rarr;</span>
          <span class="px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-400">websockify :3060</span>
          <span class="text-text-dim">&rarr;</span>
          <span class="px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-green-400">TCP :3001</span>
        </div>
        <div class="mt-2 text-[10px] text-text-muted leading-relaxed">
          Consensus runs persistently in the background service worker.
          Close the popup — sync continues. websockify (noVNC/websockify)
          bridges WS to Cardano relay TCP.
        </div>
      </div>
    </div>
  );
};

export default Node;
