import { logger } from "../utils/logger";
import { blockParser, headerParser } from "./blockHeaderParser";
import { validateHeader } from "./BlockHeaderValidator";
import { validateBlock } from "./BlockBodyValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import type {
    BlockFetchBlock,
    BlockFetchNoBlocks,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../tui";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { blockFrostFetchEra } from "../utils/blockFrostFetchEra";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import type { GerolamoConfig } from "../network/peerManager";
import type { PeerClient } from "../network/PeerClient";
import {
    applyTransaction,
    getBlockByHash,
    getBlockBySlot,
    getEpochNonce as dbGetEpochNonce,
    getEpochNonceState,
    getMaxSlot,
    getValidBlocksBefore,
    getValidHeadersBefore,
    insertBlockBatchVolatile,
    insertBlockVolatile,
    insertHeaderBatchVolatile,
    rollbackChainTo,
    storeEpochNonce,
} from "../db";
import { applyBlock } from "./BlockApplication";
import { type ChainCandidate, evaluateChains } from "./chainSelection";
import {
    getHeaderSlot,
    getHeaderPrevHash,
    getHeaderPrevHashHex,
} from "../utils/eraAccessors";
import { getShelleyGenesisConfig } from "../utils/paths";
import { NonceEvolver } from "../utils/nonceEvolver";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";

export interface PeerAccessor {
    getPeer(peerId: string): PeerClient | null;
    pickHotPeer(): PeerClient | null;
}

interface HeaderInsertData {
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
}

interface BlockInsertData {
    slot: bigint;
    blockHash: string;
    prevHash: string;
    headerData: Uint8Array;
    blockData: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
}

interface RollbackPoint {
    blockHeader?: {
        slotNumber: bigint;
    };
}

export class ConsensusOrchestrator {
    readonly config: GerolamoConfig;
    readonly peers!: PeerAccessor;
    private batchBlockRecords: Map<string, BlockInsertData> = new Map();
    private batchHeaderRecords: Map<string, HeaderInsertData> = new Map();
    private volatileDbGcCounter = 0;
    private epochNonceCache: Map<number, string> = new Map();
    /** Continuous UPDN+TICKN (phase 3). Lazy-init after genesis load. */
    private nonceEvolver: NonceEvolver | null = null;
    private nonceEvolverInit: Promise<void> | null = null;

    constructor(
        config: GerolamoConfig,
        peers: PeerAccessor,
    ) {
        this.config = config;
        this.peers = peers;
        // setInterval(() => {
        // 	if (Date.now() - this.lastActivity > 300000) { // 5 minutes
        // 		logger.warn("Sync stalled, no rollForward for 5 minutes");
        // 		if (this.stalledCallback) this.stalledCallback();
        // 	}
        // }, 60000); // check every minute
    }

    private async ensureNonceEvolver(): Promise<NonceEvolver | null> {
        if (this.nonceEvolver) return this.nonceEvolver;
        if (!this.nonceEvolverInit) {
            this.nonceEvolverInit = (async () => {
                try {
                    const genesis = (await getShelleyGenesisConfig(
                        this.config,
                    )) as ShelleyGenesisConfig;
                    this.nonceEvolver = new NonceEvolver(genesis);
                    logger.debug(
                        `NonceEvolver ready (stabilityWindow=${this.nonceEvolver.getStabilityWindow()})`,
                    );
                } catch (err: unknown) {
                    logger.warn("NonceEvolver init failed:", err);
                    this.nonceEvolver = null;
                }
            })();
        }
        await this.nonceEvolverInit;
        return this.nonceEvolver;
    }

