import { logger } from "../utils/logger";
import {
    adaptLegacyTopology,
    isLegacyTopology,
    isTopology,
    type Topology,
} from "./topology";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import type { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { GlobalSharedMempool } from "./SharedMempool";

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
    readonly blockfrostUrl?: string;
    allPeers: Map<string, PeerClient>;
}

let topology: Topology;
let shelleyGenesisConfig: ShelleyGenesisConfig;
let allPeers = new Map<string, PeerClient>();
let hotPeers: PeerClient[] = [];
let warmPeers: PeerClient[] = [];
let coldPeers: PeerClient[] = [];
let bootstrapPeers: PeerClient[] = [];
let newPeers: PeerClient[] = [];
let monitorInterval: NodeJS.Timeout;

export async function initPeerManager(config: GerolamoConfig): Promise<void> {
    logger.setLogConfig(config.logs);
    if (config.tuiEnabled) {
        logger.setLogConfig({ logToConsole: false });
    }
    // Load topology using Bun.file (since dynamic imports don't work for JSON files)
    const topoFile = Bun.file(config.topologyFile);
    if (!(await topoFile.exists())) {
        throw new Error("missing topology file at " + config.topologyFile);
    }

    let parsedTopology = await topoFile.json();

    parsedTopology = isLegacyTopology(parsedTopology)
        ? adaptLegacyTopology(parsedTopology)
        : parsedTopology;

    if (!isTopology(parsedTopology)) {
        throw new Error("invalid topology file at " + config.topologyFile);
    }

    topology = parsedTopology;

    // Load Shelley genesis using Bun.file
    const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
    if (!(await shelleyGenesisFile.exists())) {
        throw new Error("missing Shelley genesis file at " + config.shelleyGenesisFile);
    }
    shelleyGenesisConfig = await shelleyGenesisFile.json();
    GlobalSharedMempool.getInstance();
    logger.mempool("Global SharedMempool initialized in PeerManager");

    if (topology.bootstrapPeers) {
        for (const ap of topology.bootstrapPeers) {
            await addPeer(
                ap.address.toString(),
                ap.port,
                "bootstrap",
                allPeers,
                bootstrapPeers,
                hotPeers,
                config,
            );
            await addPeer(
                ap.address.toString(),
                ap.port,
                "hot",
                allPeers,
                bootstrapPeers,
                hotPeers,
                config,
            );
        }
    }

    if (topology.localRoots) {
        for (const root of topology.localRoots) {
            for (const ap of root.accessPoints) {
                await addPeer(
                    ap.address,
                    ap.port,
                    "hot",
                    allPeers,
                    bootstrapPeers,
                    hotPeers,
                    config,
                );
            }
        }
    }

    logger.debug("All handshakes completed, starting sync for hot peers");
    await startSync(hotPeers, config);

    monitorInterval = setInterval(async () => {
        if (hotPeers.length === 0) {
            logger.warn("No hot peers left, replenishing from topology");
            await replenishPeers(
                topology,
                allPeers,
                bootstrapPeers,
                hotPeers,
                config,
            );
        }
    }, 30000);
}

async function addPeer(
    host: string,
    port: number | bigint,
    category: string,
    allPeers: Map<string, PeerClient>,
    bootstrapPeers: PeerClient[],
    hotPeers: PeerClient[],
    config: GerolamoConfig,
): Promise<void> {
    try {
        const peer = new PeerClient(host, port, config, (peerId) => {
            // onTerminate
            const peer = allPeers.get(peerId);
            if (peer) {
                allPeers.delete(peerId);
                hotPeers = hotPeers.filter((p) => p.peerId !== peerId);
                warmPeers = warmPeers.filter((p) => p.peerId !== peerId);
                coldPeers = coldPeers.filter((p) => p.peerId !== peerId);
                bootstrapPeers = bootstrapPeers.filter((p) =>
                    p.peerId !== peerId
                );
                newPeers = newPeers.filter((p) => p.peerId !== peerId);
                logger.debug(`Terminated peer ${peerId}`);
            }
        });
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
        logger.debug(`Added peer ${peer.peerId} to ${category} category`);
    } catch (error) {
        logger.error(`Failed to add peer ${host}:${port}`, error);
    }
}

async function startSync(
    hotPeers: PeerClient[],
    config: GerolamoConfig,
): Promise<void> {
    logger.debug(`Starting sync for peers`);
    for (const peer of hotPeers) {
        try {
            await peer.startSyncLoop();
            logger.debug(`Started sync for peer ${peer.peerId}`);
        } catch (error) {
            logger.error(`Failed to start sync for peer ${peer.peerId}`, error);
        }
    }
}

async function replenishPeers(
    topology: Topology,
    allPeers: Map<string, PeerClient>,
    bootstrapPeers: PeerClient[],
    hotPeers: PeerClient[],
    config: GerolamoConfig,
): Promise<void> {
    if (topology.bootstrapPeers) {
        for (const ap of topology.bootstrapPeers) {
            await addPeer(
                ap.address.toString(),
                ap.port,
                "hot",
                allPeers,
                bootstrapPeers,
                hotPeers,
                config,
            );
        }
    }

    if (topology.localRoots) {
        for (const root of topology.localRoots) {
            for (const ap of root.accessPoints) {
                await addPeer(
                    ap.address,
                    ap.port,
                    "hot",
                    allPeers,
                    bootstrapPeers,
                    hotPeers,
                    config,
                );
            }
        }
    }

    await startSync(hotPeers, config);

    // Try to discover more peers
    if (hotPeers.length > 0) {
        const somePeer = hotPeers[0];
        somePeer.askForPeers().then((peers) => {
            for (const p of peers) {
                addPeer(
                    p.address.toString(),
                    p.portNumber,
                    "hot",
                    allPeers,
                    bootstrapPeers,
                    hotPeers,
                    config,
                );
            }
        }).catch((err) =>
            logger.error(`Failed to get peers from ${somePeer.peerId}`, err)
        );
    }
}
