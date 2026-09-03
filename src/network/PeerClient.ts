import {
    BlockFetchBlock,
    BlockFetchClient,
    BlockFetchNoBlocks,
    ChainPoint,
    ChainSyncClient,
    ChainSyncIntersectFound,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    HandshakeAcceptVersion,
    HandshakeClient,
    KeepAliveClient,
    Multiplexer,
    PeerSharingClient,
    PeerSharingResponse,
    TxSubmitClient,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { connect, type Socket } from "node:net";
import { logger } from "../utils/logger";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import type { GerolamoConfig } from "./peerManager";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { initiatorOnly, peerSharingAdvertised } from "./nodeRole";
import { ChainSyncPipeline } from "./ChainSyncPipeline";

import { toHex } from "@harmoniclabs/uint8array-utils";
import { GlobalSharedMempool, type GerolamoMempool } from "./SharedMempool";
import { Tx, TxBody } from "@harmoniclabs/cardano-ledger-ts";
import { GerolamoTxSubmitServer } from "./TxSubmitServer";
import { getBlockBySlot, getMaxSlot } from "../db";
import { peerKey as makePeerKey } from "./PeerGovernor";
import { classifyPeerNetError } from "./peerNetError";
import { RollForwardBatcher } from "./RollForwardBatcher";
import { withTimeout } from "../utils/withTimeout";
import { pickChainSyncStart } from "./chainSyncStart";

export interface RollForwardBatchItem {
    rollForwardCborBytes: Uint8Array;
    tip: bigint;
}

/** Accept blob hash (Uint8Array) or hex string from SQLite / config. */
function asBlockHashBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }
    if (
        typeof value === "string" &&
        /^[0-9a-fA-F]+$/.test(value) &&
        value.length % 2 === 0
    ) {
        try {
            return fromHex(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export interface IPeerClient {
    host: string;
    port: number | bigint;
    /** Stable host:port key (governor identity). */
    peerKey: string;
    /** Log id — may include connect timestamp. */
    peerId: string;
    mplexer: Multiplexer;
    chainSyncClient: ChainSyncClient;
    blockFetchClient: BlockFetchClient;
    keepAliveClient: KeepAliveClient;
    peerSharingClient: PeerSharingClient;
    peerSlotNumber: number | null;
    syncPointFrom?: ChainPoint | null;
    syncPointTo?: ChainPoint | null;
    shelleyGenesisConfig: ShelleyGenesisConfig;
    sharedMempool: GerolamoMempool;
    txSubmitServer: GerolamoTxSubmitServer;
    /** True while ChainSync rollForward loop is active (hot tier). */
    isSyncing: boolean;
    onTerminate?: (peerId: string, peerKey: string, reason?: string) => void;
    onRollForward?: (
        peerId: string,
        rollForwardCborBytes: Uint8Array,
        tip: number | bigint,
    ) => void | Promise<void>;
    onRollForwardBatch?: (
        peerId: string,
        items: RollForwardBatchItem[],
    ) => void | Promise<void>;
    onRollBack?: (peerId: string, point: any) => void | Promise<void>;
    onNewPeers?: (peers: PeerAddress[]) => void;
}

export class PeerClient implements IPeerClient {
    readonly host: string;
    readonly port: number | bigint;
    readonly peerKey: string;
    readonly peerId: string;
    readonly mplexer: Multiplexer;
    readonly chainSyncClient: ChainSyncClient;
    readonly blockFetchClient: BlockFetchClient;
    readonly keepAliveClient: KeepAliveClient;
    readonly peerSharingClient: PeerSharingClient;
    readonly config: GerolamoConfig;
    peerSlotNumber: number | null;
    private cookieCounter: number;
    private keepAliveInterval: NodeJS.Timeout | null;
    private transportSocket?: Socket;
    private terminated = false;
    private syncLoopStarted = false;
    private rollForwardBatcher?: RollForwardBatcher<RollForwardBatchItem>;
    /** Pipelined MsgRequestNext bookkeeping (see ChainSyncPipeline). */
    private csPipeline: ChainSyncPipeline | null = null;
    /** Intersection point from the last FindIntersect, until the first RollForward arrives. */
    private csIntersect: { slot: bigint; hash: string } | null = null;
    /** While true, replies are counted but their content is dropped (pre-restart drain). */
    private csDraining = false;
    /**
     * PeerSharing as *negotiated* in the handshake (ours AND theirs). Starting the
     * mini-protocol when the peer did not agree to it is a protocol violation —
     * mainnet backbone relays answer it with a connection reset.
     */
    peerSharingNegotiated = false;
    isSyncing = false;
    /** ms epoch of last ChainSync rollForward (hot liveness for PeerGovernor). */
    lastRollForwardAt?: number;
    shelleyGenesisConfig: ShelleyGenesisConfig;

    readonly txSubmitClient!: TxSubmitClient;
    readonly txSubmitServer!: GerolamoTxSubmitServer;
    onTerminate?: (peerId: string, peerKey: string, reason?: string) => void;
    onRollForward?: (
        peerId: string,
        rollForwardCborBytes: Uint8Array,
        tip: number | bigint,
    ) => void | Promise<void>;
    onRollForwardBatch?: (
        peerId: string,
        items: RollForwardBatchItem[],
    ) => void | Promise<void>;
    onRollBack?: (peerId: string, point: any) => void | Promise<void>;
    onNewPeers?: (peers: PeerAddress[]) => void;
    readonly sharedMempool: GerolamoMempool;

    constructor(
        host: string,
        port: number | bigint,
        config: GerolamoConfig,
        shelleyGenesisConfig: ShelleyGenesisConfig,
        onTerminate?: (peerId: string, peerKey: string, reason?: string) => void,
    ) {
        this.host = host;
        this.port = port;
        this.config = config;
        this.peerKey = makePeerKey(host, port);
        const unixTimestamp = Math.floor(Date.now() / 1000);
        this.peerId = `${this.peerKey}:${unixTimestamp}`;
        this.onTerminate = onTerminate;
        this.shelleyGenesisConfig = shelleyGenesisConfig;

        this.mplexer = new Multiplexer({
            connect: () => {
                logger.info(`Attempt connection to peer ${this.peerId}`);
                const sock = connect({ host, port: Number(port) });
                this.transportSocket = sock;
                sock.once("close", () => {
                    if (this.transportSocket === sock) this.transportSocket = undefined;
                });
                // Attach immediately so Bun doesn't dump unhandled ECONNREFUSED
                // before the multiplexer wires its own listener.
                sock.on?.("error", () => {
                    /* handled via multiplexer 'error' */
                });
                return sock as any;
            },
            protocolType: "node-to-node",
        });

        this.chainSyncClient = new ChainSyncClient(this.mplexer);
        this.blockFetchClient = new BlockFetchClient(this.mplexer);
        this.keepAliveClient = new KeepAliveClient(this.mplexer);
        this.peerSharingClient = new PeerSharingClient(this.mplexer);
        this.sharedMempool = GlobalSharedMempool.getInstance();
        this.txSubmitClient = new TxSubmitClient(
            this.mplexer,
            this.sharedMempool,
        );
        this.txSubmitServer = new GerolamoTxSubmitServer(this.mplexer);
        this.cookieCounter = 0;
        this.peerSlotNumber = null;
        this.keepAliveInterval = null;

        // Peer death must demote, not kill the whole node process.
        this.mplexer.on("error", (err) => {
            const failure = classifyPeerNetError(err, this.peerKey);
            if (failure.expected) logger.warn(failure.line);
            else logger.error(`Multiplexer error for peer ${this.peerId}:`, err);
            this.terminate(failure.line);
        });
        this.mplexer.on("data", (_data) => {
            // logger.debug(`Multiplexer data for peer ${this.peerId}:`, toHex(data));
        });

        this.chainSyncClient.on("error", (error) => {
            logger.error(
                `ChainSyncClient error for peer ${this.peerId}:`,
                error,
            );
        });

        this.blockFetchClient.on("error", (error) => {
            logger.error(
                `BlockFetchClient error for peer ${this.peerId}:`,
                error,
            );
        });
        this.keepAliveClient.on("error", (err) => {
            logger.error(`KeepAliveClient error for peer ${this.peerId}:`, err);
        });

        this.txSubmitClient.on("requestTxs", (_requestTxs) => {
            // logger.mempool(`TxSubmitClient requestTxs for peer ${this.peerId}:`, requestTxs);
        });
        this.txSubmitClient.on("requestTxIds", (_requestTxIds) => {
            // logger.mempool(`TxSubmitClient requestTxIds for peer ${this.peerId}:`, requestTxIds);
        });
    }

    terminate(reason?: string) {
        if (this.terminated) return;
        this.terminated = true;
        logger.info(`Terminating connections for peer ${this.peerId}...`);
        this.stopSyncLoop();
        try {
            this.transportSocket?.destroy();
        } catch {
            /* */
        } finally {
            this.transportSocket = undefined;
        }
        try {
            this.chainSyncClient.done();
        } catch {
            /* */
        }
        try {
            this.blockFetchClient.done();
        } catch {
            /* */
        }
        try {
            this.keepAliveClient.done();
        } catch {
            /* */
        }
        try {
            this.peerSharingClient.done();
        } catch {
            /* */
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        try {
            this.mplexer.close();
        } catch {
            /* */
        }
        // Notify after local cleanup so manager can detach safely.
        try {
            this.onTerminate?.(this.peerId, this.peerKey, reason);
        } catch (err) {
            logger.error(`onTerminate handler error for ${this.peerId}:`, err);
        }
    }

    async handShakePeer() {
        if (this.terminated) {
            throw new Error(`peer ${this.peerKey} already terminated`);
        }
        const handshake = new HandshakeClient(this.mplexer);

        handshake.on("error", (err) => {
            const failure = classifyPeerNetError(err, this.peerKey);
            if (failure.expected) logger.warn(`handshake ${failure.line}`);
            else logger.error(`Handshake error for peer ${this.peerId}:`, err);
            this.terminate(failure.line);
        });

        const handshakeResult = await new Promise<
            HandshakeAcceptVersion | Awaited<ReturnType<HandshakeClient["propose"]>>
        >((resolve, reject) => {
            const onMuxError = (err: Error) => {
                this.mplexer.off("error", onMuxError);
                reject(err);
            };
            this.mplexer.on("error", onMuxError);
            handshake
                .propose({
                    networkMagic: this.config.networkMagic,
                    // Spec: only a node reachable at its connecting address may
                    // advertise PeerSharing / act as responder (see nodeRole.ts).
                    initiatorOnlyDiffusionMode: initiatorOnly(this.config),
                    peerSharing: peerSharingAdvertised(this.config),
                    query: false,
                })
                .then((result) => {
                    this.mplexer.off("error", onMuxError);
                    resolve(result);
                })
                .catch((err) => {
                    this.mplexer.off("error", onMuxError);
                    reject(err);
                });
        });

        if (!(handshakeResult instanceof HandshakeAcceptVersion)) {
            logger.error(
                `Handshake failed for peer ${this.peerId}:`,
                handshakeResult.toCbor(),
            );
            throw new Error("Handshake failed");
        }

        const vd: any = (handshakeResult as any).versionData;
        this.peerSharingNegotiated = vd?.peerSharing === true;
        logger.debug(
            `Handshake success for peer ${this.peerId} (version ${String((handshakeResult as any).versionNumber ?? "?")}, peerSharing ${this.peerSharingNegotiated ? "on" : "off"})`,
        );
    }

    notePeerTip(point: ChainPoint | undefined | null): void {
        const slot = point?.blockHeader?.slotNumber;
        if (slot == null) return;
        const n = Number(slot);
        if (Number.isFinite(n)) this.peerSlotNumber = n;
    }

    async syncToTip(): Promise<ChainPoint> {
        logger.debug(`Starting chain sync for peer ${this.peerId}...`);

        // Spec §3.7: empty FindIntersect → IntersectNotFound(tip); read-pointer stays at genesis.
        const intersectEmpty = await this.chainSyncClient.findIntersect([]);
        const peerTipPoint = intersectEmpty.tip.point;
        this.notePeerTip(peerTipPoint);

        let dbTipPoint: ChainPoint | null = null;
        try {
            const maxSlot = await getMaxSlot();
            if (maxSlot > 0n) {
                const row = await getBlockBySlot(maxSlot);
                // getBlockBySlot uses sql`…`.values(): rows are positional arrays
                // (…, slot, block_hash, …) — index 3 is block_hash. Tolerate objects.
                const rawHash = Array.isArray(row)
                    ? row[3]
                    : (row?.block_hash ?? row?.hash);
                const hashBytes = asBlockHashBytes(rawHash);
                if (row && hashBytes) {
                    dbTipPoint = new ChainPoint({
                        blockHeader: {
                            slotNumber: maxSlot,
                            hash: hashBytes,
                        },
                    });
                }
            }
        } catch (err) {
            logger.warn(`Failed to get DB tip for peer ${this.peerId}:`, err);
        }

        const mode = pickChainSyncStart({
            hasDbTip: !!dbTipPoint,
            syncFromTip: !!this.config.syncFromTip,
            syncFromGenesis: !!this.config.syncFromGenesis,
            syncFromPoint: !!this.config.syncFromPoint,
        });

        if (mode === "genesis") {
            logger.info(
                `Booting ChainSync from genesis for ${this.peerId} (producer read-pointer stays at origin; producer tip ${peerTipPoint.blockHeader?.slotNumber ?? "?"})`,
            );
            return peerTipPoint;
        }

        let startPoint: ChainPoint;
        if (mode === "resume" && dbTipPoint) {
            startPoint = dbTipPoint;
            logger.info(`Resuming ChainSync at DB tip for ${this.peerId}...`);
        } else if (mode === "point") {
            startPoint = dbTipPoint || new ChainPoint({
                blockHeader: {
                    slotNumber: this.config.syncFromPointSlot,
                    hash: fromHex(this.config.syncFromPointBlockHash),
                },
            });
            logger.info(`Syncing from point for peer ${this.peerId}...`);
        } else {
            logger.info(`Syncing to tip for peer ${this.peerId}...`);
            startPoint = dbTipPoint || peerTipPoint;
        }

        const intersectResult = await this.chainSyncClient.findIntersect([
            startPoint,
        ]);
        this.notePeerTip(intersectResult.tip.point);
        if (intersectResult instanceof ChainSyncIntersectFound) {
            const bh = intersectResult.point.blockHeader;
            this.csIntersect = bh ? { slot: BigInt(bh.slotNumber), hash: toHex(bh.hash) } : null;
            logger.debug(
                `Intersect found at slot ${intersectResult.point.blockHeader?.slotNumber} for peer ${this.peerId}`,
            );
        } else {
            this.csIntersect = null;
            logger.warn(
                `No intersect found for peer ${this.peerId}, proceeding with producer tip`,
            );
        }
        logger.info(`Got chain sync for peer ${this.peerId}`);
        return intersectResult.tip.point;
    }

    /**
     * Hot tier: ChainSync rollForward loop.
     * Idempotent — warm peers call this only on promote.
     */
    async startSyncLoop(): Promise<void> {
        if (this.terminated) {
            throw new Error(`Cannot start sync on terminated peer ${this.peerKey}`);
        }
        if (this.syncLoopStarted) {
            logger.debug(`Sync loop already running for ${this.peerId}`);
            return;
        }
        this.syncLoopStarted = true;
        this.isSyncing = true;
        logger.debug(`Starting sync loop for peer ${this.peerId}...`);

        const configuredBatchSize = Number(
            this.config.blockFetchBatch?.maxBlocks ?? 32,
        );
        const configuredFlushMs = Number(
            this.config.blockFetchBatch?.flushMs ?? 25,
        );
        const maxItems = Math.min(
            256,
            Math.max(
                1,
                Number.isFinite(configuredBatchSize)
                    ? Math.trunc(configuredBatchSize)
                    : 32,
            ),
        );
        const flushMs = Math.max(
            0,
            Number.isFinite(configuredFlushMs) ? configuredFlushMs : 25,
        );
        this.csPipeline = new ChainSyncPipeline({
            maxDepth: Number(this.config.blockFetchBatch?.pipelineDepth ?? 32),
        });
        this.rollForwardBatcher = new RollForwardBatcher({
            maxItems,
            flushMs,
            onBatch: async (items) => {
                if (this.onRollForwardBatch) {
                    await this.onRollForwardBatch(this.peerId, items);
                    return;
                }
                for (const item of items) {
                    await this.onRollForward?.(
                        this.peerId,
                        item.rollForwardCborBytes,
                        item.tip,
                    );
                }
            },
            onError: (error) => {
                logger.error(
                    `rollForward batch failed for ${this.peerId}:`,
                    error,
                );
                this.terminate("rollForward batch failed");
            },
        });

        this.chainSyncClient.on(
            "rollForward",
            async (rollForward: ChainSyncRollForward) => {
                if (!this.isSyncing || this.terminated) return;
                this.lastRollForwardAt = Date.now();
                this.notePeerTip(rollForward.tip.point);
                const tip =
                    rollForward.tip.point.blockHeader?.slotNumber ?? 0n;
                this.csPipeline?.noteReply();
                if (this.csDraining) return; // stale reply from before a restart
                const rollForwardCborBytes = rollForward.toCborBytes();
                this.csIntersect = null; // positioned: later rollbacks are real
                try {
                    // Back-pressure: resolves late only when the header batch is full
                    // and consensus is still busy with the previous one.
                    await this.rollForwardBatcher?.push({
                        rollForwardCborBytes,
                        tip: BigInt(tip),
                    });
                    this.chainSyncTopUp();
                } catch (err) {
                    logger.error(
                        `rollForward/requestNext failed for ${this.peerId}:`,
                        err,
                    );
                    this.terminate("rollForward/requestNext failed");
                }
            },
        );

        // MsgAwaitReply: the server has nothing newer — we are at its tip, so
        // stop stacking requests (depth 1) until it pulls ahead again.
        this.chainSyncClient.on("awaitReply", () => {
            this.csPipeline?.noteAwaitReply();
        });

        this.chainSyncClient.on(
            "rollBackwards",
            async (rollBack: ChainSyncRollBackwards) => {
                if (!this.isSyncing || this.terminated) return;
                if (!rollBack.point.blockHeader) {
                    // MsgRollBackward(origin): the producer's first reply when
                    // the read pointer starts at genesis (spec §3.7). Nothing
                    // to undo locally — keep the loop going or sync stalls.
                    logger.debug(
                        `rollBack to origin for peer ${this.peerId} (genesis boot)`,
                    );
                    this.notePeerTip(rollBack.tip.point);
                    this.csPipeline?.noteReply();
                    try {
                        this.rollForwardBatcher?.reset();
                        await this.rollForwardBatcher?.drain();
                        this.chainSyncTopUp();
                    } catch (err) {
                        logger.error(
                            `requestNext (origin rollback) failed for ${this.peerId}:`,
                            err,
                        );
                        this.terminate("requestNext (origin rollback) failed");
                    }
                    return;
                }
                const tip = rollBack.tip.point;
                logger.debug(
                    `rollBack tip for peer ${this.peerId}`,
                    tip.blockHeader?.slotNumber,
                );

                this.csPipeline?.noteReply();
                if (this.csDraining) return;
                // Spec §3.7: the first reply after FindIntersect is MsgRollBackward to the
                // intersection itself. That positions this peer's read pointer; it says
                // nothing about our chain and must not trigger a local rollback.
                const bh = rollBack.point.blockHeader;
                if (
                    this.csIntersect && bh &&
                    BigInt(bh.slotNumber) === this.csIntersect.slot &&
                    toHex(bh.hash) === this.csIntersect.hash
                ) {
                    this.csIntersect = null;
                    logger.debug(`Initial positioning rollback to intersection slot ${bh.slotNumber} for ${this.peerId} (ignored)`);
                    this.chainSyncTopUp();
                    return;
                }
                try {
                    this.rollForwardBatcher?.reset();
                    await this.rollForwardBatcher?.drain();
                    await this.onRollBack?.(this.peerId, rollBack.point);
                    this.chainSyncTopUp();
                } catch (err) {
                    logger.error(
                        `requestNext (rollback) failed for ${this.peerId}:`,
                        err,
                    );
                }
            },
        );

        this.chainSyncClient.on("error", (error: any) => {
            logger.error(
                `ChainSyncClient error for peer ${this.peerId}:`,
                error,
            );
        });

        await this.syncToTip();
        this.chainSyncTopUp();
    }

    /**
     * Send as many MsgRequestNext as the pipeline allows (network-spec §3.7
     * permits pipelining; replies arrive in order and are handled by the
     * `rollForward` / `rollBackwards` listeners above). The per-call promise
     * from the library is intentionally not awaited — it resolves on the next
     * reply regardless of which request it answers.
     */
    private chainSyncTopUp(): void {
        if (!this.isSyncing || this.terminated || !this.csPipeline) return;
        const n = this.csPipeline.toSend();
        for (let i = 0; i < n; i++) {
            try {
                void this.chainSyncClient.requestNext();
                this.csPipeline.noteSent(1);
            } catch (err) {
                logger.error(`requestNext failed for ${this.peerId}:`, err);
                this.terminate("requestNext failed");
                return;
            }
        }
    }

    /**
     * Re-run FindIntersect from our DB tip on this connection, e.g. when a
     * verifier is promoted to primary (its stream is ahead of what we applied)
     * or when its headers stop chaining onto our tip.
     *
     * Pipelined RequestNext replies still owed by the server are drained first:
     * the client only has agency to send FindIntersect when nothing is
     * outstanding (network-spec §3.7). If the drain does not finish in time
     * the connection is dropped and the governor reconnects it.
     */
    async restartChainSync(reason: string): Promise<void> {
        if (this.terminated || !this.isSyncing) return;
        logger.info(`Restarting ChainSync from DB tip for ${this.peerId}: ${reason}`);
        this.csDraining = true;
        this.rollForwardBatcher?.reset();
        const deadline = Date.now() + 30_000;
        while ((this.csPipeline?.inFlight ?? 0) > 0 && Date.now() < deadline && !this.terminated) {
            await new Promise((r) => setTimeout(r, 25));
        }
        if (this.terminated) return;
        if ((this.csPipeline?.inFlight ?? 0) > 0) {
            this.terminate("chainsync restart: drain timed out");
            return;
        }
        this.csDraining = false;
        this.stopSyncLoop();
        try {
            await this.startSyncLoop();
        } catch (err) {
            logger.error(`ChainSync restart failed for ${this.peerId}:`, err);
            this.terminate("chainsync restart failed");
        }
    }

    /** Pipelined ChainSync requests currently in flight (for /metrics). */
    get chainSyncInFlight(): number {
        return this.csPipeline?.inFlight ?? 0;
    }

    /**
     * Demote hot → warm: stop ChainSync listeners, keep bearer + keepalive.
     */
    stopSyncLoop(): void {
        if (!this.syncLoopStarted && !this.isSyncing) return;
        logger.debug(`Stopping sync loop for ${this.peerId}`);
        this.isSyncing = false;
        this.syncLoopStarted = false;
        this.rollForwardBatcher?.dispose();
        this.rollForwardBatcher = undefined;
        this.csPipeline?.reset();
        this.csPipeline = null;
        this.csDraining = false;
        try {
            this.chainSyncClient.removeAllListeners("awaitReply");
            this.chainSyncClient.removeAllListeners("rollForward");
            this.chainSyncClient.removeAllListeners("rollBackwards");
        } catch {
            /* */
        }
    }

    async fetchBlock(
        slot: number | bigint,
        blockHash: Uint8Array,
    ): Promise<BlockFetchNoBlocks | BlockFetchBlock> {
        const chainPoint = new ChainPoint({
            blockHeader: { slotNumber: slot, hash: blockHash },
        });
        const blockData = await this.blockFetchClient.request(chainPoint);
        return blockData;
    }

    /** Fetch one inclusive contiguous range using its first and last points. */
    async fetchBlockRange(
        points: ChainPoint[],
    ): Promise<BlockFetchNoBlocks | BlockFetchBlock[]> {
        if (points.length === 0) return [];
        const timeoutMs = Math.max(
            1,
            Number(this.config?.blockFetchBatch?.rangeTimeoutMs ?? 55_000),
        );
        const label = `BlockFetch range ${this.peerId}`;
        return await withTimeout(
            this.blockFetchClient.requestRange(
                points[0]!,
                points[points.length - 1]!,
            ),
            timeoutMs,
            label,
            () => this.terminate(`${label} timed out after ${timeoutMs}ms`),
        );
    }

    /** @deprecated use fetchBlockRange; retained for callers outside this repo. */
    async fetchMultipleBlocks(
        points: ChainPoint[],
    ): Promise<BlockFetchNoBlocks | BlockFetchBlock[]> {
        return await this.fetchBlockRange(points);
    }

    async askForPeers(amount = 10): Promise<PeerAddress[]> {
        if (!this.peerSharingNegotiated) {
            throw new Error(`peer ${this.peerKey} did not negotiate PeerSharing`);
        }
        logger.debug(`Requesting peers from peer ${this.peerId}...`);
        const peerResponse = await this.peerSharingClient.request(amount);
        logger.debug(
            `Received peers from peer ${this.peerId}:`,
            peerResponse.peerAddresses.length,
        );
        if (!(peerResponse instanceof PeerSharingResponse)) {
            throw new Error("Invalid PeerSharingResponse");
        }

        return peerResponse.peerAddresses;
    }

    async submitToSharedMempool(txCbor: Uint8Array): Promise<any> {
        if (txCbor.length === 0) {
            throw new Error("Empty transaction CBOR");
        }
        logger.mempool("Validating TX before submission to shared mempool...", {
            txCbor: Array.from(txCbor).slice(0, 16),
        });
        const tx = Tx.fromCbor(txCbor);
        if (tx.body instanceof TxBody === false) {
            throw new Error("Invalid TX: body is not TxBody");
        }
        logger.mempool("TX validated, submitting to shared mempool...", {
            txId: toHex(tx.body.hash.toBuffer()),
        });
        try {
            const result = await this.txSubmitClient.mempool.append(
                tx.body.hash.toBuffer(),
                tx.toCborBytes(),
            );
            logger.mempool(
                `Tx submission result from peer ${this.peerId}`,
                result,
            );
            return result;
        } catch (e) {
            logger.mempool(`Failed to submit tx to peer ${this.peerId}`, e);
            throw e;
        }
    }

    /**
     * KeepAlive keeps a warm connection alive on the *server's* terms:
     * cardano-node's inbound governor closes a connection on which no
     * mini-protocol has started within ~5 s (RemoteIdle timeout). The first
     * request therefore goes out immediately after the handshake, and the
     * cadence matches cardano-node's own 10 s keepAliveInterval. (Measured on
     * mainnet backbone relays: warm peers were reset 3–5 s after handshake
     * when the first keep-alive waited 60 s.)
     */
    startKeepAlive(interval: number = 10_000) {
        if (this.keepAliveInterval) return;
        const tick = () => {
            if (this.terminated) return;
            this.cookieCounter = (this.cookieCounter + 1) % 65536;
            logger.debug(
                `Sending keepAliveRequest cookie for peer ${this.peerId}:`,
                this.cookieCounter,
            );
            try {
                this.keepAliveClient.request(this.cookieCounter);
            } catch (err) {
                logger.error(
                    `keepAlive request failed for ${this.peerId}:`,
                    err,
                );
            }
        };
        tick();
        this.keepAliveInterval = setInterval(tick, interval);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }
}
