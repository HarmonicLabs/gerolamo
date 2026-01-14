import { parentPort, workerData } from "worker_threads";
import { PeerClient } from "./PeerClient";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";
import { logger } from "../../utils/logger";
import { headerParser, blockParser } from "../../utils/blockParsers";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import type { BlockFetchNoBlocks, BlockFetchBlock } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../../tui/tui";
import { calculatePreProdCardanoEpoch } from "../../utils/epochFromSlotCalculations";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { insertBlockVolatile, insertBlockBatchVolatile, insertHeaderBatchVolatile } from "../../db/writeDB";
import { gcVolatileToImmutable } from "../../db/volatileDBTools";

let config: GerolamoConfig;
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
    const { peerId, rollForwardCborBytes, tip } = msg;
		const peer = allPeers.get(peerId);
		if(!(peer)) {
			logger.error(`Peer ${peerId} not found for rollForward processing`);
			return;
		};
		const headerValidationRes = await headerParser(rollForwardCborBytes);
		if (!(
		    headerValidationRes
		)) {
		    logger.debug("header validaiotn failed");
		    return;
		};

		let currentEpoch: number | null = null;
		let firstEpochSlot: number | null = null;

		const newBlockRes: BlockFetchNoBlocks | BlockFetchBlock = await peer.fetchBlock(headerValidationRes.slot, headerValidationRes.blockHeaderHash);
		const multiEraBlock: MultiEraBlock | undefined = await blockParser(newBlockRes);
		
		// logger.debug("Parsed MultiEraBlock: ", multiEraBlock);
		if (!(multiEraBlock instanceof MultiEraBlock)) 
		{
		    logger.log(`Block validation failed for peer ${peerId} at slot ${headerValidationRes.slot}`);			
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
			prevHash: "",  // TODO: blockHeader.body.prevHash.toHex()
			headerData: blockHeader.toCborBytes(),  // Uint8Array native
			blockData: multiEraBlock.block.toCborBytes(),  // Uint8Array
			block_fetch_RawCbor: newBlockRes.toCborBytes()  // Uint8Array
		};

		batchBlockRecords.set(blockHash, recordBlocks);
		batchHeaderRecords.set(blockHash, recordHeaders);

		if (batchBlockRecords.size >= 50) 
		{
			await insertBlockBatchVolatile(Array.from(batchBlockRecords.values()));
			await insertHeaderBatchVolatile(Array.from(batchHeaderRecords.values()));  // Batch headers
			batchBlockRecords.clear();
			batchHeaderRecords.clear();
		};	

		volatileDbGcCounter++;
		if (volatileDbGcCounter >= 2160) 
		{
			// logger.debug("Running volatile to immutable DB GC...");
			volatileDbGcCounter = 0;
			await gcVolatileToImmutable();
		};
		// logger.debug(`Validated - Era: ${era} - Epoch: ${blockEpoch} - Block Header Hash: ${toHex(blockHeaderHash)} - Absolute Slot: ${blockSlot} of ${msg.tip} - Total Percent Complete: ${((Number(blockSlot) / Number(msg.tip)) * 100).toFixed(2)}%`);
		prettyBlockValidationLog(era, Number(blockEpoch), blockHeaderHash, blockSlot, tip, volatileDbGcCounter, batchBlockRecords.size);			
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