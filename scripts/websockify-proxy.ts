#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// websockify-proxy — Bun-native WebSocket↔TCP proxy
//
// Functionally identical to noVNC/websockify: bridges browser WebSocket
// connections to a raw TCP backend (Cardano relay).
//
// Why not the npm `websockify` package?
//   Bun's `ws` passes `protocols` as a Set, not Array — crashes on
//   `protocols.indexOf("binary")`. This Bun-native implementation avoids
//   the incompatibility and is simpler.
//
// Usage:
//   bun scripts/websockify-proxy.ts <listen_port> <target_host:target_port>
//   bun scripts/websockify-proxy.ts 3060 preprod-node.play.dev.cardano.org:3001
// ---------------------------------------------------------------------------

import { connect as tcpConnect, type Socket } from "net";

const [listenPort, target] = Bun.argv.slice(2);
if (!listenPort || !target) {
  console.error("Usage: websockify-proxy <listen_port> <target_host:target_port>");
  process.exit(1);
}

const port = parseInt(listenPort, 10);
const colonIdx = target.lastIndexOf(":");
const targetHost = target.slice(0, colonIdx);
const targetPort = parseInt(target.slice(colonIdx + 1), 10);

if (!targetHost || isNaN(targetPort)) {
  console.error(`Invalid target: ${target}. Expected host:port`);
  process.exit(1);
}

let connectionCount = 0;

const server = Bun.serve({
  port,
  fetch(req, server) {
    // Upgrade HTTP to WebSocket
    const upgraded = server.upgrade(req, {
      data: { id: ++connectionCount },
    });
    if (!upgraded) {
      return new Response("websockify-proxy: WebSocket upgrade required", {
        status: 403,
      });
    }
  },
  websocket: {
    binaryType: "arraybuffer",

    open(ws) {
      const id = (ws.data as any).id;
      console.log(`[ws #${id}] WebSocket connected, opening TCP to ${targetHost}:${targetPort}`);

      const tcp: Socket = tcpConnect(targetPort, targetHost, () => {
        console.log(`[ws #${id}] TCP connected to ${targetHost}:${targetPort}`);
      });

      // TCP → WebSocket
      tcp.on("data", (data: Buffer) => {
        try {
          ws.sendBinary(data);
        } catch {
          tcp.destroy();
        }
      });

      tcp.on("error", (err: Error) => {
        console.error(`[ws #${id}] TCP error: ${err.message}`);
        ws.close(1011, "TCP error");
      });

      tcp.on("close", () => {
        console.log(`[ws #${id}] TCP closed`);
        try { ws.close(1000, "TCP closed"); } catch {}
      });

      // Store TCP socket on ws data for message/close handlers
      (ws.data as any).tcp = tcp;
    },

    message(ws, message) {
      const tcp = (ws.data as any).tcp as Socket | undefined;
      if (!tcp || tcp.destroyed) return;

      // WebSocket → TCP (binary pass-through)
      if (message instanceof ArrayBuffer) {
        tcp.write(Buffer.from(message));
      } else if (typeof message === "string") {
        // base64 mode (fallback, unlikely for Ouroboros)
        tcp.write(Buffer.from(message, "base64"));
      }
    },

    close(ws, code, reason) {
      const id = (ws.data as any).id;
      console.log(`[ws #${id}] WebSocket closed (${code}: ${reason})`);
      const tcp = (ws.data as any).tcp as Socket | undefined;
      if (tcp && !tcp.destroyed) tcp.destroy();
    },
  },
});

console.log(`WebSocket settings:`);
console.log(`    - proxying from :${port} to ${targetHost}:${targetPort}`);
console.log(`    - Running in unencrypted HTTP (ws://) mode`);
console.log(`    - Bun-native websockify proxy`);
