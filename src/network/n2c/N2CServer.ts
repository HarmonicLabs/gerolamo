import { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { logger } from "../../utils/logger";
import { HandshakeResponder } from "./HandshakeResponder";
import { getSharedChainDb } from "./GerolamoChainDb";
import { LocalChainSyncHost } from "./LocalChainSyncHost";
import { LocalTxSubmitHost } from "./LocalTxSubmitHost";
import { LocalStateQueryHost } from "./LocalStateQueryHost";
import { LocalTxMonitorHost } from "./LocalTxMonitorHost";

const n2cLogger = logger.child("n2c");

export interface N2CServerOptions {
    socketPath: string;
    networkMagic: number;
}

export interface N2CServerHandle {
    readonly socketPath: string;
    readonly networkMagic: number;
    clientCount(): number;
    stop(): Promise<void>;
}

interface ActiveClient {
    socket: Socket;
    mplexer: Multiplexer;
    handshake: HandshakeResponder;
    chainSync?: LocalChainSyncHost;
    txSubmit?: LocalTxSubmitHost;
    stateQuery?: LocalStateQueryHost;
    txMonitor?: LocalTxMonitorHost;
}

/**
 * Ouroboros Node-to-Client Unix socket server.
 *
 * Phase 1: Handshake
 * Phase 2: LocalChainSync (proto 5)
 * Phase 3: LocalTxSubmission (proto 6)
 * Phase 4: LocalStateQuery (proto 7, minimal)
 * Phase 5: LocalTxMonitor (proto 9)
 *
 * Distinct from config.unixSocket (HTTP-over-unix on peerBlockServer).
 */
export async function startN2CServer(
    opts: N2CServerOptions,
): Promise<N2CServerHandle> {
    const socketPath = resolve(opts.socketPath);
    const networkMagic = opts.networkMagic;

    mkdirSync(dirname(socketPath), { recursive: true });
    if (existsSync(socketPath)) {
        try {
            unlinkSync(socketPath);
            n2cLogger.info(`removed stale N2C socket ${socketPath}`);
        } catch (err) {
            n2cLogger.warn(`failed to unlink stale socket ${socketPath}:`, err);
        }
    }

    const clients = new Set<ActiveClient>();
    let server: Server;

    await new Promise<void>((resolveListen, rejectListen) => {
        server = createServer((socket) => {
            onConnection(socket, networkMagic, clients);
        });

        server.once("error", rejectListen);
        server.listen(socketPath, () => {
            try {
                chmodSync(socketPath, 0o660);
            } catch {
                /* best-effort */
            }
            n2cLogger.info(
                `N2C listening on ${socketPath} (networkMagic=${networkMagic})`,
            );
            resolveListen();
        });
    });

    return {
        socketPath,
        networkMagic,
        clientCount: () => clients.size,
        stop: () => stopN2CServer(server!, clients, socketPath),
    };
}

function onConnection(
    socket: Socket,
    networkMagic: number,
    clients: Set<ActiveClient>,
): void {
    const peer = `${socket.remoteAddress ?? "unix"}`;
    n2cLogger.info(`N2C client connected (${peer})`);

    // Server-side: Multiplexer.connect must return the already-accepted socket.
    // Multiplexer is client-oriented and may retry on close — refuse reconnects.
    let handedOut = false;
    const mplexer = new Multiplexer({
        protocolType: "node-to-client",
        connect: () => {
            if (handedOut) {
                throw new Error(
                    "N2C server Multiplexer must not reconnect; client socket is gone",
                );
            }
            handedOut = true;
            return socket as any;
        },
    });

    const chainDb = getSharedChainDb();
    const client: ActiveClient = {
        socket,
        mplexer,
        handshake: null as any,
    };

    const handshake = new HandshakeResponder(mplexer, {
        networkMagic,
        onAccepted: ({ versionNumber }) => {
            n2cLogger.info(
                `N2C handshake ok peer=${peer} version=${versionNumber}; starting protocol hosts`,
            );
            // Wire remaining N2C mini-protocols for this connection only.
            try {
                client.chainSync = new LocalChainSyncHost(mplexer, chainDb);
                client.txSubmit = new LocalTxSubmitHost(mplexer);
                client.stateQuery = new LocalStateQueryHost(mplexer, chainDb);
                client.txMonitor = new LocalTxMonitorHost(mplexer);
            } catch (err) {
                n2cLogger.error(`failed to start N2C hosts for ${peer}:`, err);
            }
        },
        onRefused: (reason) => {
            n2cLogger.info(`N2C handshake refused peer=${peer}: ${reason}`);
        },
    });
    client.handshake = handshake;
    clients.add(client);

    const cleanup = () => {
        if (!clients.has(client)) return;
        clients.delete(client);
        try {
            handshake.dispose();
        } catch {
            /* ignore */
        }
        try {
            client.chainSync?.dispose();
        } catch {
            /* ignore */
        }
        try {
            client.txSubmit?.dispose();
        } catch {
            /* ignore */
        }
        try {
            client.stateQuery?.dispose();
        } catch {
            /* ignore */
        }
        try {
            client.txMonitor?.dispose();
        } catch {
            /* ignore */
        }
        try {
            if (!mplexer.isClosed()) {
                mplexer.close({ closeSocket: true });
            }
        } catch {
            /* ignore */
        }
        n2cLogger.info(`N2C client disconnected (${peer}); active=${clients.size}`);
    };

    mplexer.on("error", (err) => {
        n2cLogger.error(`N2C multiplexer error (${peer}):`, err);
        cleanup();
    });

    socket.on("error", (err) => {
        n2cLogger.warn(`N2C socket error (${peer}):`, err.message);
        cleanup();
    });
    socket.on("close", cleanup);
}

async function stopN2CServer(
    server: Server,
    clients: Set<ActiveClient>,
    socketPath: string,
): Promise<void> {
    for (const c of [...clients]) {
        try {
            c.handshake.dispose();
        } catch {
            /* ignore */
        }
        try {
            c.chainSync?.dispose();
        } catch {
            /* ignore */
        }
        try {
            c.txSubmit?.dispose();
        } catch {
            /* ignore */
        }
        try {
            c.stateQuery?.dispose();
        } catch {
            /* ignore */
        }
        try {
            c.txMonitor?.dispose();
        } catch {
            /* ignore */
        }
        try {
            c.mplexer.close({ closeSocket: true });
        } catch {
            /* ignore */
        }
        try {
            c.socket.destroy();
        } catch {
            /* ignore */
        }
    }
    clients.clear();

    await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        setTimeout(() => resolveClose(), 500).unref?.();
    });

    try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
        /* ignore */
    }
    n2cLogger.info(`N2C server stopped (${socketPath})`);
}
