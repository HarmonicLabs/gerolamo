import { BlockFetchBlock, TxSubmitClient, BlockFetchClient, BlockFetchNoBlocks, ChainPoint, ChainSyncClient, ChainSyncIntersectFound, ChainSyncIntersectNotFound, ChainSyncRollBackwards, ChainSyncRollForward, HandshakeAcceptVersion, HandshakeClient, KeepAliveClient, KeepAliveResponse, Multiplexer, PeerSharingClient, PeerSharingResponse } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { connect } from "node:net";
import { logger } from "../../utils/logger";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";
import type { ShelleyGenesisConfig } from "../../types/ShelleyGenesisTypes";
import { parentPort } from "worker_threads";
import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { DB } from "../../db/DB";
import { getShelleyGenesisConfig } from "../../utils/paths";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { GlobalSharedMempool } from "../SharedMempool";
import { SharedMempool } from "@harmoniclabs/shared-cardano-mempool-ts";
import { TxBody, Tx } from "@harmoniclabs/cardano-ledger-ts";
import { GerolamoTxSubmitServer } from "../TxSubmitServer";

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
    sharedMempool: SharedMempool;
    txSubmitServer: GerolamoTxSubmitServer;
    onTerminate?: (peerId: string) => void;
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
    readonly txSubmitClient!: TxSubmitClient;
    readonly txSubmitServer!: GerolamoTxSubmitServer;
    readonly sharedMempool: SharedMempool;
    readonly onTerminate?: (peerId: string) => void;

    constructor(
        host: string,
        port: number | bigint,
        config: GerolamoConfig,
        onTerminate?: (peerId: string) => void
    ) {
        this.host = host;
        this.port = port;
        this.config = config;
        const unixTimestamp = Math.floor(Date.now() / 1000);
        this.peerId = `${host}:${port}:${unixTimestamp}`; // Set after host/port
        this.onTerminate = onTerminate;
        this.shelleyGenesisConfig = {} as ShelleyGenesisConfig;
        this.db = new DB(this.config.dbPath);

        this.mplexer = new Multiplexer({
            connect: () => {
                logger.info(`Attempt connection to peer ${this.peerId}`);
                return connect({ host, port: Number(port) }) as any;
            },
            protocolType: "node-to-node",
        });

        //* Load up the mini protocols /w mplexer *//
        this.chainSyncClient    =  new ChainSyncClient( this.mplexer );
        this.blockFetchClient   = new BlockFetchClient( this.mplexer);
        this.keepAliveClient    =  new KeepAliveClient( this.mplexer );
        this.peerSharingClient  = new PeerSharingClient( this.mplexer );
        this.sharedMempool      = GlobalSharedMempool.getInstance();
        this.txSubmitClient      = new TxSubmitClient(this.mplexer, this.sharedMempool);
        this.txSubmitServer     = new GerolamoTxSubmitServer(this.mplexer);
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

        this.txSubmitClient.on("requestTxs", (requestTxs) => {
            // logger.mempool(`TxSubmitClient requestTxs for peer ${this.peerId}:`, requestTxs);
        });
        this.txSubmitClient.on("requestTxIds", (requestTxIds) => {
            // logger.mempool(`TxSubmitClient requestTxIds for peer ${this.peerId}:`, requestTxIds);
        });

        process.on("beforeExit", () => {
            this.terminate();
        });
    };

    terminate() {
        logger.info(`Terminating connections for peer ${this.peerId}...`);
        if (this.onTerminate) this.onTerminate(this.peerId);
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
                handshakeResult.toCbor(),
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
            logger.info(`Syncing to tip for peer ${this.peerId}...`);
            startPoint = dbTipPoint || peerTipPoint;
        };

        if (!this.config.syncFromTip && !this.config.syncFromPoint) {
            throw new Error("Invalid sync configuration: enable syncFromTip or syncFromPoint");
        };
        // logger.info(`Finding intersect from point for peer ${this.peerId}:`, startPoint);
        const intersectResult = await this.chainSyncClient.findIntersect([startPoint]);
        // logger.info(`Intersect result for peer ${this.peerId}:`, intersectResult);
        if (intersectResult instanceof ChainSyncIntersectFound) {
            logger.debug(`Intersect found at slot ${intersectResult.point.blockHeader?.slotNumber} for peer ${this.peerId}`);
        } else {
            logger.warn(`No intersect found for peer ${this.peerId}, proceeding with tip`);
        };
        logger.info(`Got chain sync for peer ${this.peerId}`);
        return intersectResult.tip.point;
    };

    // starts sync loop for all peers in parrallel
    async startSyncLoop(): Promise<void> {
        let timeout = 0;
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
            await this.chainSyncClient.requestNext();    
        });

        this.chainSyncClient.on( "rollBackwards", async (rollBack: ChainSyncRollBackwards) => {
                if (!rollBack.point.blockHeader) return;
                const tip = rollBack.tip.point;
                logger.debug(
                    `rollBack tip for peer ${this.peerId}`,
                    tip.blockHeader?.slotNumber,
                );
                if (parentPort) {
                    parentPort.postMessage({
                        type: "rollBack",
                        peerId: this.peerId,
                        point: rollBack.point,
                    });
                }
                
                await this.chainSyncClient.requestNext();
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

    async askForPeers(): Promise<PeerAddress[]> 
    {
        logger.debug(`Requesting peers from peer ${this.peerId}...`);
        const peerResponse = await this.peerSharingClient.request(10);
        logger.debug(
            `Received peers from peer ${this.peerId}:`,
            peerResponse.peerAddresses.length,
        );
        if (!(peerResponse instanceof PeerSharingResponse)) throw new Error("Invalid PeerSharingResponse");

        return peerResponse.peerAddresses;
    };

    async submitToSharedMempool(txCbor: Uint8Array): Promise<any> {
        txCbor = fromHex("84a600d9010281825820e297c765cd2cec4d62924b82bed85a5a031d5d565328d082a6e6012ee0480cb101018282583900d82e5937b38a75b67a38d727ac7ba5f1c4eed19df5e651afe017ba36a6219834e01485810ee3dd60c39823b10e63f4bfadbc6fa0120db2791a0098968082583900d82e5937b38a75b67a38d727ac7ba5f1c4eed19df5e651afe017ba36a6219834e01485810ee3dd60c39823b10e63f4bfadbc6fa0120db2791b000000015696c907021a0002aac1031a06bc425905a1581de0a6219834e01485810ee3dd60c39823b10e63f4bfadbc6fa0120db2791a138f492f0801a100d9010282825820bf38993dbe4544e73d1acbe8c0cf60b5c559e422e0934ee8ff7e2b4d98f80fbe5840776d98092222a4848c7b136a43f3514816f7d535186d06e2d11dba43336aaa1db39e18ca2d86e3e56d243e417715295d089e22bade4548504f1cabdfc7b12d09825820124dc25cf49dd19052bc1bda9e40b4bd2c4ffb94110938eee2fd467aa124407e584003a39235e932e0db907378fd6cd5af60a18cfff2cf3535a6be6af28e10441671838fd2f651d9e130031ecde54eb7f735616a36501d0b2488ee75dd67700dea0bf5f6");
        logger.mempool("Validating TX before submission to shared mempool...", { txCbor: Array.from(txCbor).slice(0, 16) });
        const tx = Tx.fromCbor(txCbor);
        if(tx.body instanceof TxBody === false) {
            throw new Error("Invalid TX: body is not TxBody");
        };
        logger.mempool("TX validated, submitting to shared mempool...", { txId: toHex(tx.body.hash.toBuffer()) });
        try {
            const result = await this.txSubmitClient.mempool.append(
                tx.body.hash.toBuffer(),
                tx.toCborBytes()
            );
            logger.mempool(`Tx submission result from peer ${this.peerId}`, result);
            return result;
        } catch (e) {
            logger.mempool(`Failed to submit tx to peer ${this.peerId}`, e);
            throw e;
        };
    };
    
    startKeepAlive(interval: number = 60000) {
        this.keepAliveInterval = setInterval(() => {
            this.cookieCounter = (this.cookieCounter + 1) % 65536;
            logger.debug(
                 `Sending keepAliveRequest cookie for peer ${this.peerId}:`,
                 this.cookieCounter,
            );
            this.keepAliveClient.request(this.cookieCounter);
        }, interval);
    }
};