    /**
     * Bootstrap continuous ηv/ηc when inactive.
     * Prefer DB evolving/candidate; else ηv=ηc=η0 (correct at epoch start).
     */
    private async ensureEvolverBootstrapped(
        epoch: number,
        eta0Hex: string,
    ): Promise<void> {
        const evolver = await this.ensureNonceEvolver();
        if (!evolver || evolver.isActive()) return;
        try {
            const st = await getEpochNonceState(epoch);
            if (st?.evolving_hex && st?.candidate_hex) {
                evolver.bootstrap(epoch, eta0Hex, {
                    etaVHex: st.evolving_hex,
                    etaCHex: st.candidate_hex,
                });
                logger.debug(
                    `NonceEvolver restored ηv/ηc from DB for epoch ${epoch}`,
                );
            } else {
                evolver.bootstrap(epoch, eta0Hex);
                logger.debug(
                    `NonceEvolver bootstrapped ηv=ηc=η0 for epoch ${epoch}`,
                );
            }
        } catch (err: unknown) {
            logger.warn(
                `NonceEvolver bootstrap failed for epoch ${epoch}:`,
                err,
            );
        }
    }

    /** Feed one applied Shelley+ block into UPDN; persist any TICKN η0. */
    private async feedNonceEvolver(
        slot: bigint | number,
        header: unknown,
        epoch: number,
        eta0Hex: string,
    ): Promise<void> {
        try {
            await this.ensureEvolverBootstrapped(epoch, eta0Hex);
            const evolver = this.nonceEvolver;
            if (!evolver?.isActive()) return;

            const bnonce = NonceEvolver.extractBlockNonce(header);
            if (!bnonce) return; // Byron / missing VRF

            const prevHash = getHeaderPrevHash(header as any);
            const tickns = evolver.processBlock(slot, bnonce, prevHash);
            for (const t of tickns) {
                this.epochNonceCache.set(t.epoch, t.eta0Hex);
                try {
                    await storeEpochNonce(
                        t.epoch,
                        t.eta0Hex,
                        "local",
                        t.etaVHex,
                        t.etaCHex,
                    );
                    logger.info(
                        `TICKN η0_${t.epoch}=${t.eta0Hex.slice(0, 16)}… ` +
                            `(blocks=${t.nBlocksPrev} freeze=${t.nBeforeFreeze})`,
                    );
                } catch (storeErr: unknown) {
                    logger.warn(
                        `Failed to persist TICKN η0 for epoch ${t.epoch}:`,
                        storeErr,
                    );
                }
            }

            // Persist evolving/candidate for current epoch (mid-chain resume)
            if (tickns.length === 0 && evolver.isActive()) {
                const snap = evolver.snapshot();
                try {
                    await storeEpochNonce(
                        snap.epoch,
                        eta0Hex,
                        "local",
                        snap.etaVHex,
                        snap.etaCHex,
                    );
                } catch {
                    // non-fatal; next TICKN still persists
                }
            }
        } catch (err: unknown) {
            logger.warn("NonceEvolver feed failed:", err);
        }
    }

    private async getCurrentTip(): Promise<
        { blockNumber: number; slotNumber: bigint }
    > {
        const maxSlot = await getMaxSlot();
        const blockCount = maxSlot > 0n ? Number(maxSlot) : 0; // Approximate, since slots may have gaps
        return { blockNumber: blockCount, slotNumber: maxSlot };
    }

    /**
     * Resolve epoch η0 for header VRF:
     * 1) in-memory cache
     * 2) local SQLite (epoch_nonces)
     * 3) external Blockfrost/onchainapps → persist to DB
     *
     * Continuous UPDN+TICKN (phase 3) evolves ηv/ηc on applied blocks and
     * writes next-epoch η0 via storeEpochNonce(source='local').
     * Mid-chain still bootstraps η0 from DB/external when needed.
     */
    private async getEpochNonce(epoch: number): Promise<string | null> {
        if (this.epochNonceCache.has(epoch)) {
            logger.debug(`Cache hit for epoch nonce ${epoch}`);
            return this.epochNonceCache.get(epoch)!;
        }

        try {
            const local = await dbGetEpochNonce(epoch);
            if (local) {
                this.epochNonceCache.set(epoch, local);
                logger.debug(`DB hit for epoch nonce ${epoch}`);
                return local;
            }
        } catch (error: unknown) {
            logger.warn(`Local epoch nonce read failed for ${epoch}:`, error);
        }

        try {
            const nonce = await blockFrostFetchEra(this.config, epoch);
            this.epochNonceCache.set(epoch, nonce);
            try {
                await storeEpochNonce(epoch, nonce, "external");
            } catch (storeErr: unknown) {
                logger.warn(
                    `Failed to persist epoch ${epoch} nonce to DB:`,
                    storeErr,
                );
            }
            logger.debug(
                `Fetched and cached epoch ${epoch} nonce from external (persisted)`,
            );
            return nonce;
        } catch (error: unknown) {
            logger.error(`Failed to fetch epoch ${epoch} nonce:`, error);
            return null;
        }
    }

