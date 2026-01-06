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

export interface PeerState {
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
}

/**
 * Creates and initializes a new peer state object
 */
export async function createPeer(
    host: string,
    port: number | bigint,
    networkMagic: number,
    callbacks?: {
        onHeaderValidated?: HeaderValidatedCallback;
        onBlockFetched?: BlockFetchedCallback;
        onRollback?: RollbackCallback;
    },
): Promise<PeerState> {
    const unixTimestamp = Math.floor(Date.now() / 1000);
    const peerId = `${host}:${port}:${unixTimestamp}`;

    const peerState: PeerState = {
        host,
        port,
        peerId,
        networkMagic,
        cookieCounter: 0,
        peerSlotNumber: null,
        keepAliveInterval: null,
        isRangeSyncComplete: false,
        onHeaderValidated: callbacks?.onHeaderValidated,
        onBlockFetched: callbacks?.onBlockFetched,
        onRollback: callbacks?.onRollback,
    };

    return peerState;
}

/**
 * Initializes network components for a peer
 */
export function initializePeerNetwork(peerState: PeerState): void {
    if (peerState.mplexer || peerState.chainSyncClient) {
        throw new Error("Peer network already initialized");
    }

    peerState.mplexer = new Multiplexer({
        connect: () => {
            logger.info(`Attempt connection to peer ${peerState.peerId}`);
            return connect({
                host: peerState.host,
                port: Number(peerState.port),
            }) as any;
        },
        protocolType: "node-to-node",
    });

    peerState.chainSyncClient = new ChainSyncClient(peerState.mplexer);
    peerState.blockFetchClient = new BlockFetchClient(peerState.mplexer);
    peerState.keepAliveClient = new KeepAliveClient(peerState.mplexer);
    peerState.peerSharingClient = new PeerSharingClient(peerState.mplexer);
    peerState.cookieCounter = 0;
    peerState.peerSlotNumber = null;
    peerState.keepAliveInterval = null;

    peerState.mplexer.on("error", (err) => {
        logger.error(`Multiplexer error for peer ${peerState.peerId}:`, err);
        terminatePeer(peerState);
    });
}

/**
 * Performs handshake with the peer
 */
export async function handshakePeer(peerState: PeerState): Promise<void> {
    if (!peerState.mplexer) {
        throw new Error("Peer network not initialized");
    }

    const handshake = new HandshakeClient(peerState.mplexer);

    handshake.on("error", (err) => {
        logger.error(`Handshake error for peer ${peerState.peerId}:`, err);
        terminatePeer(peerState);
    });

    const handshakeResult = await handshake.propose({
        networkMagic: peerState.networkMagic,
        query: false,
    });

    if (!(handshakeResult instanceof HandshakeAcceptVersion)) {
        logger.error(
            `Handshake failed for peer ${peerState.peerId}:`,
            handshakeResult,
        );
        throw new Error("Handshake failed");
    }

    logger.debug(`Handshake success for peer ${peerState.peerId}`);
}

/**
 * Starts the chain sync loop for the peer
 */
