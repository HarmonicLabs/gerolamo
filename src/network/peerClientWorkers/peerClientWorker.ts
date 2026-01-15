import { parentPort, workerData } from "worker_threads";
import { PeerClient } from "./PeerClient";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";
import { logger } from "../../utils/logger";
import { headerParser, blockParser } from "../../consensus/blockHeaderParser";
import { validateHeader } from "../../consensus/BlockHeaderValidator";
import { validateBlock } from "../../consensus/BlockBodyValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import type { BlockFetchNoBlocks, BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../../tui/tui";
import { calculatePreProdCardanoEpoch } from "../../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { DB } from "../../db/DB";

let config: GerolamoConfig;
let db: DB;
let allPeers = new Map<string, PeerClient>();
let hotPeers: PeerClient[] = [];
let warmPeers: PeerClient[] = [];
let coldPeers: PeerClient[] = [];
let bootstrapPeers: PeerClient[] = [];
let newPeers: PeerClient[] = [];
let volatileDbGcCounter = 0;

let batchBlockRecords: Map<string, {
	slot: bigint;
	blockHash: string;
	prevHash: string;
	headerData: Uint8Array;
	blockData: Uint8Array;
	block_fetch_RawCbor: Uint8Array;
}> = new Map();

let batchHeaderRecords: Map<string, {
	slot: bigint;
	headerHash: string;
	rollforward_header_cbor: Uint8Array;
}> = new Map();

