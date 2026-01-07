import {
    BlockFetchBlock,
    BlockFetchClient,
    BlockFetchNoBlocks,
    ChainPoint,
    ChainSyncClient,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    HandshakeAcceptVersion,
    HandshakeClient,
    KeepAliveClient,
    Multiplexer,
    PeerSharingClient,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { connect } from "node:net";
import { logger } from "../utils/logger";
import { validateHeader } from "../consensus/BlockHeaderValidator";
import { validateBlock } from "../consensus/BlockBodyValidator";
import { applyBlock } from "../consensus/BlockApplication";
import { storeBlock } from "./sql";
import {
    Cbor,
    CborArray,
    CborBytes,
    CborTag,
    LazyCborArray,
} from "@harmoniclabs/cbor";
import { blake2b_256 } from "@harmoniclabs/crypto";
import {
    AllegraHeader,
    AlonzoHeader,
    BabbageHeader,
    ConwayHeader,
    MaryHeader,
    MultiEraBlock,
    MultiEraHeader,
    ShelleyHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { calculatePreProdCardanoEpoch } from "./utils/epochCalculations";
import { blockFrostFetchEra } from "./utils/blockFrostFetchEra";

import config from "../config/config.json" with { type: "json" };

export type HeaderValidatedCallback = (data: {
    peerId: string;
    era: number;
    epoch: number | bigint;
    slot: bigint;
    blockHeaderHash: Uint8Array;
    header: MultiEraHeader;
    tip: number | undefined;
}) => void;

export type BlockFetchedCallback = (data: {
    peerId: string;
    slot: bigint;
    blockHeaderHash: Uint8Array;
    blockData: any;
}) => void;

export type RollbackCallback = (data: {
    peerId: string;
    point: ChainPoint;
}) => void;

export class PeerClient {
    host: string;
    port: number | bigint;
    peerId: string;
    networkMagic: number;
    mplexer?: Multiplexer;
    chainSyncClient?: ChainSyncClient;
    blockFetchClient?: BlockFetchClient;
    keepAliveClient?: KeepAliveClient;
    peerSharingClient?: PeerSharingClient;
    peerSlotNumber?: number | null;
    syncPointFrom?: ChainPoint | null;
    syncPointTo?: ChainPoint | null;
    cookieCounter?: number;
    keepAliveInterval?: NodeJS.Timeout | null;
    isRangeSyncComplete?: boolean;
    onHeaderValidated?: HeaderValidatedCallback;
    onBlockFetched?: BlockFetchedCallback;
    onRollback?: RollbackCallback;

    constructor(
        host: string,
        port: number | bigint,
        networkMagic: number,
        callbacks?: {
            onHeaderValidated?: HeaderValidatedCallback;
            onBlockFetched?: BlockFetchedCallback;
            onRollback?: RollbackCallback;
        },
    ) {
        const unixTimestamp = Math.floor(Date.now() / 1000);
        const peerId = `${host}:${port}:${unixTimestamp}`;

        this.host = host;
        this.port = port;
        this.peerId = peerId;
        this.networkMagic = networkMagic;
        this.cookieCounter = 0;
        this.peerSlotNumber = null;
        this.keepAliveInterval = null;
        this.isRangeSyncComplete = false;
        this.onHeaderValidated = callbacks?.onHeaderValidated;
        this.onBlockFetched = callbacks?.onBlockFetched;
        this.onRollback = callbacks?.onRollback;
    }



    /**
     * Terminates the peer connection and cleans up resources
     */
    terminate(): void {
        logger.info(`Terminating connections for peer ${this.peerId}...`);

        if (this.chainSyncClient) {
            this.chainSyncClient.removeAllListeners("rollForward");
            this.chainSyncClient.removeAllListeners("rollBackwards");
            logger.debug(
                `Removed all ChainSyncClient listeners for peer ${this.peerId}`,
            );
            this.chainSyncClient.done();
        }

        if (this.blockFetchClient) {
            this.blockFetchClient.done();
        }

        if (this.keepAliveClient) {
            this.keepAliveClient.done();
        }

        if (this.peerSharingClient) {
            this.peerSharingClient.done();
        }

        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval as unknown as number);
            this.keepAliveInterval = null;
        }

        if (this.mplexer) {
            this.mplexer.close();
        }
    }

    /**
     * Initializes network components for the peer
     */
    initNetwork(): void {
        if (this.mplexer || this.chainSyncClient) {
            throw new Error("Peer network already initialized");
        }

        this.mplexer = new Multiplexer({
            connect: () => {
                logger.info(`Attempt connection to peer ${this.peerId}`);
                return connect({
                    host: this.host,
                    port: Number(this.port),
                }) as any;
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

        this.mplexer.on("error", (err) => {
            logger.error(`Multiplexer error for peer ${this.peerId}:`, err);
            this.terminate();
        });
    }

    /**
     * Performs handshake with the peer
     */
    async handshake(): Promise<void> {
        if (!this.mplexer) {
            throw new Error("Peer network not initialized");
        }

        const handshake = new HandshakeClient(this.mplexer);

        handshake.on("error", (err) => {
            logger.error(`Handshake error for peer ${this.peerId}:`, err);
            this.terminate();
        });

        const handshakeResult = await handshake.propose({
            networkMagic: this.networkMagic,
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
    }

    /**
     * Starts the chain sync loop for the peer
     */
    async startSync(): Promise<void> {
        if (!this.chainSyncClient) {
            throw new Error("Peer network not initialized");
        }

        logger.debug(`Starting sync loop for peer ${this.peerId}...`);

        this.chainSyncClient.on(
            "rollForward",
            async (rollForward: ChainSyncRollForward) => {
                const tip = rollForward.tip.point.blockHeader?.slotNumber;

                // Parse and validate header inline using consensus logic
                if (!(rollForward.data instanceof CborArray)) {
                    await this.chainSyncClient!.requestNext();
                    return;
                }

                const blockHeaderData: Uint8Array = Cbor.encode(rollForward.data)
                    .toBuffer();
                const lazyHeader = Cbor.parseLazy(blockHeaderData);
                if (!(lazyHeader instanceof LazyCborArray)) {
                    await this.chainSyncClient!.requestNext();
                    return;
                }

                const blockHeaderParsed = Cbor.parse(lazyHeader.array[1]);
                if (
                    !(blockHeaderParsed instanceof CborTag &&
                        blockHeaderParsed.data instanceof CborBytes)
                ) {
                    await this.chainSyncClient!.requestNext();
                    return;
                }

                const blockHeaderBodyLazy = Cbor.parseLazy(
                    blockHeaderParsed.data.bytes,
                );
                if (!(blockHeaderBodyLazy instanceof LazyCborArray)) {
                    await this.chainSyncClient!.requestNext();
                    return;
                }

                // Add +1 to era since multiplexer enums start at 0
                const blockHeaderBodyEra = lazyHeader.array[0][0] + 1;

                // Parse header based on era
                let parsedHeader;
                switch (blockHeaderBodyEra) {
                    case 2:
                        parsedHeader = ShelleyHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    case 3:
                        parsedHeader = AllegraHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    case 4:
                        parsedHeader = MaryHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    case 5:
                        parsedHeader = AlonzoHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    case 6:
                        parsedHeader = BabbageHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    case 7:
                        parsedHeader = ConwayHeader.fromCbor(
                            blockHeaderParsed.data.bytes,
                        );
                        break;
                    default:
                        await this.chainSyncClient!.requestNext();
                        return;
                }

                const multiEraHeader = new MultiEraHeader({
                    era: blockHeaderBodyEra,
                    header: parsedHeader,
                });

                const blockHeaderHash = blake2b_256(blockHeaderParsed.data.bytes);
                const headerEpoch = calculatePreProdCardanoEpoch(
                    Number(multiEraHeader.header.body.slot),
                );
                const epochNonce = await blockFrostFetchEra(headerEpoch as number);

                // Validate header using consensus
                const isValid = await validateHeader(
                    multiEraHeader,
                    fromHex(epochNonce.nonce),
                );

                if (!isValid) {
                    await this.chainSyncClient!.requestNext();
                    return;
                }

                this.onHeaderValidated?.({
                    peerId: this.peerId,
                    era: blockHeaderBodyEra,
                    epoch: headerEpoch,
                    slot: multiEraHeader.header.body.slot,
                    blockHeaderHash,
                    header: multiEraHeader,
                    tip: tip ? Number(tip) : undefined,
                });

                const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock =
                    await this.fetchBlock(
                        multiEraHeader.header.body.slot,
                        blockHeaderHash,
                    );

                // Validate and apply block inline using consensus logic
                if (newBlockRes instanceof BlockFetchBlock) {
                    const newMultiEraBlock = MultiEraBlock.fromCbor(
                        newBlockRes.blockData,
                    );

                    // Validate the block using consensus logic
                    const isValid = await validateBlock(newMultiEraBlock);
                    if (!isValid) {
                        throw new Error("Block validation failed");
                    }

                    // Store the block data in the database
                    await storeBlock(
                        blockHeaderHash,
                        Number(multiEraHeader.header.body.slot),
                        multiEraHeader.toCborBytes(),
                        newBlockRes.blockData,
                    );

                    // Apply the block to the ledger state
                    await applyBlock(
                        newMultiEraBlock,
                        multiEraHeader.header.body.slot,
                        blockHeaderHash,
                    );

                    logger.info(
                        `Block applied successfully: slot ${multiEraHeader.header.body.slot}`,
                    );
                }

                this.onHeaderValidated?.({
                    peerId: this.peerId,
                    era: blockHeaderBodyEra,
                    epoch: headerEpoch,
                    slot: multiEraHeader.header.body.slot,
                    blockHeaderHash,
                    header: multiEraHeader,
                    tip: tip ? Number(tip) : undefined,
                });

                this.onBlockFetched?.({
                    peerId: this.peerId,
                    slot: multiEraHeader.header.body.slot,
                    blockHeaderHash,
                    blockData: newBlockRes,
                });

                await this.chainSyncClient!.requestNext();
            },
        );

        this.chainSyncClient.on(
            "rollBackwards",
            async (rollBack: ChainSyncRollBackwards) => {
                if (!rollBack.point.blockHeader) return;
                const tip = rollBack.tip.point;
                logger.debug(
                    `Rolled back tip for peer ${this.peerId}`,
                    tip.blockHeader?.slotNumber,
                );
                this.onRollback?.({
                    peerId: this.peerId,
                    point: rollBack.point,
                });
                await this.chainSyncClient!.requestNext();
            },
        );
    }

    /**
     * Fetches a block from the peer
     */
    async fetchBlock(
        slot: number | bigint,
        blockHeaderHash: Uint8Array,
    ): Promise<BlockFetchNoBlocks | BlockFetchBlock> {
        if (!this.blockFetchClient) {
            throw new Error("Peer network not initialized");
        }

        const result = await this.blockFetchClient.request(
            new ChainPoint({
                blockHeader: {
                    slotNumber: Number(slot),
                    hash: blockHeaderHash,
                },
            }),
        );
        return result[0];
    }

    /**
     * Starts keep-alive protocol for the peer
     */
    startKeepAlive(interval: number = 60000): void {
        if (!this.keepAliveClient) {
            throw new Error("Peer network not initialized");
        }

        this.keepAliveInterval = setInterval(() => {
            this.cookieCounter = ((this.cookieCounter || 0) + 1) % 65536;
            logger.debug(
                `Sending keepAliveRequest cookie for peer ${this.peerId}:`,
                this.cookieCounter,
            );
            this.keepAliveClient!.request(this.cookieCounter!);
        }, interval) as unknown as NodeJS.Timeout;
    }
}