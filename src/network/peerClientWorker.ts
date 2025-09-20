import { parentPort, workerData } from "worker_threads";
import { PeerClient } from "./PeerClient";
import { GerolamoConfig } from "./PeerManager";
import { logger } from "../utils/logger";

let config: GerolamoConfig;
let allPeers = new Map<string, PeerClient>();
let hotPeers: PeerClient[] = [];
let warmPeers: PeerClient[] = [];
let coldPeers: PeerClient[] = [];
let bootstrapPeers: PeerClient[] = [];
let newPeers: PeerClient[] = [];

parentPort!.on("message", async (msg: any) => {
  if (msg.type === "init") {
    config = msg.config;
    logger.debug("PeerClient worker initialized");
    parentPort!.postMessage({ type: "started" });
  }

  if (msg.type === "addPeer") {
    const { host, port, category } = msg;
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
    } catch (error) {
      logger.error(`Failed to add peer ${host}:${port}`, error);
    }
  }

  if (msg.type === "startSync") {
    const { peerIds } = msg;
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
  }

  if (msg.type === "terminate") {
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
  }

  if (msg.type === "move") {
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
  }

  if (msg.type === "shutdown") {
    for (const peer of allPeers.values()) {
      peer.terminate();
    }
    allPeers.clear();
    hotPeers = [];
    warmPeers = [];
    coldPeers = [];
    bootstrapPeers = [];
    newPeers = [];
    logger.debug("PeerClient worker shut down");
    parentPort!.postMessage({ type: "shutdownComplete" });
  }
});