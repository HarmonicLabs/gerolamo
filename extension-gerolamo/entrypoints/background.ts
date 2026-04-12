// ---------------------------------------------------------------------------
// Background Service Worker — polls Koios API for chain data.
// Standalone mode: no API keys, no external node connection required.
// The popup reads state from this worker via chrome.runtime messaging.
// ---------------------------------------------------------------------------

import type { ConnectionState, BackgroundState, BlockInfo } from "@/lib/background-bridge";

export type BackgroundMessage =
  | { type: "getState" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "getLogs" }
  | { type: "getBlocks" };

const ENDPOINTS: Record<string, string> = {
  preprod: "https://preprod.koios.rest/api/v1",
  mainnet: "https://api.koios.rest/api/v1",
};

export default defineBackground(() => {
  let currentState: ConnectionState = "disconnected";
  let tipSlot = 0;
  let tipHeight = 0;
  let tipHash = "";
  let epoch = 0;
  let blocksReceived = 0;
  let connectedSince: string | null = null;
  let lastError: string | null = null;
  let networkName = "preprod";
  let apiEndpoint = ENDPOINTS.preprod;
  let refreshInterval = 10000;
  let autoConnect = true;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const recentBlocks: BlockInfo[] = [];
  const logs: string[] = [];
  const MAX_BLOCKS = 100;
  const MAX_LOGS = 500;

  function log(msg: string) {
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  }

  async function loadPrefs() {
    try {
      const data = await chrome.storage.local.get("gerolamo-settings");
      const raw = data["gerolamo-settings"];
      if (raw) {
        const settings = JSON.parse(raw);
        networkName = settings.network || "preprod";
        apiEndpoint = settings.apiEndpoint || ENDPOINTS[networkName] || ENDPOINTS.preprod;
        refreshInterval = settings.refreshInterval ?? 10000;
        autoConnect = settings.autoConnect ?? true;
      }
    } catch { /* storage unavailable */ }
  }

  async function koiosGet<T>(path: string): Promise<T> {
    const url = `${apiEndpoint}${path}`;
    log(`GET ${path}`);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Koios ${res.status}: ${body}`);
    }
    return res.json();
  }

  function toBlockInfo(b: any): BlockInfo {
    return {
      hash: b.hash,
      slot: b.abs_slot ?? b.slot ?? 0,
      height: b.block_height ?? b.block_no ?? 0,
      epoch: b.epoch_no ?? 0,
      epochSlot: b.epoch_slot ?? 0,
      size: b.block_size ?? 0,
      txCount: b.tx_count ?? 0,
      fees: "0",
      time: b.block_time ?? 0,
      slotLeader: b.pool ?? "",
    };
  }

  async function poll() {
    try {
      // Fetch tip
      const tips = await koiosGet<any[]>("/tip");
      const tip = tips[0];
      if (!tip) throw new Error("No tip returned");

      const newHash = tip.hash;
      if (newHash !== tipHash) {
        tipSlot = tip.abs_slot;
        tipHeight = tip.block_no;
        tipHash = newHash;
        epoch = tip.epoch_no;
        blocksReceived++;
        log(`New tip: slot ${tipSlot}, height ${tipHeight}, epoch ${epoch}`);
      }

      // Fetch recent blocks if buffer is low
      if (recentBlocks.length < 10 || recentBlocks[0]?.hash !== tipHash) {
        try {
          const blocks = await koiosGet<any[]>("/blocks?limit=15&offset=0");
          // Replace buffer with fresh data
          recentBlocks.length = 0;
          for (const b of blocks) {
            recentBlocks.push(toBlockInfo(b));
          }
        } catch (err: unknown) {
          log(`Block fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (currentState !== "synced") {
        currentState = "synced";
        if (!connectedSince) connectedSince = new Date().toISOString();
        lastError = null;
      }
      broadcastState();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Poll error: ${message}`);
      lastError = message;
      if (currentState !== "error") {
        currentState = "error";
        broadcastState();
      }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    currentState = "connecting";
    lastError = null;
    broadcastState();
    log(`Starting Koios polling (${networkName})...`);

    poll();
    pollTimer = setInterval(poll, refreshInterval);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentState = "disconnected";
    connectedSince = null;
    lastError = null;
    autoConnect = false;

    try {
      chrome.storage.local.get("gerolamo-settings").then((data) => {
        const raw = data["gerolamo-settings"];
        const settings = raw ? JSON.parse(raw) : {};
        settings.autoConnect = false;
        chrome.storage.local.set({ "gerolamo-settings": JSON.stringify(settings) });
      });
    } catch { /* ignore */ }

    log("Polling stopped");
    broadcastState();
  }

  async function connectNode() {
    if (pollTimer) return;
    await loadPrefs();
    startPolling();

    autoConnect = true;
    try {
      const data = await chrome.storage.local.get("gerolamo-settings");
      const raw = data["gerolamo-settings"];
      const settings = raw ? JSON.parse(raw) : {};
      settings.autoConnect = true;
      await chrome.storage.local.set({ "gerolamo-settings": JSON.stringify(settings) });
    } catch { /* ignore */ }
  }

  function getState(): BackgroundState {
    return {
      state: currentState,
      tipSlot,
      tipHeight,
      tipHash,
      epoch,
      blocksReceived,
      network: networkName,
      connectedSince,
      lastError,
    };
  }

  function broadcastState() {
    chrome.runtime.sendMessage({ type: "state", ...getState() }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg: BackgroundMessage, _sender, sendResponse) => {
    if (msg.type === "getState") {
      sendResponse(getState());
      return true;
    }
    if (msg.type === "connect") {
      connectNode()
        .then(() => sendResponse(getState()))
        .catch((e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
      return true;
    }
    if (msg.type === "disconnect") {
      stopPolling();
      sendResponse(getState());
      return true;
    }
    if (msg.type === "getLogs") {
      sendResponse([...logs]);
      return true;
    }
    if (msg.type === "getBlocks") {
      sendResponse([...recentBlocks]);
      return true;
    }
  });

  console.log("[bg] Gerolamino background service worker started (standalone/Koios)");
  log("Service worker started");
  loadPrefs().then(() => {
    if (autoConnect) {
      log("Auto-connecting...");
      startPolling();
    }
  });
});
