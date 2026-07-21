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
import { connect } from "node:net";
import { logger } from "../utils/logger";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import type { GerolamoConfig } from "./peerManager";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";

import { getShelleyGenesisConfig } from "../utils/paths";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { GlobalSharedMempool, type GerolamoMempool } from "./SharedMempool";
import { Tx, TxBody } from "@harmoniclabs/cardano-ledger-ts";
import { GerolamoTxSubmitServer } from "./TxSubmitServer";
import { getBlockBySlot, getMaxSlot } from "../db";
import { peerKey as makePeerKey } from "./PeerGovernor";

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
    onTerminate?: (peerId: string, peerKey: string) => void;
    onRollForward?: (
        peerId: string,
        rollForwardCborBytes: Uint8Array,
        tip: number | bigint,
    ) => void;
    onRollBack?: (peerId: string, point: any) => void;
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
    private terminated = false;
    private syncLoopStarted = false;
    isSyncing = false;
    shelleyGenesisConfig: ShelleyGenesisConfig;

    readonly txSubmitClient!: TxSubmitClient;
    readonly txSubmitServer!: GerolamoTxSubmitServer;
    onTerminate?: (peerId: string, peerKey: string) => void;
    onRollForward?: (
        peerId: string,
        rollForwardCborBytes: Uint8Array,
        tip: number | bigint,
    ) => void;
    onRollBack?: (peerId: string, point: any) => void;
    onNewPeers?: (peers: PeerAddress[]) => void;
    readonly sharedMempool: GerolamoMempool;

    constructor(
        host: string,
        port: number | bigint,
        config: GerolamoConfig,
        onTerminate?: (peerId: string, peerKey: string) => void,
    ) {
        this.host = host;
        this.port = port;
        this.config = config;
        this.peerKey = makePeerKey(host, port);
        const unixTimestamp = Math.floor(Date.now() / 1000);
        this.peerId = `${this.peerKey}:${unixTimestamp}`;
        this.onTerminate = onTerminate;
        this.shelleyGenesisConfig = {} as ShelleyGenesisConfig;

        this.mplexer = new Multiplexer({
            connect: () => {
                logger.info(`Attempt connection to peer ${this.peerId}`);
                return connect({ host, port: Number(port) }) as any;
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

        getShelleyGenesisConfig(this.config)
            .then((cfg) => {
                this.shelleyGenesisConfig = cfg;
            })
            .catch((err) => {
                logger.error(
                    `Failed to load Shelley genesis config for peer ${this.peerId}:`,
                    err,
                );
            });

        // Peer death must demote, not kill the whole node process.
        this.mplexer.on("error", (err) => {
            logger.error(`Multiplexer error for peer ${this.peerId}:`, err);
            this.terminate();
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

    terminate() {
        if (this.terminated) return;
        this.terminated = true;
        logger.info(`Terminating connections for peer ${this.peerId}...`);
        this.stopSyncLoop();
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
            this.onTerminate?.(this.peerId, this.peerKey);
        } catch (err) {
            logger.error(`onTerminate handler error for ${this.peerId}:`, err);
        }
    }

    async handShakePeer() {
        const handshake = new HandshakeClient(this.mplexer);

        handshake.on("error", (err) => {
            logger.error(`Handshake error for peer ${this.peerId}:`, err);
            this.terminate();
        });

        const handshakeResult = await handshake.propose({
            networkMagic: this.config.networkMagic,
            query: false,
        });

        if (!(handshakeResult instanceof HandshakeAcceptVersion)) {
            logger.error(
                `Handshake failed for peer ${this.peerId}:`,
                handshakeResult.toCbor(),
            );
            throw new Error("Handshake failed");
        }

        logger.debug(`Handshake success for peer ${this.peerId}`);
    }

    async syncToTip(): Promise<ChainPoint> {
        logger.debug(`Starting chain sync for peer ${this.peerId}...`);

        const intersectEmpty = await this.chainSyncClient.findIntersect([]);
        const peerTipPoint = intersectEmpty.tip.point;

        let dbTipPoint: ChainPoint | null = null;
        try {
            const maxSlot = await getMaxSlot();
            if (maxSlot > 0n) {
                const row = await getBlockBySlot(maxSlot);
                if (row) {
                    dbTipPoint = new ChainPoint({
                        blockHeader: {
                            slotNumber: maxSlot,
                            hash: fromHex(row.block_hash),
                        },
                    });
                }
            }
        } catch (err) {
            logger.warn(`Failed to get DB tip for peer ${this.peerId}:`, err);
        }

        let startPoint: ChainPoint;

        if (this.config.syncFromPoint) {
            startPoint = dbTipPoint || new ChainPoint({
                blockHeader: {
                    slotNumber: this.config.syncFromPointSlot,
                    hash: fromHex(this.config.syncFromPointBlockHash),
                },
            });
        } else {
            logger.info(`Syncing to tip for peer ${this.peerId}...`);
            startPoint = dbTipPoint || peerTipPoint;
        }

        if (!this.config.syncFromTip && !this.config.syncFromPoint) {
            throw new Error(
                "Invalid sync configuration: enable syncFromTip or syncFromPoint",
            );
        }
        const intersectResult = await this.chainSyncClient.findIntersect([
            startPoint,
        ]);
        if (intersectResult instanceof ChainSyncIntersectFound) {
            logger.debug(
                `Intersect found at slot ${intersectResult.point.blockHeader?.slotNumber} for peer ${this.peerId}`,
            );
        } else {
            logger.warn(
                `No intersect found for peer ${this.peerId}, proceeding with tip`,
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

        this.chainSyncClient.on(
            "rollForward",
            async (rollForward: ChainSyncRollForward) => {
                if (!this.isSyncing || this.terminated) return;
                const tip =
                    rollForward.tip.point.blockHeader?.slotNumber ?? 0n;
                const rollForwardCborBytes = rollForward.toCborBytes();
                this.onRollForward?.(this.peerId, rollForwardCborBytes, tip);
                try {
                    await this.chainSyncClient.requestNext();
                } catch (err) {
                    logger.error(
                        `requestNext failed for ${this.peerId}:`,
                        err,
                    );
                }
            },
        );

        this.chainSyncClient.on(
            "rollBackwards",
            async (rollBack: ChainSyncRollBackwards) => {
                if (!this.isSyncing || this.terminated) return;
                if (!rollBack.point.blockHeader) return;
                const tip = rollBack.tip.point;
                logger.debug(
                    `rollBack tip for peer ${this.peerId}`,
                    tip.blockHeader?.slotNumber,
                );
                this.onRollBack?.(this.peerId, rollBack.point);

                try {
                    await this.chainSyncClient.requestNext();
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
        await this.chainSyncClient.requestNext();
    }

    /**
     * Demote hot → warm: stop ChainSync listeners, keep bearer + keepalive.
     */
    stopSyncLoop(): void {
        if (!this.syncLoopStarted && !this.isSyncing) return;
        logger.debug(`Stopping sync loop for peer ${this.peerId}`);
        this.isSyncing = false;
        this.syncLoopStarted = false;
        try {
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

    async fetchMultipleBlocks(points: ChainPoint[]): Promise<any[]> {
        const blocksData: any[] = [];
        for (const point of points) {
            try {
                const blockData = await this.blockFetchClient.requestRange(
                    point,
                    point,
                );
                blocksData.push(blockData);
            } catch (error) {
                logger.error(
                    `Failed to fetch block at point for peer ${this.peerId}:`,
                    point,
                    error,
                );
            }
        }
        return blocksData;
    }

    async askForPeers(amount = 10): Promise<PeerAddress[]> {
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

    startKeepAlive(interval: number = 60000) {
        if (this.keepAliveInterval) return;
        this.keepAliveInterval = setInterval(() => {
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
        }, interval);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }
}
