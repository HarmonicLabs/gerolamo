// ---------------------------------------------------------------------------
// Background Service Worker — runs Ouroboros consensus persistently
// Connects to Cardano relay via websockify WSS↔TCP proxy.
// The popup reads state from this worker via chrome.runtime messaging.
// ---------------------------------------------------------------------------

import { BrowserNode, type NodeState } from "@/lib/browser-node";

export default defineBackground(() => {
  const WEBSOCKIFY_URL = "ws://localhost:3060";
  const PREPROD_MAGIC = 1;

  let node: BrowserNode | null = null;
  let currentState: NodeState = "disconnected";
  let tipSlot = 0;
  let blocksReceived = 0;
  let autoConnect = false;

  async function loadPrefs() {
    try {
      const data = await chrome.storage.local.get(["autoConnect"]);
      autoConnect = data.autoConnect ?? false;
    } catch {}
  }

  async function savePrefs() {
    try {
      await chrome.storage.local.set({ autoConnect });
    } catch {}
  }

  function createNode(): BrowserNode {
    const n = new BrowserNode();

    n.on("stateChange", (state) => {
      currentState = state;
      broadcastState();
    });

    n.on("rollForward", (_cbor, tip) => {
      tipSlot = Number(tip);
      blocksReceived++;
      broadcastState();
    });

    n.on("error", (err) => {
      console.error("[bg] Node error:", err.message);
    });

    return n;
  }

  async function connectNode() {
    if (node && currentState !== "disconnected" && currentState !== "error") return;

    node = createNode();
    try {
      await node.connect({ websockifyUrl: WEBSOCKIFY_URL, networkMagic: PREPROD_MAGIC });
      await node.startChainSync();
      autoConnect = true;
      savePrefs();
    } catch (err: any) {
      console.error("[bg] Connect failed:", err.message);
    }
  }

  function disconnectNode() {
    node?.disconnect();
    node = null;
    currentState = "disconnected";
    autoConnect = false;
    savePrefs();
    broadcastState();
  }

  function getState() {
    return { state: currentState, tipSlot, blocksReceived };
  }

  function broadcastState() {
    chrome.runtime.sendMessage({ type: "state", ...getState() }).catch(() => {
      // popup not open — that's fine
    });
  }

  // Handle messages from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getState") {
      sendResponse(getState());
      return true;
    }
    if (msg.type === "connect") {
      connectNode()
        .then(() => sendResponse(getState()))
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    if (msg.type === "disconnect") {
      disconnectNode();
      sendResponse(getState());
      return true;
    }
  });

  console.log("[bg] Gerolamo background service worker started");
  loadPrefs().then(() => {
    if (autoConnect) connectNode();
  });
});
