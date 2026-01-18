import { logger } from "../utils/logger";
import { headerParser, blockParser } from "./blockHeaderParser";
import { validateHeader } from "./BlockHeaderValidator";
import { validateBlock } from "./BlockBodyValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import type { BlockFetchNoBlocks, BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../tui/tui";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import type { GerolamoConfig } from "../network/peerManagerWorkers/peerManagerWorker";
import type { PeerClient } from "../network/peerClientWorkers/PeerClient";
import { DB } from "../db/DB";
import { applyBlock } from "./BlockApplication";
import { evaluateChains, type ChainCandidate } from "./chainSelection";

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
	readonly db!: DB;
	readonly peers!: PeerAccessor;
	private batchBlockRecords: Map<string, BlockInsertData> = new Map();
	private batchHeaderRecords: Map<string, HeaderInsertData> = new Map();
	private volatileDbGcCounter = 0;
	private lastActivity: number = Date.now();
	private stalledCallback?: () => void;

	constructor(config: GerolamoConfig, db: DB, peers: PeerAccessor, onStalled?: () => void) {
		this.config = config;
		this.db = db;
		this.peers = peers;
		this.stalledCallback = onStalled;
		// setInterval(() => {
		// 	if (Date.now() - this.lastActivity > 300000) { // 5 minutes
		// 		logger.warn("Sync stalled, no rollForward for 5 minutes");
		// 		if (this.stalledCallback) this.stalledCallback();
		// 	}
		// }, 60000); // check every minute
	}

	private async getCurrentTip(): Promise<{ blockNumber: number; slotNumber: bigint }> {
		const maxSlot = await this.db.getMaxSlot();
		const blockCount = maxSlot > 0n ? Number(maxSlot) : 0; // Approximate, since slots may have gaps
		return { blockNumber: blockCount, slotNumber: maxSlot };
	}

	async handleRollForward(rollForwardCborBytes: Uint8Array, peerId: string, tip: bigint): Promise<void> {
		this.lastActivity = Date.now();
		logger.debug(`Processing rollForward message from peer ${peerId}...`);
		try {
			const peer = this.peers.getPeer(peerId);
			if (!peer) {
				logger.error(`Peer ${peerId} not found for rollForward processing`);
				return;
			}

			const parsedHeader = await headerParser(rollForwardCborBytes);

			if (!parsedHeader) {
				logger.warn(`Header parse failed for peer ${peerId}`);
				return;
			}

			if(!(parsedHeader.currentEpochNonce)){
				logger.warn(`Missing epoch nonce for header validation for peer ${peerId} at slot ${parsedHeader.slot}, hash ${toHex(parsedHeader.blockHeaderHash)}`);
				return;
			};

			const isValid = await validateHeader(parsedHeader.multiEraHeader, fromHex(parsedHeader.currentEpochNonce), this.config);
			if (!isValid) {
				logger.warn(`Header validation failed for peer ${peerId}: slot ${parsedHeader.slot}, hash ${toHex(parsedHeader.blockHeaderHash)}`);
				return;
			}

			const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock = await peer.fetchBlock(parsedHeader.slot, parsedHeader.blockHeaderHash);

			let multiEraBlock: MultiEraBlock | undefined;
			multiEraBlock = await blockParser(newBlockRes);
			if (!multiEraBlock || !(multiEraBlock instanceof MultiEraBlock)) {
				logger.warn(`Block parse/validation failed for peer ${peerId} at slot ${parsedHeader.slot}, hash ${toHex(parsedHeader.blockHeaderHash)}`);
				return;
			}

			const isBlockValid = await validateBlock(multiEraBlock!, this.config, this.db);
			if (!isBlockValid) {
				logger.warn(`Block body validation failed for peer ${peerId} at slot ${parsedHeader.slot}, hash ${toHex(parsedHeader.blockHeaderHash)}`);
				// continue even if invalid (temporary)
			};
            if(isBlockValid) {
                logger.info(`Block body validated for peer ${peerId} at slot ${parsedHeader.slot}, hash ${toHex(parsedHeader.blockHeaderHash)}`);
            };

			const era = multiEraBlock.era;
			const blockHeader = multiEraBlock.block.header;
			const blockData = multiEraBlock.block.toCborBytes();
			const blockSlot = Number(blockHeader.body.slot);
			const blockEpoch = calculatePreProdCardanoEpoch(Number(blockSlot));
			const blockHeaderHash = blake2b_256(blockHeader.toCborBytes());
			let currentEpoch: number | null = null;
			let firstEpochSlot: number | null = null;

			if (currentEpoch === null) currentEpoch = Number(blockEpoch);
			if (firstEpochSlot === null) firstEpochSlot = Number(blockSlot);
			if (currentEpoch && currentEpoch < blockEpoch) firstEpochSlot = Number(blockSlot);
			if (currentEpoch && currentEpoch < blockEpoch) currentEpoch = Number(blockEpoch);

			const blockHash = toHex(blockHeaderHash);

            await applyBlock(this.db, multiEraBlock.block as MultiEraBlock["block"], BigInt(blockSlot), blockHeaderHash);
            logger.info(`Applied Block: ${toHex(blockHeaderHash)}`);	
            
			const recordHeaders: HeaderInsertData = {
				slot: BigInt(blockSlot),
				headerHash: blockHash,
				rollforward_header_cbor: rollForwardCborBytes.slice()
			};

			const recordBlocks: BlockInsertData = {
				slot: BigInt(blockSlot),
				blockHash,
				prevHash: blockHeader.body.prevHash ? toHex(blockHeader.body.prevHash) : "",
				headerData: blockHeader.toCborBytes(),
				blockData: multiEraBlock.block.toCborBytes(),
				block_fetch_RawCbor: newBlockRes.toCborBytes()
			};

			this.batchBlockRecords.set(blockHash, recordBlocks);
			this.batchHeaderRecords.set(blockHash, recordHeaders);

			if (this.batchBlockRecords.size >= 1) {
				await this.db.insertBlockBatchVolatile(Array.from(this.batchBlockRecords.values()));
				await this.db.insertHeaderBatchVolatile(Array.from(this.batchHeaderRecords.values()));
				this.batchBlockRecords.clear();
				this.batchHeaderRecords.clear();
			};

			this.volatileDbGcCounter++;
			if (this.volatileDbGcCounter >= 2160) {
				this.volatileDbGcCounter = 0;
				await this.db.compact();
			};

			this.config.tuiEnabled && prettyBlockValidationLog(era, Number(blockEpoch), blockHeaderHash, blockSlot, Number(tip), this.volatileDbGcCounter, this.batchBlockRecords.size);
		} catch (error: unknown) {
			logger.error(`Error processing rollForward for peer ${peerId}:`, error);
		};
	};

	async handleRollBack(point: RollbackPoint, candidate: ChainCandidate): Promise<{ rolledBack: boolean; fromSlot?: bigint; toSlot?: bigint; counts?: { blocksDeleted: number; headersDeleted: number; deltasDeleted: number } }> {
		try {
			const currentTip = await this.getCurrentTip();
			const comparison = await evaluateChains([candidate], 'praos', 2160);

			logger.rollback("handleRollBack: Evaluating chains with Praos");

			if (comparison.comparison.preferred === 'candidate') {
				const rollbackSlot = point.blockHeader!.slotNumber;
				const counts = await this.db.rollbackChainTo(rollbackSlot);
				logger.rollback(`Praos-approved rollback to slot ${rollbackSlot}: ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`);
				return { rolledBack: true, fromSlot: currentTip.slotNumber, toSlot: rollbackSlot, counts };
			} else {
				logger.rollback(`Rollback rejected by Praos: current preferred over candidate at slot ${candidate.slotNumber}`);
				return { rolledBack: false };
			}
		} catch (error) {
			logger.error('Error in handleRollBack:', error);
			return { rolledBack: false };
		}
	};
};