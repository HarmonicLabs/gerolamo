import { BlockFetchClient, ChainPoint, ChainSyncClient, HandshakeAcceptVersion, HandshakeClient, KeepAliveClient, KeepAliveResponse, Multiplexer, PeerAddress, PeerSharingClient, PeerSharingResponse, ChainSyncRollForward, ChainSyncRollBackwards, ChainSyncIntersectFound, ChainSyncIntersectNotFound, ChainSyncFindIntersect, BlockFetchBlock, BlockFetchNoBlocks } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { connect } from "node:net";
import { logger } from "../utils/logger";
import { getLastSlot } from "./lmdbWorkers/lmdb";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { GerolamoConfig } from "./PeerManager";
import { RawNewEpochState } from "../rawNES";
import { headerValidation, blockValidation } from "./validators";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { parentPort } from "worker_threads";

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
};

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
            .then(cfg => { this.shelleyGenesisConfig = cfg; })
            .catch(err => {
                logger.error(`Failed to load Shelley genesis config for peer ${this.peerId}:`, err);
            });

        this.mplexer.on("error", (err) => {
            logger.error(`Multiplexer error for peer ${this.peerId}:`, err);
            this.terminate();
            // process.exit(1);
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

        this.keepAliveClient.on("response", (response: KeepAliveResponse) => {
            logger.debug(
                `KeepAliveResponse received for peer ${this.peerId}:`,
                response,
            );
        });
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
        logger.debug(
            `Removed all ChainSyncClient listeners for peer ${this.peerId}`,
        );
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
    }

    async syncToTip(): Promise<ChainPoint> {
        logger.debug(`Starting chain sync for peer ${this.peerId}...`);
        let intersectResult: ChainSyncIntersectFound | ChainSyncIntersectNotFound = await this.chainSyncClient.findIntersect([ new ChainPoint({})]);
        let tipPoint = intersectResult.tip.point;


        if (
            !this.config.syncFromTip && !this.config.syncFromGenesis &&
            !this.config.syncFromPoint
        ) throw new Error("Invalid sync configuration in config file");

        if (this.config.syncFromGenesis) {
            logger.debug(`Syncing from genesis for peer ${this.peerId}...`);
            const genesisBlock = new ChainPoint({
                blockHeader: {
                    slotNumber: 2n,
                    hash: fromHex(this.config.genesisBlockHash),
                },
            });
            intersectResult = await this.chainSyncClient.findIntersect([
                genesisBlock,
            ]);
        }

        if (this.config.syncFromTip) {
            const lastPointDb = await getLastSlot();
            logger.debug(`Last point in DB: `, lastPointDb);
            logger.debug(`Syncing to latest point for peer ${this.peerId}...`);
            if (
                lastPointDb &&
                lastPointDb.slot < tipPoint.blockHeader?.slotNumber!
            ) {
                tipPoint = new ChainPoint({
                    blockHeader: {
                        slotNumber: lastPointDb.slot,
                        hash: lastPointDb.hash,
                    },
                });
            }
            intersectResult = await this.chainSyncClient.findIntersect([
                tipPoint,
            ]);
        }

        if (this.config.syncFromPoint && !this.config.syncFromTip) {
            logger.debug(
                `Syncing from configured point for peer ${this.peerId}...`,
                this.config.syncFromPoint,
            );
            const newChainPoint = new ChainPoint({
                blockHeader: {
                    slotNumber: this.config.syncFromPointSlot,
                    hash: fromHex(this.config.syncFromPointBlockHash)
                }
            })
            intersectResult = await this.chainSyncClient.findIntersect([newChainPoint]);
            if (intersectResult instanceof ChainSyncIntersectNotFound) {
                throw new Error("Configured syncFromPoint not found on peer");
            };
            logger.debug("Sync from Point: Intersected at: ", intersectResult.point.blockHeader?.slotNumber)
        };

        logger.debug(`Intersect result for peer ${this.peerId}:`, intersectResult.tip.point.blockHeader?.slotNumber,
        );
        return intersectResult.tip.point; 
    }

    // starts sync loop for all peers in parrallel
    async startSyncLoop(): Promise<void> {
        logger.debug(`Starting sync loop for peer ${this.peerId}...`);
        this.chainSyncClient.on("rollForward", async (rollForward: ChainSyncRollForward) => {
            const tip = rollForward.tip.point.blockHeader?.slotNumber;
            const headerValidationRes = await headerValidation(rollForward, this.shelleyGenesisConfig);
            if (!(
                headerValidationRes
            )) {
                // logger.debug(`Validated - Era: ${multiEraHeader.era} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tip} - Percent Complete: ${((Number(slot) / Number(tip)) * 100).toFixed(2)}%`);
                await this.chainSyncClient.requestNext();
                return;
            };
            if (parentPort) {
                // parentPort.postMessage({ type: "storeHeader", peerId: this.peerId, slot: headerValidationRes.slot, blockHeaderHash: headerValidationRes.blockHeaderHash, headerData: headerValidationRes.headerData });
                parentPort.postMessage({
                    type: "headerValidated",
                    peerId: this.peerId,
                    era: headerValidationRes.era,
                    epoch: headerValidationRes.epoch,
                    slot: headerValidationRes.slot,
                    blockHeaderHash: headerValidationRes.blockHeaderHash,
                    headerData: headerValidationRes.headerData,
                    tip: tip
                });
            };
            
            const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock = await this.fetchBlock(headerValidationRes.slot, headerValidationRes.blockHeaderHash);
            blockValidation(newBlockRes);
            if (parentPort) parentPort.postMessage({type: "blockFetched", peerId: this.peerId, slot: headerValidationRes.slot, blockHeaderHash: headerValidationRes.blockHeaderHash, blockData: newBlockRes});
            // logger.debug(`Validated - Era: ${multiEraHeader.era} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tip} - Percent Complete: ${((Number(slot) / Number(tip)) * 100).toFixed(2)}%`);
            await this.chainSyncClient.requestNext();
        });

        this.chainSyncClient.on("rollBackwards", async (rollBack: ChainSyncRollBackwards) => {
            if (!rollBack.point.blockHeader) return;
            const tip = rollBack.tip.point;
            logger.debug(`Rolled back tip for peer ${this.peerId}`, tip.blockHeader?.slotNumber );
            if (parentPort) parentPort.postMessage({type: "rollBack", peerId: this.peerId, point: rollBack.point});
            await this.chainSyncClient.requestNext();
        });

        this.chainSyncClient.on("error", (error: any) => {
            logger.error( `ChainSyncClient error for peer ${this.peerId}:`, error );
        });

        await this.syncToTip();
        this.chainSyncClient.requestNext();
    };

    async fetchBlock(slot: number | bigint, blockHash: Uint8Array): Promise<BlockFetchNoBlocks | BlockFetchBlock> {
        // logger.debug(`Peer: ${this.peerId}...`, `Fetching Block `, { slot, hash: toHex(blockHash)} );
        const chainPoint = new ChainPoint({
            blockHeader: { slotNumber: slot, hash: blockHash },
        });
        // logger.debug(`Fetching block at chain point for peer ${this.peerId}:`, chainPoint);
        const blockData = await this.blockFetchClient.request(chainPoint);
        // logger.debug(`Fetched block at slot ${slot} for peer ${this.peerId}`);
        return blockData;
    }

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
            logger.debug(
                `Sending keepAliveRequest cookie for peer ${this.peerId}:`,
                this.cookieCounter,
            );
            this.keepAliveClient.request(this.cookieCounter);
        }, interval);
    }
};

function getCurrentNes() { 
    return RawNewEpochState.init()
};

async function getShelleyGenesisConfig(config: GerolamoConfig) { 
    const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile)
    const shelleyGenesisConfig = await shelleyGenesisFile.json();
    return shelleyGenesisConfig;
};