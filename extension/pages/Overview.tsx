import { Show, type Accessor, type Component } from "solid-js";
import type { NodeState } from "@/lib/browser-node";

interface Props {
  state: Accessor<NodeState>;
  tipSlot: Accessor<number>;
  blocksReceived: Accessor<number>;
}

const ERA_NAMES: Record<number, string> = {
  0: "Byron", 1: "Shelley", 2: "Allegra", 3: "Mary",
  4: "Alonzo", 5: "Babbage", 6: "Conway",
};

const Overview: Component<Props> = (props) => {
  const isConnected = () => props.state() === "syncing" || props.state() === "synced";

  return (
    <div class="flex flex-col gap-3 p-3">
      <h1 class="text-[16px] font-bold text-text">Overview</h1>

      {/* Browser node status — running in background service worker */}
      <div class="glass-card rounded-lg border border-border p-3">
        <div class="flex items-center gap-2 mb-2">
          <div
            class="h-2.5 w-2.5 rounded-full"
            classList={{
              "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.4)]": isConnected(),
              "bg-yellow-400 animate-pulse": props.state() === "connecting" || props.state() === "handshaking",
              "bg-red-400": props.state() === "error",
              "bg-text-muted": props.state() === "disconnected",
            }}
          />
          <span class="text-[12px] font-semibold text-text">
            Browser Node: {isConnected() ? "Connected" : props.state()}
          </span>
          <Show when={isConnected()}>
            <span class="text-[9px] font-mono text-text-dim ml-auto">(background)</span>
          </Show>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Tip Slot</div>
            <div class="text-[16px] font-mono font-bold text-accent tabular-nums">
              {props.tipSlot() > 0 ? props.tipSlot().toLocaleString() : "\u2014"}
            </div>
          </div>
          <div class="rounded-md bg-bg-raised/50 border border-border-subtle p-2">
            <div class="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">Blocks Rx</div>
            <div class="text-[16px] font-mono font-bold text-text tabular-nums">
              {props.blocksReceived() > 0 ? props.blocksReceived().toLocaleString() : "\u2014"}
            </div>
          </div>
        </div>
      </div>

      {/* Network info */}
      <div class="glass-card rounded-lg border border-border p-3">
        <h2 class="text-[12px] font-semibold text-text mb-2">Network</h2>
        <div class="grid grid-cols-2 gap-2 text-[10px]">
          <div class="flex justify-between">
            <span class="text-text-muted">Network</span>
            <span class="font-mono text-accent">preprod</span>
          </div>
          <div class="flex justify-between">
            <span class="text-text-muted">Magic</span>
            <span class="font-mono text-text">1</span>
          </div>
          <div class="flex justify-between">
            <span class="text-text-muted">Protocol</span>
            <span class="font-mono text-text">Ouroboros Praos</span>
          </div>
          <div class="flex justify-between">
            <span class="text-text-muted">Era</span>
            <span class="font-mono text-text">Conway</span>
          </div>
        </div>
      </div>

      {/* websockify info */}
      <div class="glass-card rounded-lg border border-border p-2">
        <div class="flex items-center gap-2 text-[10px] text-text-muted flex-wrap">
          <span>Proxy:</span>
          <span class="font-mono text-purple-400">websockify :3060</span>
          <span>|</span>
          <span>Relay:</span>
          <span class="font-mono text-green-400">preprod-node:3001</span>
        </div>
      </div>
    </div>
  );
};

export default Overview;
