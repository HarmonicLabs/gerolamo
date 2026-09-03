import { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { createServer, type Server, type Socket } from "node:net";
import { logger } from "../../utils/logger";
import { N2NBlockFetchHost } from "./N2NBlockFetchHost";
import { N2NChainSyncHost } from "./N2NChainSyncHost";
import { N2NHandshakeResponder } from "./N2NHandshakeResponder";
import { N2NKeepAliveHost } from "./N2NKeepAliveHost";
import type { RelayChainStore } from "./RelayChainStore";
import { SqliteRelayChainStore } from "./SqliteRelayChainStore";

const log = logger.child("n2n");

export interface N2NServerOptions {
    host?: string;
    port: number;
    networkMagic: number;
    maxConnections?: number;
    maxRangeBlocks?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    store?: RelayChainStore;
}

export interface N2NServerHandle {
    readonly host: string;
    readonly port: number;
    readonly networkMagic: number;
    clientCount(): number;
    stop(): Promise<void>;
}

interface ActiveClient {
    socket: Socket;
    mplexer: Multiplexer;
    handshake: N2NHandshakeResponder;
    chainSync?: N2NChainSyncHost;
    blockFetch?: N2NBlockFetchHost;
    keepAlive?: N2NKeepAliveHost;
    handshakeTimer?: ReturnType<typeof setTimeout>;
}

export async function startN2NServer(
    options: N2NServerOptions,
): Promise<N2NServerHandle> {
    const host = options.host?.trim() || "0.0.0.0";
    const networkMagic = options.networkMagic;
    const maxConnections = Math.max(
        1,
        Math.trunc(options.maxConnections ?? 64),
    );
    const store = options.store ?? new SqliteRelayChainStore();
    const clients = new Set<ActiveClient>();
    let server!: Server;

    await new Promise<void>((resolve, reject) => {
        server = createServer((socket) => {
            if (clients.size >= maxConnections) {
                log.warn(
                    `rejecting inbound connection: maxConnections=${maxConnections}`,
                );
                socket.destroy();
                return;
            }
            attachClient(socket, clients, store, options);
        });
        server.once("error", reject);
        server.listen(options.port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("N2N TCP server did not expose an address");
    }
    const port = address.port;
    log.info(
        `N2N listening on ${host}:${port} networkMagic=${networkMagic} maxConnections=${maxConnections}`,
    );

    return {
        host,
        port,
        networkMagic,
        clientCount: () => clients.size,
        stop: () => stopServer(server, clients),
    };
}

function attachClient(
    socket: Socket,
    clients: Set<ActiveClient>,
    store: RelayChainStore,
    options: N2NServerOptions,
): void {
    const peer = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    let handedOut = false;
    const mplexer = new Multiplexer({
        protocolType: "node-to-node",
        connect: () => {
            if (handedOut) {
                throw new Error(
                    "inbound N2N Multiplexer cannot reconnect an accepted socket",
                );
            }
            handedOut = true;
            return socket as any;
        },
    });
    const client: ActiveClient = {
        socket,
        mplexer,
        handshake: null as any,
    };
    clients.add(client);

    const cleanup = () => {
        if (!clients.delete(client)) return;
        if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
        client.handshake.dispose();
        client.chainSync?.dispose();
        client.blockFetch?.dispose();
        client.keepAlive?.dispose();
        try {
            if (!mplexer.isClosed()) mplexer.close({ closeSocket: false });
        } catch {
            /* ignore */
        }
        log.info(`N2N client disconnected ${peer}; active=${clients.size}`);
    };

    const handshake = new N2NHandshakeResponder(mplexer, {
        networkMagic: options.networkMagic,
        onAccepted: ({ versionNumber }) => {
            if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
            client.handshakeTimer = undefined;
            handshake.dispose();
            client.chainSync = new N2NChainSyncHost(mplexer, store);
            client.blockFetch = new N2NBlockFetchHost(mplexer, store, {
                maxRangeBlocks: options.maxRangeBlocks ?? 256,
            });
            client.keepAlive = new N2NKeepAliveHost(mplexer);
            log.info(`N2N handshake ok ${peer} version=${versionNumber}`);
        },
        onRefused: () => {
            if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
            client.handshakeTimer = undefined;
            setTimeout(() => socket.end(), 0);
        },
    });
    client.handshake = handshake;

    client.handshakeTimer = setTimeout(() => {
        log.warn(`N2N handshake timeout ${peer}`);
        socket.destroy();
    }, Math.max(100, options.handshakeTimeoutMs ?? 10_000));
    socket.setTimeout(Math.max(1_000, options.idleTimeoutMs ?? 120_000));
    socket.on("timeout", () => socket.destroy());
    socket.on("error", (error) => {
        log.warn(`N2N socket error ${peer}: ${error.message}`);
        cleanup();
    });
    socket.on("close", cleanup);
    mplexer.on("error", (error) => {
        log.warn(`N2N multiplexer error ${peer}:`, error);
        socket.destroy();
    });
    log.info(`N2N client connected ${peer}; active=${clients.size}`);
}

async function stopServer(
    server: Server,
    clients: Set<ActiveClient>,
): Promise<void> {
    for (const client of [...clients]) {
        if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
        client.handshake.dispose();
        client.chainSync?.dispose();
        client.blockFetch?.dispose();
        client.keepAlive?.dispose();
        try {
            client.mplexer.close({ closeSocket: false });
        } catch {
            /* ignore */
        }
        client.socket.destroy();
    }
    clients.clear();
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 500).unref?.();
    });
    log.info("N2N server stopped");
}
