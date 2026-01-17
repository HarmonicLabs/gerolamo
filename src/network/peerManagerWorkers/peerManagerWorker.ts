import { parentPort, workerData, Worker } from "worker_threads";
import { logger } from "../../utils/logger";
import { parseTopology } from "../topology/parseTopology";
import { type Topology } from "../topology/topology";
import type { ShelleyGenesisConfig } from "../../types/ShelleyGenesisTypes";
import type { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { Hash32 } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "../peerClientWorkers/PeerClient";
import { GlobalSharedMempool } from "../SharedMempool";


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
	readonly dbPath: string;
	readonly port?: number;
	readonly unixSocket?: boolean;
	readonly logs: {
		readonly logToFile: boolean;
		readonly logToConsole: boolean;
		readonly logDirectory: string;
	};
	readonly snapshot: {
		readonly enable: boolean;
		readonly source: string;
	};
	readonly tuiEnabled?: boolean;
	allPeers: Map<string, PeerClient>;
};

// export interface IPeerManager {
//     allPeers: Map<string, PeerClient>;
//     hotPeers: PeerClient[];
//     warmPeers: PeerClient[];
//     coldPeers: PeerClient[];
//     newPeers: PeerClient[];
//     bootstrapPeers: PeerClient[];
//     config: GerolamoConfig;
//     topology: Topology;
//     shelleyGenesisConfig: ShelleyGenesisConfig;  
// };

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
	rollForwardCborBytes: Uint8Array;
};

function setupPeerClientListener() {
	peerClientWorker.on("message", async (msg: IMsg) => {
		try {
			if (msg.type === "headerValidated"){
				logger.debug(`Header validated for peer ${msg.peerId}`);
			};
		
			if (msg.type === "blockFetched")
			{
				logger.debug(`Block fetched for peer ${msg.peerId}`);
			};
			if (msg.type === "rollForward")
			{
				// ** FOrwarding the rollForward to peerClientWorker now, later this will be sent to consensus worker ** //
				peerClientWorker.postMessage({ 
					type: "rollForward",
					peerId: msg.peerId,
					rollForwardCborBytes: msg.rollForwardCborBytes,
					tip: msg.tip
				});	
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

		} catch (error) {
			logger.error("Error in peerClientWorker message handler:", error);
		}
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
			logger.debug(`Peer ${peerId} added to ${category} category`);
			resolve();
		});
	});
};

parentPort!.on("message", async (msg: any) => {
	try {
		if (msg.type === "init") {
			config = workerData as GerolamoConfig;
			logger.setLogConfig(config.logs);
			if (config.tuiEnabled) {
				logger.setLogConfig({ logToConsole: false });
			}
			topology = await parseTopology(config.topologyFile);
			const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
			shelleyGenesisConfig = await shelleyGenesisFile.json();
			await initPeerClientWorker();
			GlobalSharedMempool.getInstance();
			logger.mempool("Global SharedMempool initialized in PeerManagerWorker");
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

		if (msg.type === "submitTx") {
			// logger.info(`PeerManagerWorker: forwarding submitTx to peerClientWorker`, msg);
			peerClientWorker.postMessage(msg);
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
	} catch (error) {
		logger.error("Error in peerManager message handler:", error);
	}
});