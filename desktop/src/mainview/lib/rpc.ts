const w = (typeof window !== "undefined" ? window : {}) as any;

let bridge: any = null;
let receiveHooked = false;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timeout: any }>();
let nextId = 1;

export function rpcResponseError(msg: any): Error {
  const candidates = [msg?.error, msg?.payload, msg?.payload?.error, msg?.message];
  for (const value of candidates) {
    if (value instanceof Error) return value;
    if (typeof value === "string" && value && value !== "RPC call failed") return new Error(value);
    if (value && typeof value.message === "string" && value.message) return new Error(value.message);
  }
  return new Error("RPC call failed");
}

function getBridge() {
  if (bridge) return bridge;
  if (w.__electrobunBunBridge?.postMessage) {
    bridge = w.__electrobunBunBridge;
    return bridge;
  }
  const candidates = [
    w.__electrobun?.bunBridge,
    w.bunBridge,
    w.webkit?.messageHandlers?.bunBridge,
  ];
  for (const cand of candidates) {
    if (cand?.postMessage) {
      bridge = cand;
      return bridge;
    }
  }
  return null;
}

function hookReceive() {
  if (receiveHooked) return;
  receiveHooked = true;
  const prev = w.__electrobun?.receiveMessageFromBun;
  const handler = (raw: any) => {
    try {
      const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (msg && msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        clearTimeout(entry.timeout);
        pending.delete(msg.id);
        if (msg.success === false) entry.reject(rpcResponseError(msg));
        else entry.resolve(msg.payload);
        return;
      }
    } catch {
      /* ignore */
    }
    if (typeof prev === "function") prev(raw);
  };
  if (!w.__electrobun) w.__electrobun = {};
  w.__electrobun.receiveMessageFromBun = handler;
}

function timeoutMsFor(method: string): number {
  if (method === "bootstrap.start" || method === "node.start") return 90_000;
  if (method === "wipe.db" || method === "wipe.snapshots") return 60_000;
  return 15_000;
}

function sendRequest(method: string, params: any): Promise<any> {
  const br = getBridge();
  if (!br) {
    return Promise.reject(new Error("[rpc] No Electrobun bridge available yet"));
  }
  const id = `r${nextId++}_${Date.now()}`;
  const timeoutMs = timeoutMsFor(method);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`[rpc] Timeout calling ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    try {
      br.postMessage(JSON.stringify({ type: "request", id, method, params: params ?? undefined }));
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(e);
    }
  });
}

function createRequestsProxy() {
  return new Proxy(
    {},
    {
      get(_target, method: string | symbol) {
        if (typeof method !== "string") return undefined;
        return (params?: any) => {
          if (!bridge) {
            getBridge();
            hookReceive();
          }
          return sendRequest(method, params);
        };
      },
    },
  );
}

const rpc: any = {
  bun: { requests: createRequestsProxy() },
  request: createRequestsProxy(),
};

if (typeof window !== "undefined") {
  getBridge();
  hookReceive();
  window.addEventListener("load", () => {
    setTimeout(() => {
      getBridge();
      hookReceive();
    }, 50);
  });
}

export { rpc };
export default rpc;
