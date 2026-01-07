import {
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    PeerAddress,
    PeerAddressIPv4,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import {
    PeerClient,
    HeaderValidatedCallback,
    BlockFetchedCallback,
    RollbackCallback,
} from "./PeerClient";
import { logger } from "../utils/logger";
import {
    adaptLegacyTopology,
    isLegacyTopology,
    isTopology,
    Topology,
    TopologyRoot,
} from "./topology";
import { uint32ToIpv4 } from "./utils/uint32ToIpv4";
import topologyJson from "../config/topology.json" with { type: "json" };

import { ChainManager } from "./ChainManager";
import { putHeader } from "./sql";
import { Hash32 } from "@harmoniclabs/cardano-ledger-ts";

//This class is not being used anymore in flavor of workers however
//still need to move the interfaces from here.

export class PeerManager {
    allPeers: Map<string, PeerClient>;
    hotPeers: PeerClient[];
    warmPeers: PeerClient[];
    coldPeers: PeerClient[];
    newPeers: PeerClient[];
    bootstrapPeers: PeerClient[];
    networkMagic: number;
    topology: Topology;

    constructor() {
        this.allPeers = new Map<string, PeerClient>();
        this.hotPeers = [];
        this.warmPeers = [];
        this.coldPeers = [];
        this.newPeers = [];
        this.bootstrapPeers = [];
        this.networkMagic = 0;
        this.topology = {} as Topology; // Will be set in initPeerManager
    }

    /**
     * Initializes the peer manager with network configuration
     */
    async init(networkMagic: number): Promise<void> {
        this.networkMagic = networkMagic;

        // Validate the imported topology JSON
        let topology = topologyJson as any;

        // Handle legacy topology format if needed
        topology = isLegacyTopology(topology)
            ? adaptLegacyTopology(topology)
            : topology;

        // Validate the topology structure
        if (!isTopology(topology)) {
            throw new Error("Invalid topology configuration");
        }

        this.topology = topology;
        // logger.debug("Validated topology:", this.topology);
    }



    /**
     * Gets all peer clients as a readonly array
     */
    getAllPeers(): ReadonlyArray<PeerClient> {
        return Array.from(this.allPeers.values());
    }

    /**
     * Removes a peer from the manager and terminates its connection
     */
    removePeer(peerId: string): void {
        const peerClient = this.allPeers.get(peerId);
        if (peerClient) {
            // Terminate the peer connection
            peerClient.terminate();
            this.allPeers.delete(peerId);
            // Remove from all categories
            this.hotPeers = this.hotPeers.filter((p) => p.peerId !== peerId);
            this.warmPeers = this.warmPeers.filter((p) => p.peerId !== peerId);
            this.coldPeers = this.coldPeers.filter((p) => p.peerId !== peerId);
            this.bootstrapPeers = this.bootstrapPeers.filter((p) =>
                p.peerId !== peerId
            );
            this.newPeers = this.newPeers.filter((p) => p.peerId !== peerId);
        }
    }

    /**
     * Starts chain sync tasks for all hot peers
     */
    async startPeerSync(): Promise<void> {
        // logger.debug("Starting peer sync tasks...");
        // logger.log("this allpeers", this.allPeers);
        await Promise.all(this.hotPeers.map(async (peerClient) => {
            try {
                logger.log(
                    `Connecting to hot peer ${peerClient.peerId} at ${peerClient.host}:${peerClient.port} for current sync`,
                );
                await peerClient.startSync();
                // const peersAddresses = await peer.askForPeers();
                // console.log("peersAddresses: ", peersAddresses);
                // this.addNewSharedPeers(peersAddresses);
            } catch (error) {
                logger.error(
                    `Failed to initialize hot peer ${peerClient.peerId}:`,
                    error,
                );
                this.removePeer(peerClient.peerId);
            }
        }));
    }

    /**
     * Adds a new peer to the manager
     */
    async addPeer(
        host: string,
        port: number | bigint,
        category: string,
    ): Promise<string> {
        try {
            // Create peer client
            const peerClient = new PeerClient(host, port, this.networkMagic, {
                onHeaderValidated: (data) => {
                    // Store header data
                    putHeader(data.slot, data.header).catch((error) => {
                        logger.error(
                            `Failed to store header for peer ${data.peerId}`,
                            error,
                        );
                    });
                    logger.debug(
                        `Header validated: ${data.peerId}, slot ${data.slot}`,
                    );
                },
                onBlockFetched: (data) => {
                    logger.debug(
                        `Block fetched: ${data.peerId}, slot ${data.slot}`,
                    );
                },
                onRollback: (data) => {
                    logger.debug(
                        `Roll back: ${data.peerId}, point ${data.point.blockHeader?.slotNumber}`,
                    );
                },
            });

            // Initialize network components
            peerClient.initNetwork();

            // Perform handshake
            await peerClient.handshake();

            // Start keep-alive
            peerClient.startKeepAlive();

            // Add to appropriate category
            this.allPeers.set(peerClient.peerId, peerClient);
            switch (category) {
                case "hot":
                    this.hotPeers.push(peerClient);
                    break;
                case "warm":
                    this.warmPeers.push(peerClient);
                    break;
                case "cold":
                    this.coldPeers.push(peerClient);
                    break;
                case "bootstrap":
                    this.bootstrapPeers.push(peerClient);
                    break;
                case "new":
                    this.newPeers.push(peerClient);
                    break;
            }
            logger.debug(`Added peer ${peerClient.peerId} to ${category}`);
            return peerClient.peerId;
        } catch (error) {
            logger.error(`Failed to add peer ${host}:${port}`, error);
            throw error;
        }
    }

    /**
     * Shuts down the peer manager and terminates all peer connections
     */
    async shutdown(): Promise<void> {
        logger.debug("Shutting down PeerManager");
        for (const peerClient of this.allPeers.values()) {
            peerClient.terminate();
        }
    }
}
