import { parentPort, workerData, Worker } from "worker_threads";
import { logger } from "../../utils/logger";
import { parseTopology } from "../topology/parseTopology";
import { Topology } from "../topology/topology";
import { ShelleyGenesisConfig } from "../../config/preprod/ShelleyGenesisTypes";
import { putHeader, putEpochNonce, getEpochNonce, getLastSlot } from "../lmdbWorkers/lmdb";
import { Hash32, MultiEraBlock, NetworkT, VrfProofBytes, VrfProofHash, VrfCert, BabbageHeaderBody, ConwayHeaderBody } from "@harmoniclabs/cardano-ledger-ts";
import { calcEpochNonce } from "../utils/calcEpochNonce";
import { PeerClient } from "../peerClientWorkers/PeerClient";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { Cbor, CborArray, CborBytes, CborTag, LazyCborArray } from "@harmoniclabs/cbor"
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { blake2b_256 } from "@harmoniclabs/crypto";
import { blockFrostFetchEra } from "../utils/blockFrostFetchEra";
export interface GerolamoConfig {
    readonly network: NetworkT;
    readonly networkMagic: number;
    readonly topologyFile: string;
    readonly syncFromTip: boolean;
    readonly syncFromGenesis: boolean;
    readonly genesisBlockHash: string;
    readonly syncFromPoint: boolean;
    readonly syncFromPointSlot: bigint;
    readonly syncFromPointBlockHash: string;
    readonly logLevel: string;
    readonly shelleyGenesisFile: string;
    readonly enableMinibf?: boolean;
    allPeers: Map<string, PeerClient>;
};

export interface IPeerManager {
    allPeers: Map<string, PeerClient>;
    hotPeers: PeerClient[];
    warmPeers: PeerClient[];
    coldPeers: PeerClient[];
    newPeers: PeerClient[];
    bootstrapPeers: PeerClient[];
    config: GerolamoConfig;
    topology: Topology;
    shelleyGenesisConfig: ShelleyGenesisConfig;  
};

let config: GerolamoConfig;
let topology: Topology;
let shelleyGenesisConfig: ShelleyGenesisConfig;
let peerClientWorker: Worker;
let allPeerIds = new Map<string, string>(); // peerId -> category
let hotPeerIds: string[] = [];
let warmPeerIds: string[] = [];
let coldPeerIds: string[] = [];
let bootstrapPeerIds: string[] = [];
let newPeerIds: string[] = [];
const peerAddedResolvers = new Map<string, (peerId: string) => void>();

async function initPeerClientWorker() {
	peerClientWorker = new Worker("./src/network/peerClientWorkers/peerClientWorker.ts");
	peerClientWorker.postMessage({ type: "init", config });
	return new Promise((resolve) => {
		peerClientWorker.on("message", (msg) => {
		if (msg.type === "started") {
			resolve(true);
		}
		});
	});;
};

export interface IMsg { 
	type: string;
	peerId: string;
	multiEraBlock: Uint8Array;
	tip: number | bigint;
	addId: string;
	point: {
		blockHeader?: {
			slotNumber: bigint;
			blockHash: Uint8Array | Hash32;
		};
	};
}

let currentEpoch: number | null = null;
let rollingNonce = new Uint8Array(32).fill(0);
let firstEpochSlot: number | null = null;
let lastEpochSlot: number | null = null
let prevEpochLastSlot: number | null = null; 
let currentRollingNonces: { [key: number]: Uint8Array }[] = [];
let currentEpochHeaderHashes: { [key: number]: Uint8Array }[] = [];
let vrfOutput: Uint8Array;
let currentVrfOutputs: { [key: number]: Uint8Array; }[] = [];

