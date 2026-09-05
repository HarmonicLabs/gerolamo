/**
 * One WebSocket per running instance to the node's `/ws/stats` stream.
 *
 * The node pushes `metrics` (≤ 1/s while blocks land) and `mempool` (on change)
 * frames; the desktop caches the latest of each and serves status and mempool
 * requests from that cache instead of polling the node over HTTP every 2 s.
 * A listener gets told when a frame lands so the UI can refresh at once.
 */
import type { MetricsPayload } from "../shared/syncStatus";
import type { MempoolSnapshot } from "../shared/types";

type Feed = {
  url: string;
  ws: WebSocket | null;
  stopped: boolean;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  metrics: MetricsPayload | null;
  metricsAt: number;
  mempool: MempoolSnapshot | null;
  mempoolAt: number;
};

const feeds = new Map<string, Feed>();
let eventListener: ((id: string, type: string) => void) | null = null;

/** Called on every cached frame (`metrics` | `mempool`). */
export function setFeedEventListener(cb: ((id: string, type: string) => void) | null): void {
  eventListener = cb;
}

/** ws://host:port/ws/stats for an http base. */
export function feedUrlFor(httpBase: string): string {
  return httpBase.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/stats";
}

/** Reconnect delay: 1 s doubling to 10 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/** A cached value is usable while younger than `maxAgeMs`; older means the stream stalled. */
export function pickFresh<T>(value: T | null, at: number, now: number, maxAgeMs: number): T | null {
  return value != null && now - at <= maxAgeMs ? value : null;
}

export function ensureFeed(id: string, httpBase: string): void {
  const url = feedUrlFor(httpBase);
  let f = feeds.get(id);
  if (f && f.url === url && !f.stopped) return;
  if (f) stopFeed(id);
  f = { url, ws: null, stopped: false, attempt: 0, timer: null, metrics: null, metricsAt: 0, mempool: null, mempoolAt: 0 };
  feeds.set(id, f);
  connect(id, f);
}

export function stopFeed(id: string): void {
  const f = feeds.get(id);
  if (!f) return;
  f.stopped = true;
  if (f.timer) clearTimeout(f.timer);
  f.timer = null;
  try {
    f.ws?.close();
  } catch {
    /* */
  }
  f.ws = null;
  feeds.delete(id);
}

export function isFeedConnected(id: string): boolean {
  return feeds.get(id)?.ws?.readyState === WebSocket.OPEN;
}

export function feedMetrics(id: string, maxAgeMs = 5_000, now = Date.now()): MetricsPayload | null {
  const f = feeds.get(id);
  return f ? pickFresh(f.metrics, f.metricsAt, now, maxAgeMs) : null;
}

export function feedMempool(id: string, maxAgeMs = 5_000, now = Date.now()): MempoolSnapshot | null {
  const f = feeds.get(id);
  return f ? pickFresh(f.mempool, f.mempoolAt, now, maxAgeMs) : null;
}

function connect(id: string, f: Feed): void {
  if (f.stopped || f.ws) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(f.url);
  } catch {
    scheduleReconnect(id, f);
    return;
  }
  f.ws = ws;
  ws.onopen = () => {
    f.attempt = 0;
    try {
      ws.send(JSON.stringify({ op: "unsubscribe", topics: ["tip", "peers"] }));
      ws.send(JSON.stringify({ op: "subscribe", topics: ["metrics", "mempool"] }));
    } catch {
      /* */
    }
  };
  ws.onmessage = (ev) => {
    let msg: { type?: string; data?: unknown } | null = null;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "metrics" && msg.data && typeof msg.data === "object") {
      f.metrics = msg.data as MetricsPayload;
      f.metricsAt = Date.now();
    } else if (msg.type === "mempool" && msg.data && typeof msg.data === "object") {
      const d = msg.data as { count?: number; txs?: Array<{ tx_hash: string; size: number }> };
      f.mempool = { ok: true, count: d.count ?? 0, txs: d.txs ?? [] };
      f.mempoolAt = Date.now();
    } else {
      return;
    }
    try {
      eventListener?.(id, msg.type);
    } catch {
      /* */
    }
  };
  ws.onclose = () => {
    if (f.ws === ws) f.ws = null;
    if (!f.stopped) scheduleReconnect(id, f);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* */
    }
  };
}

function scheduleReconnect(id: string, f: Feed): void {
  if (f.stopped || f.timer) return;
  f.attempt += 1;
  f.timer = setTimeout(() => {
    f.timer = null;
    connect(id, f);
  }, reconnectDelayMs(f.attempt));
}
