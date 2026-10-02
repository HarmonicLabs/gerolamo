import { MiniProtocol, Multiplexer, type MultiplexerHeader } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { isN2NInitiatorFrame } from "./N2NDirection";
import { createServer, type Server, type Socket } from "node:net";
import { logger } from "../../utils/logger";
import { N2NBlockFetchHost } from "./N2NBlockFetchHost";
import { N2NChainSyncHost } from "./N2NChainSyncHost";
import { N2NHandshakeResponder } from "./N2NHandshakeResponder";
import { N2NKeepAliveHost } from "./N2NKeepAliveHost";
import { N2NPeerSharingHost, type SharePeersProvider } from "./N2NPeerSharingHost";
import { N2NTxSubmissionHost, type TxSubmissionMempool } from "./N2NTxSubmissionHost";
import type { RelayChainStore } from "./RelayChainStore";
import { SqliteRelayChainStore } from "./SqliteRelayChainStore";
import { WsNodeSocket } from "./WsNodeSocket";
import { N2NLightQueryHost, type LightQueryDeps } from "./N2NLightQueryHost";
import { formatHostPort, normalizeHost } from "../relayAccessPoint";

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
    /** Peers to hand out on MsgShareRequest. Omit to answer with an empty list. */
    sharePeers?: SharePeersProvider;
    /** Pull the connecting peers' transactions into this mempool (block producers). Omit to ignore tx-submission. */
    mempool?: TxSubmissionMempool;
    /** N2N over WebSocket for browser nodes. */
    ws?: { host: string; port: number };
    /** Gerolamo light-query mini-protocol (epoch nonce, pool stake) for browser light clients. */
    lightQuery?: LightQueryDeps;
}

export interface InboundClientInfo {
    peer: string;
    transport: "tcp" | "ws";
    since: number;
    version: number | null;
    handshakeOk: boolean;
    /** Slot the peer has pulled up to over ChainSync; null before it asked for anything. */
    chainSyncSlot: number | null;
    /** Mini-protocols the client has started (keep-alive = warm at its side, chain-sync = hot). */
    protocols: string[];
    /** From its handshake proposal: InitiatorAndResponder (duplex, reachable at `peer`) or InitiatorOnly; null = unknown. */
    duplex?: boolean | null;
    /** It proposed PeerSharing enabled. */
    peerSharing?: boolean | null;
}

export interface N2NServerHandle {
    /** WebSocket bearer port when enabled. */
    wsPort: number | null;
    readonly host: string;
    readonly port: number;
    readonly networkMagic: number;
    clientCount(): number;
    clients(): InboundClientInfo[];
    stop(): Promise<void>;
}

interface ActiveClient {
    socket: InboundSocket;
    transport: "tcp" | "ws";
    mplexer: Multiplexer;
    handshake: N2NHandshakeResponder;
    chainSync?: N2NChainSyncHost;
    blockFetch?: N2NBlockFetchHost;
    keepAlive?: N2NKeepAliveHost;
    peerSharing?: N2NPeerSharingHost;
    lightQuery?: N2NLightQueryHost;
    txSubmission?: N2NTxSubmissionHost;
    handshakeTimer?: ReturnType<typeof setTimeout>;
    refused?: boolean;
    peer: string;
    since: number;
    version: number | null;
    protocols: Map<string, number>;
    remoteDuplex?: boolean | null;
    remotePeerSharing?: boolean | null;
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
    let wsServer: ReturnType<typeof Bun.serve> | null = null;
    if (options.ws) {
        // Second bearer: the same mux frames over WebSocket, for browser nodes (docs/PLAN_BROWSER_NODE.md).
        const wsHost = options.ws.host, wsPort = options.ws.port;
        wsServer = Bun.serve<{ sock: WsNodeSocket | null }>({
            hostname: wsHost,
            port: wsPort,
            fetch(req, server) {
                const url = new URL(req.url);
                if (url.pathname !== "/" && url.pathname !== "/n2n") return new Response("Gerolamo N2N over WebSocket: connect at / or /n2n", { status: 404 });
                if (clients.size >= maxConnections) return new Response("too many connections", { status: 503 });
                const ok = server.upgrade(req, { data: { sock: null } });
                return ok ? undefined : new Response("expected a WebSocket upgrade", { status: 426 });
            },
            websocket: {
                open(ws) {
                    const addr = ws.remoteAddress ?? "unknown";
                    const sock = new WsNodeSocket(ws, { remoteAddress: addr, remotePort: 0 });
                    ws.data.sock = sock;
                    attachClient(sock, clients, store, options);
                },
                message(ws, data) { ws.data.sock?.onMessage(data as ArrayBuffer | Uint8Array | string); },
                close(ws) { ws.data.sock?.onClose(false); },
            },
        });
        log.info(`N2N over WebSocket listening on ws://${wsHost}:${wsPort}/ (browser nodes)`);
    }

    return {
        host,
        port,
        networkMagic,
        clientCount: () => clients.size,
        clients: () => [...clients.values()].map((c) => ({ peer: c.peer, transport: c.transport, since: c.since, version: c.version, handshakeOk: !!c.chainSync, chainSyncSlot: c.chainSync?.cursorSlot() ?? null, protocols: [...c.protocols.keys()], duplex: c.remoteDuplex ?? null, peerSharing: c.remotePeerSharing ?? null })),
        wsPort: wsServer ? (wsServer.port ?? null) : null,
        stop: () => { try { wsServer?.stop(true); } catch { /* ignore */ } return stopServer(server, clients); },
    };
}

