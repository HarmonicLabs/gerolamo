import {
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    PeerAddress,
    PeerAddressIPv4,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import {
    BlockFetchedCallback,
    createPeer,
    handshakePeer,
    HeaderValidatedCallback,
    initializePeerNetwork,
    PeerState,
    RollbackCallback,
    startKeepAlive,
    startSyncLoop,
    terminatePeer,
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

export interface PeerManagerState {
    allPeers: Map<string, PeerState>;
    hotPeers: PeerState[];
    warmPeers: PeerState[];
    coldPeers: PeerState[];
    newPeers: PeerState[];
    bootstrapPeers: PeerState[];
    networkMagic: number;
    topology: Topology;
}

/**
 * Creates an initial PeerManager state object
 */
export function createPeerManager(): PeerManagerState {
    return {
        allPeers: new Map<string, PeerState>(),
        hotPeers: [],
        warmPeers: [],
        coldPeers: [],
        newPeers: [],
        bootstrapPeers: [],
        networkMagic: 0,
        topology: {} as Topology, // Will be set in initPeerManager
    };
}

/**
 * Initializes the peer manager state with network configuration
 */
export async function initPeerManager(
    state: PeerManagerState,
    networkMagic: number,
): Promise<void> {
    state.networkMagic = networkMagic;

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

    state.topology = topology;
    // logger.debug("Validated topology:", state.topology);
}

/**
 * Gets all peer states as a readonly array
 */
export function getAllPeers(state: PeerManagerState): ReadonlyArray<PeerState> {
    return Array.from(state.allPeers.values());
}

/**
 * Removes a peer from the manager state and terminates its connection
 */
export function removePeerFromManager(
    state: PeerManagerState,
    peerId: string,
): void {
    const peerState = state.allPeers.get(peerId);
    if (peerState) {
        // Terminate the peer connection
        terminatePeer(peerState);
        state.allPeers.delete(peerId);
        // Remove from all categories
        state.hotPeers = state.hotPeers.filter((p) => p.peerId !== peerId);
        state.warmPeers = state.warmPeers.filter((p) => p.peerId !== peerId);
        state.coldPeers = state.coldPeers.filter((p) => p.peerId !== peerId);
        state.bootstrapPeers = state.bootstrapPeers.filter((p) =>
            p.peerId !== peerId
        );
        state.newPeers = state.newPeers.filter((p) => p.peerId !== peerId);
    }
}

/**
 * Starts chain sync tasks for all hot peers
 */
export async function peerSyncCurrentTasks(
    state: PeerManagerState,
): Promise<void> {
    // logger.debug("Starting peer sync tasks...");
    // logger.log("this allpeers", state.allPeers);
    await Promise.all(state.hotPeers.map(async (peerState) => {
        try {
            logger.log(
                `Connecting to hot peer ${peerState.peerId} at ${peerState.host}:${peerState.port} for current sync`,
            );
            await startSyncLoop(peerState);
            // const peersAddresses = await peer.askForPeers();
            // console.log("peersAddresses: ", peersAddresses);
            // this.addNewSharedPeers(peersAddresses);
        } catch (error) {
            logger.error(
                `Failed to initialize hot peer ${peerState.peerId}:`,
                error,
            );
            removePeerFromManager(state, peerState.peerId);
        }
    }));
}

/**
 * Adds a new peer to the manager state
 */
export async function addPeerToManager(
    state: PeerManagerState,
    host: string,
    port: number | bigint,
    category: string,
): Promise<string> {
    try {
        // Create peer state
        const peerState = await createPeer(host, port, state.networkMagic, {
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
        initializePeerNetwork(peerState);

        // Perform handshake
        await handshakePeer(peerState);

        // Start keep-alive
        startKeepAlive(peerState);

        // Add to appropriate category
        state.allPeers.set(peerState.peerId, peerState);
        switch (category) {
            case "hot":
                state.hotPeers.push(peerState);
                break;
            case "warm":
                state.warmPeers.push(peerState);
                break;
            case "cold":
                state.coldPeers.push(peerState);
                break;
            case "bootstrap":
                state.bootstrapPeers.push(peerState);
                break;
            case "new":
                state.newPeers.push(peerState);
                break;
        }
        logger.debug(`Added peer ${peerState.peerId} to ${category}`);
        return peerState.peerId;
    } catch (error) {
        logger.error(`Failed to add peer ${host}:${port}`, error);
        throw error;
    }
}

/**
 * Shuts down the peer manager and terminates all peer connections
 */
export async function shutdownPeerManager(
    state: PeerManagerState,
): Promise<void> {
    logger.debug("Shutting down PeerManager");
    for (const peerState of state.allPeers.values()) {
        terminatePeer(peerState);
    }
}