function setupPeerClientListener() {
	peerClientWorker.on("message", async (msg: IMsg) => {
		if (msg.type === "headerValidated"){

		};
		
		if (msg.type === "blockFetched")
		{
			// logger.debug(`Block fetched: ${msg.peerId}, tip ${msg.tip}`);
			const multiEraBLockParsed = MultiEraBlock.fromCbor(msg.multiEraBlock);
			// logger.debug("Block: ", toHex(multiEraBLockParsed.block.toCborBytes()))
			const era = multiEraBLockParsed.era;
			// logger.debug("Era: ", era);
			const blockHeader = multiEraBLockParsed.block.header;
			// logger.debug("Block Header: ", blockHeader);
			const blockSlot = Number(blockHeader.body.slot);
			// logger.debug("Slot: ", slot);
			const blockEpoch = calculatePreProdCardanoEpoch(Number(blockSlot));
			// logger.debug("Epoch: ", blockEpoch);
			const blockHeaderHash = blake2b_256(blockHeader.toCborBytes());
			// logger.debug("Block Header Hash: ", toHex(blockHeaderHash));
			const epochNonce = await blockFrostFetchEra(blockEpoch as number);
			// logger.debug("Epoch Nonce: ", epochNonce);

			// const nonceVrfCert: VrfCert = blockHeader.header.body instanceof BabbageHeaderBody || multiEraHeader.header.body instanceof ConwayHeaderBody ? multiEraHeader.header.body.vrfResult : multiEraHeader.header.body.nonceVrfResult;
			const nonceVrfProofBytes: VrfProofBytes = blockHeader.body instanceof BabbageHeaderBody || blockHeader.body instanceof ConwayHeaderBody ? blockHeader.body.vrfResult.proof : blockHeader.body.nonceVrfResult.proof;
			const nonceVrfProofHash: VrfProofHash = blockHeader.body instanceof BabbageHeaderBody || blockHeader.body instanceof ConwayHeaderBody ? blockHeader.body.vrfResult.proofHash : blockHeader.body.nonceVrfResult.proofHash;

			vrfOutput = nonceVrfProofHash.subarray(0, 32);
			currentVrfOutputs.push({ [Number(blockSlot)]: vrfOutput });

			if ( currentEpoch === null) currentEpoch = Number(blockEpoch);
			if ( firstEpochSlot === null) firstEpochSlot = Number(blockSlot);
			if ( currentEpoch && currentEpoch < blockEpoch ) calcEpochNonce(currentEpoch, shelleyGenesisConfig, Number(blockSlot));
			if ( currentEpoch && currentEpoch < blockEpoch ) firstEpochSlot = Number(blockSlot);
			if ( currentEpoch && currentEpoch < blockEpoch ) rollingNonce = new Uint8Array(32);
			if ( currentEpoch && currentEpoch < blockEpoch ) currentRollingNonces = [];
			if ( currentEpoch && currentEpoch < blockEpoch ) currentVrfOutputs = [];
			if ( currentEpoch && currentEpoch < blockEpoch ) currentEpoch = Number(blockEpoch);

			await putHeader(epochNonce, blockEpoch, blockSlot, blockHeaderHash, blockHeader.toCborBytes(), currentRollingNonces, currentEpochHeaderHashes, currentVrfOutputs);
			// logger.debug(`Validated - Era: ${era} - Epoch: ${blockEpoch} - Block Header Hash: ${toHex(blockHeaderHash)} - Absolute Slot: ${blockSlot} of ${msg.tip} - Total Percent Complete: ${((Number(blockSlot) / Number(msg.tip)) * 100).toFixed(2)}%`);
			prettyBlockValidationLog(era, Number(blockEpoch), blockHeaderHash, blockSlot, msg.tip, toHex)
		};

		if (msg.type === "rollBack")
		{
			logger.debug(`Roll back: ${msg.peerId}, point ${msg.point.blockHeader?.slotNumber}`);
		};

		if (msg.type === "peerAdded")
		{
			peerAddedResolvers.get(msg.addId)?.(msg.peerId);
			peerAddedResolvers.delete(msg.addId);
		};
	});
};

async function addPeer(host: string, port: number | bigint, category: string) {
	const addId = `${host}:${port}:${Math.floor(Date.now() / 1000)}`;
	peerClientWorker.postMessage({
		type: "addPeer",
		host,
		port,
		category,
		addId
	});
	await new Promise<void>((resolve) => {
		peerAddedResolvers.set(addId, (peerId: string) => {
			allPeerIds.set(peerId, category);
			switch (category) {
				case "hot":
				hotPeerIds.push(peerId);
				break;
				case "warm":
				warmPeerIds.push(peerId);
				break;
				case "cold":
				coldPeerIds.push(peerId);
				break;
				case "bootstrap":
				bootstrapPeerIds.push(peerId);
				break;
				case "new":
				newPeerIds.push(peerId);
				break;
			};
			resolve();
		});
	});
};