/** What the inbound path needs from a connection: a Node socket, or a `WsNodeSocket` over a WebSocket. */
export interface InboundSocket {
    remoteAddress?: string;
    remotePort?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: any, listener: any): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write(data: any, cb?: any): boolean;
    end(): unknown;
    destroy(err?: Error): unknown;
    setTimeout(ms: number, cb?: () => void): unknown;
}

function attachClient(
    socket: InboundSocket,
    clients: Set<ActiveClient>,
    store: RelayChainStore,
    options: N2NServerOptions,
): void {
    // IPv6-safe key ([2001:db8::1]:3001); a dual-stack listener reports IPv4 clients as ::ffff:a.b.c.d
    const peer = socket.remoteAddress ? formatHostPort(normalizeHost(socket.remoteAddress), socket.remotePort ?? 0) : `unknown:${socket.remotePort ?? 0}`;
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
        transport: socket instanceof WsNodeSocket ? "ws" : "tcp",
        peer,
        since: Date.now(),
        version: null,
        protocols: new Map(),
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
        client.peerSharing?.dispose();
        client.lightQuery?.dispose();
        if (client.txSubmission) { const st = client.txSubmission.stats; if (st.announced) log.info(`N2N ${peer} tx-submission: ${st.announced} announced, ${st.fetched} fetched, ${st.accepted} accepted, ${st.rejected} rejected`); client.txSubmission.dispose(); }
        try {
            if (!mplexer.isClosed()) mplexer.close({ closeSocket: false });
        } catch {
            /* ignore */
        }
        log.info(`N2N client disconnected ${peer}; active=${clients.size}; lived ${Math.round((Date.now() - client.since) / 1000)} s; ran ${[...client.protocols.keys()].join(", ") || "nothing"}`);
    };

    const handshake = new N2NHandshakeResponder(mplexer, {
        networkMagic: options.networkMagic,
        onAccepted: ({ versionNumber, remoteVersionData }) => {
            if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
            client.handshakeTimer = undefined;
            handshake.dispose();
            client.version = Number.isFinite(Number(versionNumber)) ? Number(versionNumber) : null;
            const rv = remoteVersionData as { initiatorOnlyDiffusionMode?: boolean; peerSharing?: boolean | number } | undefined;
            client.remoteDuplex = typeof rv?.initiatorOnlyDiffusionMode === "boolean" ? !rv.initiatorOnlyDiffusionMode : null;
            client.remotePeerSharing = rv?.peerSharing == null ? null : !!rv.peerSharing;
            // first frame per mini-protocol: what the remote's governor does with us (warm = keep-alive, hot = chain-sync)
            const names: Record<number, string> = { [MiniProtocol.ChainSync]: "chain-sync", [MiniProtocol.BlockFetch]: "block-fetch", [MiniProtocol.TxSubmission]: "tx-submission", [MiniProtocol.KeepAlive]: "keep-alive", [MiniProtocol.PeerSharing]: "peer-sharing" };
            for (const proto of [MiniProtocol.ChainSync, MiniProtocol.BlockFetch, MiniProtocol.TxSubmission, MiniProtocol.KeepAlive, MiniProtocol.PeerSharing]) {
                const name = names[proto] ?? String(proto);
                mplexer.on(proto, (_p: Uint8Array, h?: MultiplexerHeader) => {
                    if (!isN2NInitiatorFrame(h) || client.protocols.has(name)) return;
                    client.protocols.set(name, Date.now());
                    log.info(`N2N client ${peer} started ${name}${proto === MiniProtocol.ChainSync ? " (pulling our chain)" : ""}`);
                });
            }
            client.chainSync = new N2NChainSyncHost(mplexer, store, { peer: `${peer} (inbound)` });
            client.blockFetch = new N2NBlockFetchHost(mplexer, store, {
                maxRangeBlocks: options.maxRangeBlocks ?? 256,
                peer: `${peer} (inbound)`,
            });
            client.keepAlive = new N2NKeepAliveHost(mplexer);
            client.peerSharing = new N2NPeerSharingHost(mplexer, options.sharePeers ?? (() => []));
            if (options.lightQuery) client.lightQuery = new N2NLightQueryHost(mplexer, options.lightQuery, peer);
            if (options.mempool) client.txSubmission = new N2NTxSubmissionHost(mplexer, { mempool: options.mempool, peer });
            log.info(`N2N handshake ok ${peer} version=${versionNumber}`);
        },
        onRefused: () => {
            if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
            client.handshakeTimer = undefined;
            client.refused = true; // the peer's socket error that follows our close is expected
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
        // A refused handshake (wrong network magic — e.g. a preprod node dialling a preview
        // listener every 45 s) ends with the peer's socket error: one line, not a stack dump.
        if (client.refused) log.debug(`N2N ${peer}: closed after a refused handshake`);
        else log.warn(`N2N multiplexer error ${peer}:`, error);
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
        client.peerSharing?.dispose();
        client.txSubmission?.dispose();
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
