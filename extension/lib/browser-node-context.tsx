// ---------------------------------------------------------------------------
// SolidJS context for the browser-embedded Cardano node
// Connects via websockify (noVNC/websockify) WSS<->TCP proxy
// ---------------------------------------------------------------------------

import { createContext, createSignal, useContext, onCleanup, type ParentComponent } from "solid-js";
import { BrowserNode, type NodeState, type BrowserNodeConfig } from "./browser-node";

// websockify default port — configurable via storage
const DEFAULT_WEBSOCKIFY_URL = "ws://localhost:3060";

interface BrowserNodeContextValue {
  state: () => NodeState;
  tipSlot: () => number;
  blocksReceived: () => number;
  connect: () => Promise<void>;
  disconnect: () => void;
  node: BrowserNode;
}

const BrowserNodeContext = createContext<BrowserNodeContextValue>();

const PREPROD_MAGIC = 1;

export const BrowserNodeProvider: ParentComponent = (props) => {
  const node = new BrowserNode();
  const [state, setState] = createSignal<NodeState>("disconnected");
  const [tipSlot, setTipSlot] = createSignal(0);
  const [blocksReceived, setBlocksReceived] = createSignal(0);

  node.on("stateChange", setState);
  node.on("rollForward", (_cbor, tip) => {
    setTipSlot(Number(tip));
    setBlocksReceived((c) => c + 1);
  });

  async function connect() {
    const websockifyUrl = DEFAULT_WEBSOCKIFY_URL;

    const config: BrowserNodeConfig = {
      websockifyUrl,
      networkMagic: PREPROD_MAGIC,
    };

    await node.connect(config);
    await node.startChainSync();
  }

  function disconnect() {
    node.disconnect();
  }

  onCleanup(() => node.disconnect());

  const value: BrowserNodeContextValue = {
    state,
    tipSlot,
    blocksReceived,
    connect,
    disconnect,
    node,
  };

  return (
    <BrowserNodeContext.Provider value={value}>
      {props.children}
    </BrowserNodeContext.Provider>
  );
};

export function useBrowserNode(): BrowserNodeContextValue {
  const ctx = useContext(BrowserNodeContext);
  if (!ctx) throw new Error("useBrowserNode must be used within BrowserNodeProvider");
  return ctx;
}
