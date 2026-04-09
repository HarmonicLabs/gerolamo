// ---------------------------------------------------------------------------
// Bridge between popup UI and background service worker
// The background worker runs the actual websockify/Ouroboros connection.
// The popup just reads state and sends commands via chrome.runtime messaging.
// ---------------------------------------------------------------------------

import { createSignal, onMount, onCleanup } from "solid-js";
import type { NodeState } from "./browser-node";

export interface BackgroundState {
  state: NodeState;
  tipSlot: number;
  blocksReceived: number;
}

export function useBackgroundNode() {
  const [state, setState] = createSignal<NodeState>("disconnected");
  const [tipSlot, setTipSlot] = createSignal(0);
  const [blocksReceived, setBlocksReceived] = createSignal(0);

  function handleMessage(msg: any) {
    if (msg.type === "state") {
      setState(msg.state);
      setTipSlot(msg.tipSlot);
      setBlocksReceived(msg.blocksReceived);
    }
  }

  onMount(() => {
    // Get initial state from background
    chrome.runtime.sendMessage({ type: "getState" }, (resp) => {
      if (resp) {
        setState(resp.state);
        setTipSlot(resp.tipSlot);
        setBlocksReceived(resp.blocksReceived);
      }
    });

    // Listen for state updates from background
    chrome.runtime.onMessage.addListener(handleMessage);
  });

  onCleanup(() => {
    chrome.runtime.onMessage.removeListener(handleMessage);
  });

  async function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "connect" }, (resp) => {
        if (resp?.error) reject(new Error(resp.error));
        else {
          if (resp) {
            setState(resp.state);
            setTipSlot(resp.tipSlot);
            setBlocksReceived(resp.blocksReceived);
          }
          resolve();
        }
      });
    });
  }

  function disconnect() {
    chrome.runtime.sendMessage({ type: "disconnect" }, (resp) => {
      if (resp) {
        setState(resp.state);
        setTipSlot(resp.tipSlot);
        setBlocksReceived(resp.blocksReceived);
      }
    });
  }

  return { state, tipSlot, blocksReceived, connect, disconnect };
}
