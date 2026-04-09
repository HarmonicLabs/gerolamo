import { logger } from "../utils/logger";
import {
    adaptLegacyTopology,
    isLegacyTopology,
    isTopology,
    type Topology,
} from "./topology";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import type { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { GlobalSharedMempool } from "./SharedMempool";
import { headerParser, blockParser } from "../consensus/blockHeaderParser";
import {
    insertBlockBatchVolatile,
    insertHeaderBatchVolatile,
    applyTransaction,
    rollbackChainTo,
    maybeCompact,
} from "../db";
import { applyBlock } from "../consensus/BlockApplication";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

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

export function getHotPeers(): PeerClient[] { return hotPeers; }
export function getAllPeersMap(): Map<string, PeerClient> { return allPeers; }

export async function initPeerManager(config: GerolamoConfig): Promise<{ allPeers: Map<string, PeerClient>; hotPeers: PeerClient[] }> {
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

    // Wire rollForward/rollBack handlers to store blocks in DB
    for (const peer of hotPeers) {
        peer.onRollForward = async (peerId, cborBytes, tip) => {
            try {
                const parsed = await headerParser(cborBytes);
                if (!parsed) { logger.warn(`Header parse failed for ${peerId}`); return; }

                const slot = parsed.slot;
                const hash = toHex(parsed.blockHeaderHash);
                logger.info(`rollForward slot=${slot} hash=${hash.slice(0, 16)}... tip=${tip} peer=${peerId}`);

                // Fetch full block from peer
                const fetchedBlock = await peer.fetchBlock(slot, parsed.blockHeaderHash);
                let multiEraBlock: MultiEraBlock | undefined;
                try { multiEraBlock = await blockParser(fetchedBlock); } catch (e: any) {
                    logger.warn(`Block parse failed for peer ${peerId} at slot ${slot}: ${e.message}`);
                }

                // Store header
                await insertHeaderBatchVolatile([{
                    slot: BigInt(slot),
                    headerHash: hash,
                    rollforward_header_cbor: cborBytes.slice(),
                }]);

                // Store block
                const prevHash = multiEraBlock?.block?.header?.body?.prevHash;
                await insertBlockBatchVolatile([{
                    slot: BigInt(slot),
                    blockHash: hash,
                    prevHash: prevHash ? toHex(prevHash) : "",
                    headerData: parsed.multiEraHeader?.toCborBytes?.() ?? cborBytes,
                    blockData: multiEraBlock?.block?.toCborBytes?.() ?? new Uint8Array(0),
                    block_fetch_RawCbor: fetchedBlock?.toCborBytes?.() ?? new Uint8Array(0),
                }]);

                // Apply transactions (UTxO tracking)
                if (multiEraBlock?.block) {
                    try {
                        await applyBlock(multiEraBlock.block as any, BigInt(slot), parsed.blockHeaderHash);
                    } catch (e: any) {
                        logger.warn(`applyBlock error (non-fatal): ${e.message}`);
                    }
                }

                logger.info(`Block stored: slot=${slot} hash=${hash.slice(0, 16)}...`);
                await maybeCompact();
            } catch (e: any) {
                logger.error(`rollForward handler error: ${e.message}`);
            }
        };
        peer.onRollBack = async (_peerId, point) => {
            if (point?.blockHeader?.slotNumber) {
                logger.info(`rollBack to slot ${point.blockHeader.slotNumber}`);
                try { await rollbackChainTo(BigInt(point.blockHeader.slotNumber)); } catch (e: any) {
                    logger.error(`Rollback failed to slot ${point.blockHeader.slotNumber}: ${e.message}`);
                }
            }
        };
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

    return { allPeers, hotPeers };
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
    // Dedup check: skip if we already have a connection to this host:port
    const hostPort = `${host}:${port}`;
    for (const [existingId] of allPeers) {
        if (existingId.startsWith(hostPort + ":")) return;
    }

    try {
        const peer = new PeerClient(host, port, config, shelleyGenesisConfig, (peerId) => {
            // onTerminate — use module-level arrays directly to avoid stale closure refs
            if (allPeers.has(peerId)) {
                allPeers.delete(peerId);
                const removeFrom = (arr: PeerClient[]) => {
                    const idx = arr.findIndex((p) => p.peerId === peerId);
                    if (idx !== -1) arr.splice(idx, 1);
                };
                removeFrom(hotPeers);
                removeFrom(warmPeers);
                removeFrom(coldPeers);
                removeFrom(bootstrapPeers);
                removeFrom(newPeers);
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
        try {
            const peers = await somePeer.askForPeers();
            for (const p of peers) {
                await addPeer(
                    p.address.toString(),
                    p.portNumber,
                    "hot",
                    allPeers,
                    bootstrapPeers,
                    hotPeers,
                    config,
                );
            }
        } catch (err) {
            logger.error(`Failed to get peers from ${somePeer.peerId}`, err);
        }
    }
}
