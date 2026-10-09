/**
 * UTxO RPC server (https://utxorpc.org, spec v1alpha, what the official SDKs speak, @utxorpc/sdk
 * 0.9 / @utxorpc/spec 0.19). One TCP port serves three protocols through @connectrpc/connect-node:
 *   - gRPC over HTTP/2 cleartext (h2c, what the SDK and grpcurl use): Bun's node:http2 server,
 *     trailers included (verified on Bun 1.4.2, docs/parity/utxorpc.md item 480);
 *   - gRPC-Web and Connect over HTTP/1.1 (browsers, curl): an internal node:http server.
 * The first bytes of a connection decide: the HTTP/2 preface goes to the h2 server, anything else
 * is piped to the HTTP/1.1 server (Bun's http server does not accept sockets handed over by
 * `emit("connection")`, so it listens on a loopback port of its own).
 *
 * Config: `utxorpc: { enabled, host, port }` (default off; host 127.0.0.1, port 50051), or env
 * GEROLAMO_UTXORPC=host:port | port | 0.
 */
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { queryConnect, submitConnect, syncConnect, watchConnect } from "@utxorpc/spec";
import { logger } from "../../utils/logger";
import { DEFAULT_LIMITS, type UtxorpcLimits } from "./common";
import { queryService } from "./query";
import { submitService } from "./submit";
import { syncService, watchService } from "./sync";
import type { UtxorpcProvider } from "./provider";

const log = logger.child("utxorpc");

export interface UtxorpcConfig { host: string; port: number }
export const DEFAULT_UTXORPC_PORT = 50051;

/** `utxorpc: { enabled, host, port }` / GEROLAMO_UTXORPC; null when off (the default). */
export function resolveUtxorpcConfig(config: { utxorpc?: unknown } | undefined, env: Record<string, string | undefined> = process.env): UtxorpcConfig | null {
    const parse = (host: unknown, port: unknown): UtxorpcConfig | null => {
        const p = port == null || port === "" ? DEFAULT_UTXORPC_PORT : Number(port);
        if (!Number.isInteger(p) || p < 0 || p > 65535) return null;
        return { host: typeof host === "string" && host.trim() ? host.trim() : "127.0.0.1", port: p };
    };
    const e = env.GEROLAMO_UTXORPC?.trim();
    if (e === "0" || e === "off" || e === "false") return null;
    if (e) {
        if (e === "1" || e === "on" || e === "true") return parse(null, null);
        const i = e.lastIndexOf(":");
        const r = i > 0 ? parse(e.slice(0, i).replace(/^\[|\]$/g, ""), e.slice(i + 1)) : parse(null, e);
        if (!r) log.warn(`GEROLAMO_UTXORPC=${e} is not host:port; UTxO RPC off`);
        return r;
    }
    const c = config?.utxorpc;
    if (!c || typeof c !== "object") return null;
    const o = c as { enabled?: unknown; host?: unknown; port?: unknown };
    if (o.enabled !== true) return null;
    return parse(o.host, o.port);
}

export function utxorpcRoutes(provider: UtxorpcProvider, limits: UtxorpcLimits = DEFAULT_LIMITS) {
    return (router: ConnectRouter) => {
        router.service(queryConnect.QueryService, queryService(provider, limits));
        router.service(submitConnect.SubmitService, submitService(provider, limits));
        router.service(syncConnect.SyncService, syncService(provider, limits));
        router.service(watchConnect.WatchService, watchService(provider, limits));
    };
}

export interface UtxorpcHandle { host: string; port: number; stop(): Promise<void> }

const H2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n");

export async function startUtxorpcServer(cfg: UtxorpcConfig, provider: UtxorpcProvider, limits: UtxorpcLimits = DEFAULT_LIMITS): Promise<UtxorpcHandle> {
    const handler = connectNodeAdapter({ routes: utxorpcRoutes(provider, limits), readMaxBytes: limits.maxRequestBytes });
    const h2 = http2.createServer(handler);
    const h1 = http.createServer(handler);
    await new Promise<void>((resolve, reject) => { h1.once("error", reject); h1.listen(0, "127.0.0.1", () => resolve()); });
    const h1Port = (h1.address() as net.AddressInfo).port;
    const sockets = new Set<net.Socket>();
    const front = net.createServer((sock) => {
        sockets.add(sock);
        sock.once("close", () => sockets.delete(sock));
        sock.on("error", () => sock.destroy());
        let head = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const n = Math.min(head.length, H2_PREFACE.length);
            const isH2 = head.subarray(0, n).equals(H2_PREFACE.subarray(0, n));
            if (isH2 && head.length < H2_PREFACE.length) return; // wait for the whole preface
            sock.off("data", onData);
            sock.pause();
            if (isH2) {
                sock.unshift(head);
                h2.emit("connection", sock);
                sock.resume();
                return;
            }
            const up = net.connect(h1Port, "127.0.0.1");
            sockets.add(up);
            up.once("close", () => { sockets.delete(up); sock.destroy(); });
            up.on("error", () => sock.destroy());
            sock.once("close", () => up.destroy());
            up.write(head);
            sock.pipe(up);
            up.pipe(sock);
            sock.resume();
        };
        sock.on("data", onData);
    });
    await new Promise<void>((resolve, reject) => { front.once("error", reject); front.listen(cfg.port, cfg.host, () => resolve()); });
    const addr = front.address() as net.AddressInfo;
    log.info(`UTxO RPC (v1alpha: gRPC h2c, gRPC-Web, Connect) on ${addr.address}:${addr.port}`);
    return {
        host: addr.address,
        port: addr.port,
        async stop() {
            for (const s of sockets) s.destroy();
            await Promise.all([
                new Promise<void>((r) => front.close(() => r())),
                new Promise<void>((r) => h1.close(() => r())),
                new Promise<void>((r) => { try { h2.close(() => r()); } catch { r(); } }),
            ]);
        },
    };
}