parentPort!.on("message", async (msg: any) => {
	if (msg.type === "init") {
		config = msg.config;
		db = new DB(config.dbPath);
		logger.setLogConfig(config.logs);
		logger.debug("PeerClient worker initialized");
		parentPort!.postMessage({ type: "started" });
	}

	if (msg.type === "addPeer") {
		const { host, port, category, addId } = msg;
		try {
		const peer = new PeerClient(host, port, config);
		await peer.handShakePeer();
		peer.startKeepAlive();
		allPeers.set(peer.peerId, peer);
		switch (category) {
			case "hot":
			hotPeers.push(peer);
			break;
			case "warm":
			warmPeers.push(peer);
			break;
			case "cold":
			coldPeers.push(peer);
			break;
			case "bootstrap":
			bootstrapPeers.push(peer);
			break;
			case "new":
			newPeers.push(peer);
			break;
		}
			logger.debug(`Added peer ${peer.peerId} to ${category}`);
		
		parentPort!.postMessage({ type: "peerAdded", addId, peerId: peer.peerId });
		} catch (error) {
			logger.error(`Failed to add peer ${host}:${port}`, error);
		}
	}

	if (msg.type === "startSync") {
		const { peerIds } = msg;
		logger.debug(`Starting sync for peers: ${peerIds.join(", ")}`);
		for (const peerId of peerIds) {
			const peer = allPeers.get(peerId);
			if (peer) {
				try {
				await peer.startSyncLoop();
				logger.debug(`Started sync for peer ${peerId}`);
				} catch (error) {
				logger.error(`Failed to start sync for peer ${peerId}`, error);
				}
			}
		}
	};

	if (msg.type === "rollForward") {
		try {
			const { peerId, rollForwardCborBytes, tip } = msg;
			const peer = allPeers.get(peerId);
			if(!(peer)) {
				logger.error(`Peer ${peerId} not found for rollForward processing`);
				return;
			};

			const parsedHeader = await headerParser(rollForwardCborBytes);

			if (!parsedHeader) {
				logger.debug("header parsing failed");
				return;
			};

			const isValid = await validateHeader(parsedHeader.multiEraHeader, parsedHeader.epochNonce.nonce, config);
			if (!isValid) {
			 	logger.debug(`Header validation failed for slot ${parsedHeader.slot} with hash ${toHex(parsedHeader.blockHeaderHash)}`);
			 	return;
			};

			let currentEpoch: number | null = null;
			let firstEpochSlot: number | null = null;

			const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock = await peer.fetchBlock(parsedHeader.slot, parsedHeader.blockHeaderHash);
			
			let multiEraBlock: MultiEraBlock | undefined;
			try {
				multiEraBlock = await blockParser(newBlockRes);
			} catch (e: any) {
				logger.warn(`Block parse failed for peer ${peerId} at slot ${parsedHeader.slot}:`, e.message || e, `BlockHash: ${toHex(parsedHeader.blockHeaderHash)}`, `BlockData: ${toHex((newBlockRes as BlockFetchBlock).blockData || new Uint8Array())}`);
				return;
			};
			
			const isBlockValid = await validateBlock(multiEraBlock!, config, db);
			if (!isBlockValid) {
				logger.warn(`Block validation failed for peer ${peerId} at slot ${parsedHeader.slot}`);			
				return;
			};
			
			if (!(multiEraBlock instanceof MultiEraBlock)) 
			{
				logger.warn(`Invalid multiEraBlock failed for peer ${peerId} at slot ${parsedHeader.slot} blockHash ${toHex(parsedHeader.blockHeaderHash)}`);			
				return;
			};		
			// logger.debug(`Block fetched: ${peerId}, tip ${tip}`);
			// logger.debug("Block: ", toHex(multiEraBlock.block.toCborBytes()))
			const era = multiEraBlock.era;
			// logger.debug("Era: ", era);
			const blockHeader = multiEraBlock.block.header;
			// logger.debug("Block Header: ", toHex(blockHeader.toCborBytes()));
			const blockData = multiEraBlock.block.toCborBytes();
			// logger.debug("Block Data: ", toHex(blockData));
			const blockSlot = Number(blockHeader.body.slot);
			// logger.debug("blockSlot: ", blockSlot);
			const blockEpoch = calculatePreProdCardanoEpoch(Number(blockSlot));
			// logger.debug("Epoch: ", blockEpoch);
			const blockHeaderHash = blake2b_256(blockHeader.toCborBytes());
			// logger.debug("Block Header Hash: ", toHex(blockHeaderHash));
			if ( currentEpoch === null) currentEpoch = Number(blockEpoch);
			if ( firstEpochSlot === null) firstEpochSlot = Number(blockSlot);

			if ( currentEpoch && currentEpoch < blockEpoch ) firstEpochSlot = Number(blockSlot);
			if ( currentEpoch && currentEpoch < blockEpoch ) currentEpoch = Number(blockEpoch);
			
			const blockHash = toHex(blockHeaderHash);

			const recordHeaders = {
				slot: BigInt(blockSlot),
				headerHash: blockHash,
				rollforward_header_cbor: rollForwardCborBytes.slice()  // Direct Uint8Array
			};
			
			const recordBlocks = {
				slot: BigInt(blockSlot),
				blockHash,
				prevHash: blockHeader.body.prevHash ? toHex(blockHeader.body.prevHash) : "",
				headerData: blockHeader.toCborBytes(),  // Uint8Array native
				blockData: multiEraBlock.block.toCborBytes(),  // Uint8Array
				block_fetch_RawCbor: newBlockRes.toCborBytes()  // Uint8Array
			};

			batchBlockRecords.set(blockHash, recordBlocks);
			batchHeaderRecords.set(blockHash, recordHeaders);

			if (batchBlockRecords.size >= 50) 
			{
				await db.insertBlockBatchVolatile(Array.from(batchBlockRecords.values()));
				await db.insertHeaderBatchVolatile(Array.from(batchHeaderRecords.values()));  // Batch headers
				batchBlockRecords.clear();
				batchHeaderRecords.clear();
			};	

			volatileDbGcCounter++;
			if (volatileDbGcCounter >= 2160) 
			{
				// logger.debug("Running volatile to immutable DB GC...");
				volatileDbGcCounter = 0;
				await db.compact();
			};
			// logger.debug(`Validated - Era: ${era} - Epoch: ${blockEpoch} - Block Header Hash: ${toHex(blockHeaderHash)} - Absolute Slot: ${blockSlot} - Total Percent Complete: ${((Number(blockSlot) / Number(msg.tip)) * 100).toFixed(2)}%`);
			// prettyBlockValidationLog(era, Number(blockEpoch), blockHeaderHash, blockSlot, tip, volatileDbGcCounter, batchBlockRecords.size);			
		} catch (error) {
			logger.error(`Error processing rollForward for peer ${msg.peerId}:`, error);
		}
	};

	if (msg.type === "terminate") 
	{
		const { peerId } = msg;
		const peer = allPeers.get(peerId);
		if (peer) {
			peer.terminate();
			allPeers.delete(peerId);
			hotPeers = hotPeers.filter(p => p.peerId !== peerId);
			warmPeers = warmPeers.filter(p => p.peerId !== peerId);
			coldPeers = coldPeers.filter(p => p.peerId !== peerId);
			bootstrapPeers = bootstrapPeers.filter(p => p.peerId !== peerId);
			newPeers = newPeers.filter(p => p.peerId !== peerId);
			logger.debug(`Terminated peer ${peerId}`);
		}
	};

	if (msg.type === "move") 
	{
		const { peerId, category } = msg;
		const peer = allPeers.get(peerId);
		if (peer) {
			hotPeers = hotPeers.filter(p => p.peerId !== peerId);
			warmPeers = warmPeers.filter(p => p.peerId !== peerId);
			coldPeers = coldPeers.filter(p => p.peerId !== peerId);
			bootstrapPeers = bootstrapPeers.filter(p => p.peerId !== peerId);
			newPeers = newPeers.filter(p => p.peerId !== peerId);
			switch (category) {
				case "hot":
				hotPeers.push(peer);
				break;
				case "warm":
				warmPeers.push(peer);
				break;
				case "cold":
				coldPeers.push(peer);
				break;
				case "bootstrap":
				bootstrapPeers.push(peer);
				break;
				case "new":
				newPeers.push(peer);
				break;
			}
			logger.debug(`Moved peer ${peerId} to ${category}`);
		}
	};

	if (msg.type === "shutdown") {
		for (const peer of allPeers.values()) {
			peer.terminate();
		};
		allPeers.clear();
		hotPeers = [];
		warmPeers = [];
		coldPeers = [];
		bootstrapPeers = [];
		newPeers = [];
		logger.debug("PeerClient worker shut down");
		parentPort!.postMessage({ type: "shutdownComplete" });
	};
});