    async handleRollForward(
        rollForwardCborBytes: Uint8Array,
        peerId: string,
        tip: bigint,
    ): Promise<void> {
        logger.debug(`Processing rollForward message from peer ${peerId}...`);
        try {
            const peer = this.peers.getPeer(peerId);
            if (!peer) {
                logger.error(
                    `Peer ${peerId} not found for rollForward processing`,
                );
                return;
            }

            const parsedHeader = await headerParser(rollForwardCborBytes);

            if (!parsedHeader) {
                logger.warn(`Header parse failed for peer ${peerId}`);
                return;
            }

            const nonce = await this.getEpochNonce(
                parsedHeader.epoch as number,
            );
            if (!nonce) {
                logger.warn(
                    `Missing epoch nonce for header validation for peer ${peerId} at slot ${parsedHeader.slot.toString()}, hash ${
                        toHex(parsedHeader.blockHeaderHash)
                    }`,
                );
                return;
            }

            const isValid = await validateHeader(
                parsedHeader.multiEraHeader,
                fromHex(nonce),
                this.config,
            );
            if (!isValid) {
                logger.warn(
                    `Header validation failed for peer ${peerId}: slot ${parsedHeader.slot.toString()}, hash ${
                        toHex(parsedHeader.blockHeaderHash)
                    }`,
                );
                return;
            }

            const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock = await peer
                .fetchBlock(parsedHeader.slot, parsedHeader.blockHeaderHash);

            let multiEraBlock: MultiEraBlock | undefined;
            multiEraBlock = await blockParser(newBlockRes);
            if (!multiEraBlock || !(multiEraBlock instanceof MultiEraBlock)) {
                logger.warn(
                    `Block parse/validation failed for peer ${peerId} at slot ${parsedHeader.slot}, hash ${
                        toHex(parsedHeader.blockHeaderHash)
                    }`,
                );
                return;
            }

            const isBlockValid = await validateBlock(
                multiEraBlock!,
                this.config,
            );
            const bodyPolicy = this.config.bodyValidation ?? "soft";
            if (!isBlockValid) {
                if (bodyPolicy === "strict") {
                    logger.warn(
                        `Block body validation failed for peer ${peerId} at slot ${parsedHeader.slot}, hash ${
                            toHex(parsedHeader.blockHeaderHash)
                        } (strict: rejecting — no apply)`,
                    );
                    return;
                }
                logger.warn(
                    `Block body validation failed for peer ${peerId} at slot ${parsedHeader.slot}, hash ${
                        toHex(parsedHeader.blockHeaderHash)
                    } (soft: applying anyway for mid-chain sync tolerance)`,
                );
            } else {
                logger.info(
                    `Block body validated for peer ${peerId} at slot ${parsedHeader.slot}, hash ${
                        toHex(parsedHeader.blockHeaderHash)
                    }`,
                );
            }

            const era = multiEraBlock.era;
            const blockHeader = multiEraBlock.block.header;
            const blockSlot = Number(getHeaderSlot(blockHeader));
            const blockEpoch = Number(
                calculatePreProdCardanoEpoch(Number(blockSlot)),
            );
            const blockHeaderHash = blake2b_256(blockHeader.toCborBytes());
            const blockHash = toHex(blockHeaderHash);

            await applyBlock(
                multiEraBlock.block as MultiEraBlock["block"],
                BigInt(blockSlot),
                blockHeaderHash,
            );
            logger.info(`Applied Block: ${toHex(blockHeaderHash)}`);

            // Phase 3: continuous UPDN+TICKN (η0 for this epoch already resolved)
            await this.feedNonceEvolver(
                BigInt(blockSlot),
                blockHeader,
                blockEpoch,
                nonce,
            );

            const recordHeaders: HeaderInsertData = {
                slot: BigInt(blockSlot),
                headerHash: blockHash,
                rollforward_header_cbor: rollForwardCborBytes.slice(),
            };

            const recordBlocks: BlockInsertData = {
                slot: BigInt(blockSlot),
                blockHash,
                prevHash: getHeaderPrevHashHex(blockHeader),
                headerData: blockHeader.toCborBytes(),
                blockData: multiEraBlock.block.toCborBytes(),
                block_fetch_RawCbor: newBlockRes.toCborBytes(),
            };

            this.batchBlockRecords.set(blockHash, recordBlocks);
            this.batchHeaderRecords.set(blockHash, recordHeaders);

            if (this.batchBlockRecords.size >= 1) {
                await insertBlockBatchVolatile(
                    Array.from(this.batchBlockRecords.values()),
                );
                await insertHeaderBatchVolatile(
                    Array.from(this.batchHeaderRecords.values()),
                );
                this.batchBlockRecords.clear();
                this.batchHeaderRecords.clear();
            }

            this.config.tuiEnabled &&
                prettyBlockValidationLog(
                    era,
                    Number(blockEpoch),
                    blockHeaderHash,
                    blockSlot,
                    Number(tip),
                    this.volatileDbGcCounter,
                    this.batchBlockRecords.size,
                );
        } catch (error: unknown) {
            logger.error(
                `Error processing rollForward for peer ${peerId}:`,
                error,
            );
        }
    }

