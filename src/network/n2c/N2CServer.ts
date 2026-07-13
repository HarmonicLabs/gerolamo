import { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { logger } from "../../utils/logger";
import { HandshakeResponder } from "./HandshakeResponder";

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
}

/**
 * Ouroboros Node-to-Client Unix socket server (Phase 1: accept + Handshake only).
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

    const handshake = new HandshakeResponder(mplexer, {
        networkMagic,
        onAccepted: ({ versionNumber }) => {
            n2cLogger.info(
                `N2C handshake ok peer=${peer} version=${versionNumber}`,
            );
        },
        onRefused: (reason) => {
            n2cLogger.info(`N2C handshake refused peer=${peer}: ${reason}`);
        },
    });

    const client: ActiveClient = { socket, mplexer, handshake };
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
        // Unblock close if no connections linger.
        setTimeout(() => resolveClose(), 500).unref?.();
    });

    try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
        /* ignore */
    }
    n2cLogger.info(`N2C server stopped (${socketPath})`);
}
