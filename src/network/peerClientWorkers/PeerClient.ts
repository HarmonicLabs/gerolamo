import { BlockFetchBlock, BlockFetchClient, BlockFetchNoBlocks, ChainPoint, ChainSyncClient, ChainSyncIntersectFound, ChainSyncIntersectNotFound, ChainSyncRollBackwards, ChainSyncRollForward, HandshakeAcceptVersion, HandshakeClient, KeepAliveClient, KeepAliveResponse, Multiplexer, PeerSharingClient, PeerSharingResponse } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { connect } from "node:net";
import { logger } from "../../utils/logger";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";
import type { ShelleyGenesisConfig } from "../../types/ShelleyGenesisTypes";
import { parentPort } from "worker_threads";
import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { DB } from "../../db/DB";
import { getShelleyGenesisConfig } from "../../utils/paths";

export interface IPeerClient {
    host: string;
    port: number | bigint;
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
    db: DB;
}

export class PeerClient implements IPeerClient {
    readonly host: string;
    readonly port: number | bigint;
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
    private isRangeSyncComplete: boolean = false;
    shelleyGenesisConfig: ShelleyGenesisConfig;
    db: DB;
    
    constructor(
        host: string,
        port: number | bigint,
        config: GerolamoConfig,
    ) {
        this.host = host;
        this.port = port;
        this.config = config;
        const unixTimestamp = Math.floor(Date.now() / 1000);
        this.peerId = `${host}:${port}:${unixTimestamp}`; // Set after host/port
        this.shelleyGenesisConfig = {} as ShelleyGenesisConfig;
        this.db = new DB(this.config.dbPath);

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

        this.mplexer.on("error", (err) => {
            logger.error(`Multiplexer error for peer ${this.peerId}:`, err);
            this.terminate();
            process.exit(1);
        });
        this.mplexer.on("data", (data) => {
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

        // this.keepAliveClient.on("response", (response: KeepAliveResponse) => {
        //     logger.debug(
        //         `KeepAliveResponse received for peer ${this.peerId}:`,
        //         response,
        //     );
        // });
        this.keepAliveClient.on("error", (err) => {
            logger.error(`KeepAliveClient error for peer ${this.peerId}:`, err);
        });

        process.on("beforeExit", () => {
            this.terminate();
        });
    }

    terminate() {
        logger.info(`Terminating connections for peer ${this.peerId}...`);
        this.chainSyncClient.removeAllListeners("rollForward");
        this.chainSyncClient.removeAllListeners("rollBackwards");
        logger.debug(`Removed all ChainSyncClient listeners for peer ${this.peerId}` );
        this.chainSyncClient.done();
        this.blockFetchClient.done();
        this.keepAliveClient.done();
        this.peerSharingClient.done();
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        this.mplexer.close();
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
                handshakeResult,
            );
            throw new Error("Handshake failed");
        }

        logger.debug(`Handshake success for peer ${this.peerId}`);
        // return "handshake success";
    };