parentPort!.on("message", async (msg: any) => {
	if (msg.type === "init") {
		config = workerData as GerolamoConfig;
		topology = await parseTopology(config.topologyFile);
		const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
		shelleyGenesisConfig = await shelleyGenesisFile.json();
		await initPeerClientWorker();
		setupPeerClientListener();
		logger.debug("PeerManager worker initialized");

		if (topology.bootstrapPeers) {
			for (const ap of topology.bootstrapPeers) {
				await addPeer(ap.address, ap.port, "bootstrap");
				await addPeer(ap.address, ap.port, "hot");
			};
		};

		if (topology.localRoots) {
			for (const root of topology.localRoots) {
				for (const ap of root.accessPoints) {
					await addPeer(ap.address, ap.port, "hot");
				};
			};
		};

		logger.debug("All handshakes completed, sending startSync for hot peers");
		peerClientWorker.postMessage({ type: "startSync", peerIds: hotPeerIds });
		parentPort!.postMessage({ type: "started" });
	};

	if (msg.type === "shutdown") {
		peerClientWorker.postMessage({ type: "shutdown" });
		peerClientWorker.on("message", (msg) => {
			if (msg.type === "shutdownComplete") {
				logger.debug("PeerManager worker shut down");
				parentPort!.postMessage({ type: "shutdownComplete" });
			}
		});
	};
});


import { stdout } from 'process'; // Bun/Node built-in
let logLines = 0; // Track lines for updates
function prettyBlockValidationLog(
	era: number,
	blockEpoch: number,
	blockHeaderHash: Uint8Array,
	blockSlot: bigint | number,
	tip: bigint | number,
	toHex?: (bytes: Uint8Array) => string
): void {
	const slotNum = Number(blockSlot);
	const tipNum = Number(tip);
	const percent = ((slotNum / tipNum) * 100).toFixed(2);
	const hashHex = toHex ? toHex(blockHeaderHash) : blockHeaderHash.toString();
	const shortHash = hashHex.slice(0, 16) + '...';

	// Progress bar
	const progressWidth = 50;
	const filled = Math.floor((slotNum / tipNum) * progressWidth);
	const progressBar = '█'.repeat(filled) + '░'.repeat(progressWidth - filled);

	// ANSI colors
	const green = '\x1b[32m';
	const yellow = '\x1b[33m';
	const reset = '\x1b[0m';
	const bold = '\x1b[1m';
	const clearLine = '\r\x1b[K'; // Carriage return + clear to end of line
	const moveUp = '\x1b[A'; // Up one line
	const moveDown = '\x1b[B'; // Down one line

	// Core lines (without trailing \n yet)
	const title = `${green}✓ BLOCK VALIDATED${reset} ${bold}(${era} Era)${reset}`;
	const details = `Epoch: ${blockEpoch.toString().padStart(4, ' ')} | Slot: ${slotNum.toLocaleString().padStart(8, ' ')} / ${tipNum.toLocaleString()} (${percent}%)`;
	const hashLine = `Header Hash: ${shortHash}`;
	const footer = `Gerolamo Sync: Forging the Chain in TS`;

	// ASCII frame (fixed width: 72 chars inner, total ~74)
	const frameTop = '╔' + '═'.repeat(70) + '╗';
	const frameMid = '║' + ' '.repeat(70) + '║';
	const frameBot = '╚' + '═'.repeat(70) + '╝';
	const linkLeft = ' ⛓ ';
	const linkRight = ' ⛓ ';

	// Build output lines array (exact 9 lines)
	const outputLines = [
		frameTop,
		`║${linkLeft}${title.padEnd(66)}${linkRight}║`,
		frameMid,
		`║${linkLeft}${details.padEnd(66)}${linkRight}║`,
		`║${linkLeft}${hashLine.padEnd(66)}${linkRight}║`,
		`║${linkLeft}Progress: [${progressBar}] ${percent}%${linkRight}║`,
		frameMid,
		`║${yellow}${footer.padEnd(70)}${reset}${linkRight}║`,
		frameBot
	];

	const totalLines = outputLines.length;

	// Clear previous block if exists
	if (logLines > 0) {
		// Move up to start of previous block and clear down
		stdout.write(`\x1b[${logLines}A\x1b[0J`); // Up to top, clear from cursor to end
	}

	// Write new block line-by-line with precise control (no extra \n)
	outputLines.forEach((line, index) => {
		if (index === 0) {
		stdout.write(clearLine + line + '\n');
		} else {
		stdout.write(line + '\n');
		}
	});

	// No need to move down; next log will overwrite from current position
	// (Cursor is now after the new block; subsequent calls will move up from there)

	logLines = totalLines; // Update for next call
}