import { parentPort, workerData, Worker } from "worker_threads";
import { logger } from "../../utils/logger";
import { parseTopology } from "../topology/parseTopology";
import { Topology } from "../topology/topology";
import { ShelleyGenesisConfig } from "../../config/preprod/ShelleyGenesisTypes";
import { putHeader, putEpochNonce, getEpochNonce, getLastSlot } from "../lmdbWorkers/lmdb";
import { Hash32, NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { calcEpochNonce } from "../utils/calcEpochNonce";
import { PeerClient } from "../peerClientWorkers/PeerClient";
import { toHex } from "@harmoniclabs/uint8array-utils";


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
	era: number | bigint;
	epochNonce: Uint8Array;
	epoch: number | bigint;
	slot: number | bigint;
	blockHeaderHash: Uint8Array;
	multiEraHeader: Uint8Array;
	nonceVrfProofBytes: Uint8Array;
	nonceVrfProofHash: Uint8Array;
	tip: number | bigint;
	addId: string;
	point: {
		blockHeader?: {
			slotNumber: bigint;
			blockHash: Uint8Array | Hash32;
		};
	};
	multiEraBlock: Uint8Array;
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

			vrfOutput = msg.nonceVrfProofHash.subarray(0, 32);
			currentVrfOutputs.push({ [Number(msg.slot)]: vrfOutput });

			if ( currentEpoch === null) currentEpoch = Number(msg.epoch);
			if ( firstEpochSlot === null) firstEpochSlot = Number(msg.slot);
			if ( currentEpoch && currentEpoch < msg.epoch ) calcEpochNonce(currentEpoch, shelleyGenesisConfig, Number(msg.slot));
			if ( currentEpoch && currentEpoch < msg.epoch ) firstEpochSlot = Number(msg.slot);
			if ( currentEpoch && currentEpoch < msg.epoch ) rollingNonce = new Uint8Array(32);
			if ( currentEpoch && currentEpoch < msg.epoch ) currentRollingNonces = [];
			if ( currentEpoch && currentEpoch < msg.epoch ) currentVrfOutputs = [];
			if ( currentEpoch && currentEpoch < msg.epoch ) currentEpoch = Number(msg.epoch);

			
			await putHeader(msg.epochNonce, msg.epoch, msg.slot, msg.blockHeaderHash, msg.multiEraHeader, currentRollingNonces, currentEpochHeaderHashes, currentVrfOutputs);
			
            logger.debug(`Validated - Era: ${msg.era} - Epoch: ${msg.epoch} - Block Header Hash: ${toHex(msg.blockHeaderHash)} - Absolute Slot: ${msg.slot} of ${msg.tip} - Total Percent Complete: ${((Number(msg.slot) / Number(msg.tip)) * 100).toFixed(2)}%`);
		};
		
		if (msg.type === "blockFetched")
		{
			// logger.debug(`Block fetched: ${msg.peerId}, slot ${msg.slot}`);
			// logger.debug(toHex(msg.multiEraBlock));
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

