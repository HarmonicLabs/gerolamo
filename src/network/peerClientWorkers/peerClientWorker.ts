import { parentPort, workerData } from "worker_threads";
import { DB } from "../../db/DB";
import { logger } from "../../utils/logger";
import { ConsensusOrchestrator } from "../../consensus/ConsensusOrchestratooor";
import type { PeerAccessor } from "../../consensus/ConsensusOrchestratooor";
import type { GerolamoConfig } from "../peerManagerWorkers/peerManagerWorker";
import { PeerClient } from "./PeerClient";

let config: GerolamoConfig;
let db: DB;
let allPeers = new Map<string, PeerClient>();
let hotPeers: PeerClient[] = [];
let warmPeers: PeerClient[] = [];
let coldPeers: PeerClient[] = [];
let bootstrapPeers: PeerClient[] = [];
let newPeers: PeerClient[] = [];
let orchestrator: ConsensusOrchestrator;

parentPort!.on("message", async (msg: any) => {
	if (msg.type === "init") 
	{
		config = msg.config;
		db = new DB(config.dbPath);
		const peerAccessor: PeerAccessor = {
			getPeer: (id: string) => allPeers.get(id) ?? null,
			pickHotPeer: () => hotPeers[0] ?? null
		};
		orchestrator = new ConsensusOrchestrator(config, db, peerAccessor);
		logger.setLogConfig(config.logs);
		logger.debug("PeerClient worker initialized");
		parentPort!.postMessage({ type: "started" });
	};

	if (msg.type === "addPeer") 
	{
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
		};
	};

	if (msg.type === "startSync") 
	{
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
				};
			};
		};
	};

	if (msg.type === "rollForward") 
	{
		logger.info(`Processing rollForward message from peer ${msg.peerId}...`);
		try {
			await orchestrator.handleRollForward(msg.rollForwardCborBytes, msg.peerId, msg.tip);
		} catch (error) {
			logger.error(`Error processing rollForward for peer ${msg.peerId}:`, error);
		}
	};

	if (msg.type === "rollBack") 
	{
		await orchestrator.handleRollBack(msg.point);
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

	if (msg.type === "shutdown")
	{
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

	if (msg.type === "submitTx") 
	{
		logger.mempool(`PeerClientWorker: submitting tx to ${hotPeers.length} hot peers`);
		const results: Array<{ peerId: string; success: boolean; }> = [];
		for (const peer of hotPeers) {
			try {
				const ok = await peer.submitToSharedMempool(msg.txCbor);
				results.push({ peerId: peer.peerId, success: true });
				logger.mempool(`Tx submitted to ${peer.peerId}:`, ok);
			} catch (e: any) {
				logger.mempool(`Tx submit failed to ${peer.peerId}:`, e.message || e);
				results.push({ peerId: peer.peerId, success: false });
			}
		}
		logger.mempool(`Tx submit complete: ${results.filter(r => r.success).length}/${results.length} hot peers`);
	}
});