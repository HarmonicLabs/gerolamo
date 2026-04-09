// ---------------------------------------------------------------------------
// Browser Node — runs Ouroboros mini-protocols directly in the browser
// via websockify (noVNC/websockify) WSS<->TCP proxy.
//
// Architecture:
//   Browser WebSocket -> websockify (port 3060) -> TCP -> Cardano relay (port 3001)
//
// The Multiplexer in @harmoniclabs/ouroboros-miniprotocols-ts natively supports
// WebSocketLike. websockify sends raw binary frames bidirectionally, so the
// full Ouroboros protocol stack works transparently.
// ---------------------------------------------------------------------------

import {
  Multiplexer,
  HandshakeClient,
  HandshakeAcceptVersion,
  ChainSyncClient,
  BlockFetchClient,
  KeepAliveClient,
  type ChainSyncRollForward,
  type ChainSyncRollBackwards,
  type BlockFetchBlock,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserNodeConfig {
  /** websockify URL, e.g. "ws://localhost:3060" */
  websockifyUrl: string;
  /** Cardano network magic (1 = preprod, 764824073 = mainnet) */
  networkMagic: number;
}

export type NodeState = "disconnected" | "connecting" | "handshaking" | "syncing" | "synced" | "error";

export interface BrowserNodeEvents {
  stateChange: (state: NodeState) => void;
  rollForward: (cborBytes: Uint8Array, tipSlot: number | bigint) => void;
  rollBackward: (pointSlot: number | bigint) => void;
  block: (block: BlockFetchBlock) => void;
  error: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// BrowserNode — connects to Cardano via websockify WSS<->TCP proxy
// ---------------------------------------------------------------------------

export class BrowserNode {
  private ws: WebSocket | null = null;
  private mplexer: Multiplexer | null = null;
  private chainSync: ChainSyncClient | null = null;
  private blockFetch: BlockFetchClient | null = null;
  private keepAlive: KeepAliveClient | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private cookieCounter = 0;
  private _state: NodeState = "disconnected";
  private listeners: Partial<{ [K in keyof BrowserNodeEvents]: Set<BrowserNodeEvents[K]> }> = {};

  get state(): NodeState { return this._state; }

  on<K extends keyof BrowserNodeEvents>(event: K, listener: BrowserNodeEvents[K]) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    (this.listeners[event] as Set<BrowserNodeEvents[K]>).add(listener);
  }

  off<K extends keyof BrowserNodeEvents>(event: K, listener: BrowserNodeEvents[K]) {
    (this.listeners[event] as Set<BrowserNodeEvents[K]> | undefined)?.delete(listener);
  }

  private emit<K extends keyof BrowserNodeEvents>(event: K, ...args: Parameters<BrowserNodeEvents[K]>) {
    const set = this.listeners[event] as Set<(...a: any[]) => void> | undefined;
    if (set) for (const fn of set) fn(...args);
  }

  private setState(s: NodeState) {
    this._state = s;
    this.emit("stateChange", s);
  }

  /**
   * Connect to a Cardano relay via websockify WSS<->TCP proxy.
   *
   * websockify must be running:
   *   websockify 3060 preprod-node.play.dev.cardano.org:3001
   *
   * The browser opens a WebSocket to websockify, which pipes raw binary
   * bytes to the TCP Cardano relay. The Multiplexer handles all Ouroboros
   * framing natively over the WebSocket.
   */
  async connect(config: BrowserNodeConfig): Promise<void> {
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      // Connect to websockify -- it uses 'binary' subprotocol by default
      const ws = new WebSocket(config.websockifyUrl, ["binary"]);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = async () => {
        try {
          console.log("[browser-node] Connected to websockify WSS<->TCP proxy");

          // Create Multiplexer -- it detects WebSocketLike and wraps accordingly
          this.mplexer = new Multiplexer({
            connect: () => ws as any,
            protocolType: "node-to-node",
          });

          this.mplexer.on("error", (err: Error) => {
            console.error("[browser-node] Multiplexer error:", err);
            this.emit("error", err);
            this.setState("error");
          });

          // Init mini-protocol clients
          this.chainSync = new ChainSyncClient(this.mplexer);
          this.blockFetch = new BlockFetchClient(this.mplexer);
          this.keepAlive = new KeepAliveClient(this.mplexer);

          // Handshake with Cardano peer (through websockify)
          this.setState("handshaking");
          const handshake = new HandshakeClient(this.mplexer);
          const result = await handshake.propose({
            networkMagic: config.networkMagic,
            query: false,
          });

          if (!(result instanceof HandshakeAcceptVersion)) {
            throw new Error("Handshake rejected by Cardano peer");
          }

          console.log("[browser-node] Handshake accepted via websockify proxy");
          this.setState("syncing");
          this.startKeepAlive();
          resolve();
        } catch (err) {
          this.setState("error");
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = () => {
        this.setState("error");
        reject(new Error("WebSocket connection to websockify failed"));
      };

      ws.onclose = () => {
        this.stopKeepAlive();
        if (this._state !== "disconnected") {
          this.setState("disconnected");
        }
      };
    });
  }

  /** Start ChainSync from the peer's tip */
  async startChainSync(): Promise<void> {
    if (!this.chainSync) throw new Error("Not connected");

    const intersectEmpty = await this.chainSync.findIntersect([]);
    const tipSlot = intersectEmpty.tip.point.blockHeader?.slotNumber;
    console.log(`[browser-node] Peer tip at slot ${tipSlot} (via websockify)`);

    this.chainSync.on("rollForward", (rf: ChainSyncRollForward) => {
      const tip = rf.tip.point.blockHeader?.slotNumber ?? 0n;
      this.emit("rollForward", rf.toCborBytes(), tip);
    });

    this.chainSync.on("rollBackwards", (rb: ChainSyncRollBackwards) => {
      const slot = rb.point.blockHeader?.slotNumber ?? 0n;
      this.emit("rollBackward", slot);
    });

    this.chainSync.on("error", (err: Error) => {
      console.error("[browser-node] ChainSync error:", err);
      this.emit("error", err);
    });

    await this.chainSync.findIntersect([intersectEmpty.tip.point]);
    this.setState("synced");
    await this.chainSync.requestNext();
  }

  /** Fetch a specific block */
  async fetchBlock(slot: number | bigint, blockHash: Uint8Array): Promise<BlockFetchBlock | null> {
    if (!this.blockFetch) throw new Error("Not connected");
    const { ChainPoint } = await import("@harmoniclabs/ouroboros-miniprotocols-ts");
    const point = new ChainPoint({ blockHeader: { slotNumber: slot, hash: blockHash } });
    const result = await this.blockFetch.request(point);
    if ("blockCbor" in result) {
      this.emit("block", result as BlockFetchBlock);
      return result as BlockFetchBlock;
    }
    return null;
  }

  private startKeepAlive(interval = 60000) {
    this.keepAliveInterval = setInterval(() => {
      if (!this.keepAlive) return;
      this.cookieCounter = (this.cookieCounter + 1) % 65536;
      this.keepAlive.request(this.cookieCounter);
    }, interval);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  disconnect() {
    this.stopKeepAlive();
    try { this.chainSync?.done(); } catch {}
    try { this.blockFetch?.done(); } catch {}
    try { this.keepAlive?.done(); } catch {}
    try { this.mplexer?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.mplexer = null;
    this.chainSync = null;
    this.blockFetch = null;
    this.keepAlive = null;
    this.setState("disconnected");
  }
}
