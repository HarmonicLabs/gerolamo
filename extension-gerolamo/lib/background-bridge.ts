// ---------------------------------------------------------------------------
// Background Bridge — SolidJS primitives for popup ↔ background service worker
// ---------------------------------------------------------------------------

import { createSignal, onMount, onCleanup } from "solid-js";

export type ConnectionState = "disconnected" | "connecting" | "synced" | "error";

export interface BlockInfo {
  hash: string;
  slot: number;
  height: number;
  epoch: number;
  epochSlot: number;
  size: number;
  txCount: number;
  fees: string;
  time: number;
  slotLeader: string;
}

export interface BackgroundState {
  state: ConnectionState;
  tipSlot: number;
  tipHeight: number;
  tipHash: string;
  epoch: number;
  blocksReceived: number;
  network: string;
  connectedSince: string | null;
  lastError: string | null;
}

const DEFAULT_STATE: BackgroundState = {
  state: "disconnected",
  tipSlot: 0,
  tipHeight: 0,
  tipHash: "",
  epoch: 0,
  blocksReceived: 0,
  network: "preprod",
  connectedSince: null,
  lastError: null,
};

function sendMessage<T = any>(msg: { type: string }): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

export function useBrowserNodeState() {
  const [bgState, setBgState] = createSignal<BackgroundState>(DEFAULT_STATE);

  onMount(() => {
    sendMessage<BackgroundState>({ type: "getState" }).then((s) => {
      if (s) setBgState(s);
    });
  });

  const listener = (msg: any) => {
    if (msg?.type === "state") {
      const { type: _, ...state } = msg;
      setBgState(state as BackgroundState);
    }
  };

  onMount(() => {
    chrome.runtime.onMessage.addListener(listener);
  });
  onCleanup(() => {
    chrome.runtime.onMessage.removeListener(listener);
  });

  const connect = async () => {
    const result = await sendMessage<BackgroundState & { error?: string }>({ type: "connect" });
    if (result && !result.error) setBgState(result);
    return result;
  };

  const disconnect = async () => {
    const result = await sendMessage<BackgroundState>({ type: "disconnect" });
    if (result) setBgState(result);
    return result;
  };

  return { bgState, connect, disconnect };
}

export function useNodeBlocks(refreshInterval = 5000) {
  const [blocks, setBlocks] = createSignal<BlockInfo[]>([]);

  const fetchBlocks = () => {
    sendMessage<BlockInfo[]>({ type: "getBlocks" }).then((b) => {
      if (Array.isArray(b)) setBlocks(b);
    });
  };

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    fetchBlocks();
    timer = setInterval(fetchBlocks, refreshInterval);
  });
  onCleanup(() => clearInterval(timer));

  return blocks;
}

export function useNodeLogs(refreshInterval = 3000) {
  const [logs, setLogs] = createSignal<string[]>([]);

  const fetchLogs = () => {
    sendMessage<string[]>({ type: "getLogs" }).then((l) => {
      if (Array.isArray(l)) setLogs(l);
    });
  };

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    fetchLogs();
    timer = setInterval(fetchLogs, refreshInterval);
  });
  onCleanup(() => clearInterval(timer));

  return logs;
}
