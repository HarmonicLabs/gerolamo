/**
 * One WebSocket to the node's `/ws/stats` stream, shared by every page.
 *
 * The node pushes `tip`, `block`, `metrics`, `peers` and `mempool` frames as
 * they happen; pages subscribe to the topics they render instead of polling.
 * Reconnects with backoff; `connected()` lets a page fall back to a slow poll
 * while the socket is down.
 */
import { createSignal } from "solid-js";
import { NODE_BASE_URL } from "./explorer";

export type WsFrame = { v?: number; type: string; data?: unknown; ts?: string };
export type FrameListener = (data: any, frame: WsFrame) => void;

/** ws(s)://host/ws/stats for an http(s) base, or the page's own origin when base is empty. */
export function wsUrlFor(base: string, origin: string): string {
  const u = new URL("/ws/stats", base || origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** Parse one frame; null for anything that is not `{type: string}` JSON. */
export function parseFrame(raw: unknown): WsFrame | null {
  try {
    const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (msg && typeof msg === "object" && typeof (msg as WsFrame).type === "string") return msg as WsFrame;
  } catch {
    /* not JSON */
  }
  return null;
}

/** Reconnect delay: 1 s doubling to 10 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

class NodeSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly listeners = new Map<string, Set<FrameListener>>();
  private readonly connectedSignal = createSignal(false);

  /** True while the socket is open. Reactive. */
  readonly connected = this.connectedSignal[0];

  /** Listen for frames of one type; opens the socket on first use. Returns the unsubscribe. */
  subscribe(type: string, cb: FrameListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
      this.send({ op: "subscribe", topics: [type] });
    }
    set.add(cb);
    this.open();
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(type);
        this.send({ op: "unsubscribe", topics: [type] });
      }
    };
  }

  private topics(): string[] {
    return [...this.listeners.keys()];
  }

  private send(msg: unknown): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    } catch {
      /* dropped; resent on open */
    }
  }

  private open(): void {
    if (this.ws || typeof WebSocket === "undefined") return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFor(NODE_BASE_URL, location.origin));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.connectedSignal[1](true);
      // The server pre-subscribes tip/peers/metrics; narrow to what pages asked for.
      const wanted = this.topics();
      const unwanted = ["tip", "peers", "metrics"].filter((t) => !wanted.includes(t));
      if (unwanted.length) this.send({ op: "unsubscribe", topics: unwanted });
      if (wanted.length) this.send({ op: "subscribe", topics: wanted });
    };
    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (!frame) return;
      const set = this.listeners.get(frame.type);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(frame.data, frame);
        } catch {
          /* one bad listener must not stop the others */
        }
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.connectedSignal[1](false);
      if (this.listeners.size) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.listeners.size) this.open();
    }, reconnectDelayMs(this.attempt));
  }
}

export const nodeSocket = new NodeSocket();