    async syncToTip(): Promise<ChainPoint> {
        logger.debug(`Starting chain sync for peer ${this.peerId}...`);

        // Get peer's tip
        const intersectEmpty = await this.chainSyncClient.findIntersect([]);
        const peerTipPoint = intersectEmpty.tip.point;

        // Get DB tip
        let dbTipPoint: ChainPoint | null = null;
        try {
            const maxSlot = await this.db.getMaxSlot();
            if (maxSlot > 0n) {
                const row = this.db.getBlockBySlot(maxSlot);
                if (row) {
                    dbTipPoint = new ChainPoint({
                        blockHeader: {
                            slotNumber: maxSlot,
                            hash: fromHex(row.block_hash)
                        }
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
                    hash: fromHex(this.config.syncFromPointBlockHash)
                }
            });
        } else {
            // syncFromTip (default)
            startPoint = dbTipPoint || new ChainPoint({});
        };

        if (!this.config.syncFromTip && !this.config.syncFromPoint) {
            throw new Error("Invalid sync configuration: enable syncFromTip or syncFromPoint");
        };

        const intersectResult = await this.chainSyncClient.findIntersect([startPoint]);
        if (intersectResult instanceof ChainSyncIntersectFound) {
            logger.debug(`Intersect found at slot ${intersectResult.point.blockHeader?.slotNumber} for peer ${this.peerId}`);
        } else {
            logger.warn(`No intersect found for peer ${this.peerId}, proceeding with tip`);
        };
        return intersectResult.tip.point;
    };

    // starts sync loop for all peers in parrallel
    async startSyncLoop(): Promise<void> {
        let timeout = 83;
        logger.debug(`Starting sync loop for peer ${this.peerId}...`);
        this.chainSyncClient.on("rollForward", async (rollForward: ChainSyncRollForward) => {
            const tip = rollForward.tip.point.blockHeader?.slotNumber;
            const rollForwardCborBytes = rollForward.toCborBytes();
            if (parentPort) parentPort.postMessage({
                    type: "rollForward",
                    peerId: this.peerId,
                    rollForwardCborBytes: rollForwardCborBytes,
                    tip: tip
            });
            
                setTimeout(async () => {
                    await this.chainSyncClient.requestNext();
                }, timeout);
        });

        this.chainSyncClient.on( "rollBackwards", async (rollBack: ChainSyncRollBackwards) => {
                if (!rollBack.point.blockHeader) return;
                const tip = rollBack.tip.point;
                logger.debug(
                    `Rolled back tip for peer ${this.peerId}`,
                    tip.blockHeader?.slotNumber,
                );
                if (parentPort) {
                    parentPort.postMessage({
                        type: "rollBack",
                        peerId: this.peerId,
                        point: rollBack.point,
                    });
                }
                setTimeout(async () => {
                    await this.chainSyncClient.requestNext();
                }, timeout);
            },
        );

        this.chainSyncClient.on("error", (error: any) => {
            logger.error(
                `ChainSyncClient error for peer ${this.peerId}:`,
                error,
            );
        });

        await this.syncToTip();
        setTimeout(async () => {
            await this.chainSyncClient.requestNext();
        }, timeout);
    }

    async fetchBlock(
        slot: number | bigint,
        blockHash: Uint8Array,
    ): Promise<BlockFetchNoBlocks | BlockFetchBlock> {
        // logger.debug(`Peer: ${this.peerId}...`, `Fetching Block `, { slot, hash: toHex(blockHash)} );
        const chainPoint = new ChainPoint({
            blockHeader: { slotNumber: slot, hash: blockHash },
        });
        // logger.debug(`Fetching block at chain point for peer ${this.peerId}:`, chainPoint);
        const blockData = await this.blockFetchClient.request(chainPoint);
        // logger.debug(`Fetched block at slot ${slot} for peer ${this.peerId}`);
        return blockData;
    };

    async fetchMultipleBlocks(points: ChainPoint[]): Promise<any[]> {
        /* Not tested yet */
        // logger.debug(`Peer: ${this.peerId}...`, `Fetching multiple blocks`, points.map(p => ({ slot: p.blockHeader?.slotNumber, hash: p.blockHeader?.hash ? toHex(p.blockHeader.hash) : undefined })) );
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

    async askForPeers(): Promise<PeerAddress[]> {
        logger.debug(`Requesting peers from peer ${this.peerId}...`);
        const peerResponse = await this.peerSharingClient.request(10);
        logger.debug(
            `Received peers from peer ${this.peerId}:`,
            peerResponse.peerAddresses.length,
        );
        if (
            !(
                peerResponse instanceof PeerSharingResponse
            )
        ) throw new Error("Invalid PeerSharingResponse");

        return peerResponse.peerAddresses;
    }

    startKeepAlive(interval: number = 60000) {
        this.keepAliveInterval = setInterval(() => {
            this.cookieCounter = (this.cookieCounter + 1) % 65536;
            // logger.debug(
            //     `Sending keepAliveRequest cookie for peer ${this.peerId}:`,
            //     this.cookieCounter,
            // );
            this.keepAliveClient.request(this.cookieCounter);
        }, interval);
    }
};
