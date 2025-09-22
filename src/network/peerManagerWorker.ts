import { parentPort, workerData, Worker } from "worker_threads";
import { GerolamoConfig } from "./PeerManager";
import { logger } from "../utils/logger";
import { parseTopology } from "./topology/parseTopology";
import { Topology, TopologyRoot } from "./topology/topology";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { putHeader } from "./lmdbWorkers/lmdb";

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
	peerClientWorker = new Worker("./src/network/peerClientWorker.ts");
	peerClientWorker.postMessage({ type: "init", config });
	return new Promise((resolve) => {
		peerClientWorker.on("message", (msg) => {
		if (msg.type === "started") {
			resolve(true);
		}
		});
	});;
};

function setupPeerClientListener() {
	peerClientWorker.on("message", async (msg: any) => {
		// logger.debug(`Validated - Era: ${multiEraHeader.era} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tip} - Percent Complete: ${((Number(slot) / Number(tip)) * 100).toFixed(2)}%`);
		if (msg.type === "headerValidated") {
		await putHeader(msg.slot, msg.blockHeaderHash, msg.headerData);
		logger.debug(`Header validated: ${msg.peerId}, slot ${msg.slot}`);
		logger.debug(`Validated - Era: ${msg.era} - Epoch: ${msg.epoch} - Slot: ${msg.slot} of ${msg.tip} - Percent Complete: ${((Number(msg.slot) / Number(msg.tip)) * 100).toFixed(2)}%`);
		};
		if (msg.type === "blockFetched") {
		logger.debug(`Block fetched: ${msg.peerId}, slot ${msg.slot}`);
		};
		if (msg.type === "rollBack") {
		logger.debug(`Roll back: ${msg.peerId}, point ${msg.point.blockHeader?.slotNumber}`);
		};
		if (msg.type === "peerAdded") {
		peerAddedResolvers.get(msg.addId)?.(msg.peerId);
		peerAddedResolvers.delete(msg.addId);
		};
	});
}

async function addPeer(host: string, port: number | bigint, category: string) {
	const addId = `${host}:${port}:${Math.floor(Date.now() / 1000)}`;
	peerClientWorker.postMessage({ type: "addPeer", host, port, category, addId });
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