    async handleRollBack(
        point: RollbackPoint,
        candidate?: ChainCandidate,
    ): Promise<
        {
            rolledBack: boolean;
            fromSlot?: bigint;
            toSlot?: bigint;
            counts?: {
                blocksDeleted: number;
                headersDeleted: number;
                deltasDeleted: number;
            };
        }
    > {
        try {
            const currentTip = await this.getCurrentTip();
            const pointSlot = point.blockHeader!.slotNumber;
            logger.rollback(
                `handleRollBack: current tip slot=${currentTip.slotNumber.toString()} (~${currentTip.blockNumber} blocks), point slot=${pointSlot.toString()}${
                    candidate
                        ? `, candidate slot=${candidate.slotNumber.toString()} block#${candidate.blockNumber}`
                        : ""
                }`,
            );

            if (candidate) {
                const evalResult = await evaluateChains(
                    [candidate],
                );
                const comparison = evalResult.comparison;
                logger.rollback(
                    `Praos eval: preferred='${comparison.preferred}', intersectionBlock=${comparison.intersectionBlock}, rollbackDistance=${comparison.rollbackDistance}`,
                );

                if (comparison.preferred === "candidate") {
                    const rollbackSlot = point.blockHeader!.slotNumber;
                    const counts = await rollbackChainTo(rollbackSlot);
                    logger.rollback(
                        `Praos-approved rollback to slot ${rollbackSlot}: ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`,
                    );
                    this.nonceEvolver?.reset();
                    this.epochNonceCache.clear();
                    return {
                        rolledBack: true,
                        fromSlot: currentTip.slotNumber,
                        toSlot: rollbackSlot,
                        counts,
                    };
                } else {
                    logger.rollback(
                        `Rollback rejected by Praos: current preferred over candidate at slot ${candidate.slotNumber}`,
                    );
                    return { rolledBack: false };
                }
            } else {
                const counts = await rollbackChainTo(pointSlot);
                logger.rollback(
                    `Unconditional tip rollback to slot ${pointSlot}: ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`,
                );
                this.nonceEvolver?.reset();
                this.epochNonceCache.clear();
                return {
                    rolledBack: true,
                    fromSlot: currentTip.slotNumber,
                    toSlot: pointSlot,
                    counts,
                };
            }
        } catch (error) {
            logger.error("Error in handleRollBack:", error);
            return { rolledBack: false };
        }
    }
}