export async function startSyncLoop(peerState: PeerState): Promise<void> {
    if (!peerState.chainSyncClient) {
        throw new Error("Peer network not initialized");
    }

    logger.debug(`Starting sync loop for peer ${peerState.peerId}...`);

    peerState.chainSyncClient.on(
        "rollForward",
        async (rollForward: ChainSyncRollForward) => {
            const tip = rollForward.tip.point.blockHeader?.slotNumber;

            // Parse and validate header inline using consensus logic
            if (!(rollForward.data instanceof CborArray)) {
                await peerState.chainSyncClient!.requestNext();
                return;
            }

            const blockHeaderData: Uint8Array = Cbor.encode(rollForward.data)
                .toBuffer();
            const lazyHeader = Cbor.parseLazy(blockHeaderData);
            if (!(lazyHeader instanceof LazyCborArray)) {
                await peerState.chainSyncClient!.requestNext();
                return;
            }

            const blockHeaderParsed = Cbor.parse(lazyHeader.array[1]);
            if (
                !(blockHeaderParsed instanceof CborTag &&
                    blockHeaderParsed.data instanceof CborBytes)
            ) {
                await peerState.chainSyncClient!.requestNext();
                return;
            }

            const blockHeaderBodyLazy = Cbor.parseLazy(
                blockHeaderParsed.data.bytes,
            );
            if (!(blockHeaderBodyLazy instanceof LazyCborArray)) {
                await peerState.chainSyncClient!.requestNext();
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
                    await peerState.chainSyncClient!.requestNext();
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
                await peerState.chainSyncClient!.requestNext();
                return;
            }

            peerState.onHeaderValidated?.({
                peerId: peerState.peerId,
                era: blockHeaderBodyEra,
                epoch: headerEpoch,
                slot: multiEraHeader.header.body.slot,
                blockHeaderHash,
                header: multiEraHeader,
                tip: tip ? Number(tip) : undefined,
            });

            const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock =
                await fetchBlock(
                    peerState,
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

            peerState.onBlockFetched?.({
                peerId: peerState.peerId,
                slot: multiEraHeader.header.body.slot,
                blockHeaderHash,
                blockData: newBlockRes,
            });

            await peerState.chainSyncClient!.requestNext();
        },
    );

    peerState.chainSyncClient.on(
        "rollBackwards",
        async (rollBack: ChainSyncRollBackwards) => {
            if (!rollBack.point.blockHeader) return;
            const tip = rollBack.tip.point;
            logger.debug(
                `Rolled back tip for peer ${peerState.peerId}`,
                tip.blockHeader?.slotNumber,
            );
            peerState.onRollback?.({
                peerId: peerState.peerId,
                point: rollBack.point,
            });
            await peerState.chainSyncClient!.requestNext();
        },
    );
}

/**
 * Fetches a block from the peer
 */
export async function fetchBlock(
    peerState: PeerState,
    slot: number | bigint,
    blockHeaderHash: Uint8Array,
): Promise<BlockFetchNoBlocks | BlockFetchBlock> {
    if (!peerState.blockFetchClient) {
        throw new Error("Peer network not initialized");
    }

    const result = await peerState.blockFetchClient.request(
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
export function startKeepAlive(
    peerState: PeerState,
    interval: number = 60000,
): void {
    if (!peerState.keepAliveClient) {
        throw new Error("Peer network not initialized");
    }

    peerState.keepAliveInterval = setInterval(() => {
        peerState.cookieCounter = ((peerState.cookieCounter || 0) + 1) % 65536;
        logger.debug(
            `Sending keepAliveRequest cookie for peer ${peerState.peerId}:`,
            peerState.cookieCounter,
        );
        peerState.keepAliveClient!.request(peerState.cookieCounter!);
    }, interval) as unknown as NodeJS.Timeout;
}

/**
 * Terminates the peer connection and cleans up resources
 */
export function terminatePeer(peerState: PeerState): void {
    logger.info(`Terminating connections for peer ${peerState.peerId}...`);

    if (peerState.chainSyncClient) {
        peerState.chainSyncClient.removeAllListeners("rollForward");
        peerState.chainSyncClient.removeAllListeners("rollBackwards");
        logger.debug(
            `Removed all ChainSyncClient listeners for peer ${peerState.peerId}`,
        );
        peerState.chainSyncClient.done();
    }

    if (peerState.blockFetchClient) {
        peerState.blockFetchClient.done();
    }

    if (peerState.keepAliveClient) {
        peerState.keepAliveClient.done();
    }

    if (peerState.peerSharingClient) {
        peerState.peerSharingClient.done();
    }

    if (peerState.keepAliveInterval) {
        clearInterval(peerState.keepAliveInterval as unknown as number);
        peerState.keepAliveInterval = null;
    }

    if (peerState.mplexer) {
        peerState.mplexer.close();
    }
}
