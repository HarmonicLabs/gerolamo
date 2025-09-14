import {
    ChainPoint,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    PeerAddress,
    PeerAddressIPv4,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { MultiEraHeader, NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { logger } from "./utils/logger";
import { parseTopology } from "./topology/parseTopology";
import { Topology, TopologyRoot } from "./topology/topology";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { headerValidation } from "./headerValidation";
import { fetchBlock } from "./fetchBlocks";
import { uint32ToIpv4 } from "./utils/uint32ToIpv4";
import { getHeader, putBlock, putHeader } from "./sqlWorkers/sql";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { RawNewEpochState } from "../rawNES";
import { toHex } from "@harmoniclabs/uint8array-utils";
import "./minibf/expressServer";

export interface GerolamoConfig {
    readonly network: NetworkT;
    readonly topologyFile: string;
    readonly syncFromTip: boolean;
    readonly syncFromGenesis: boolean;
    readonly genesisBlockHash: string;
    readonly syncFromPoint: boolean;
    readonly syncFromPointSlot: bigint;
    readonly syncFromPointBlockHash: string;
    readonly logLevel: string;
    readonly shelleyGenesisFile: string;
}

export interface IPeerManager {
    allPeers: Map<string, PeerClient>;
    hotPeers: PeerClient[];
    warmPeers: PeerClient[];
    coldPeers: PeerClient[];
    newPeers: PeerClient[];
    bootstrapPeers: PeerClient[];
    config: GerolamoConfig;
    topology: Topology;
    chainPoint: ChainPoint | null;
    shelleyGenesisConfig: ShelleyGenesisConfig;
    lState: RawNewEpochState;
}

export class PeerManager implements IPeerManager {
    allPeers = new Map<string, PeerClient>();
    hotPeers: PeerClient[] = [];
    warmPeers: PeerClient[] = [];
    coldPeers: PeerClient[] = [];
    newPeers: PeerClient[] = [];
    bootstrapPeers: PeerClient[] = [];
    config: GerolamoConfig;
    topology: Topology;
    chainPoint: ChainPoint | null = null;
    shelleyGenesisConfig: ShelleyGenesisConfig;
    lState: RawNewEpochState;

    constructor() {}

    async init() {
        const configFile = Bun.file("./src/config/config.json");
        this.config = await configFile.json();
        // logger.debug("Reading config file: ", this.config);
        this.topology = await parseTopology(this.config.topologyFile);
        // logger.debug("Parsed topology:", this.topology);
        const shelleyGenesisFile = Bun.file(this.config.shelleyGenesisFile);
        this.shelleyGenesisConfig = await shelleyGenesisFile.json();
        this.lState = RawNewEpochState.init();

        const chainPointFrom = new ChainPoint({
            blockHeader: {
                slotNumber: this.config.syncFromPointSlot,
                hash: fromHex(this.config.syncFromPointBlockHash),
            },
        });
        const genesisBlock = new ChainPoint({
            blockHeader: {
                slotNumber: 2n,
                hash: fromHex(this.config.genesisBlockHash),
            },
        });
        this.chainPoint = this.config.syncFromPoint
            ? chainPointFrom
            : (this.config.syncFromGenesis ? genesisBlock : null);

        // Assign bootstrap peers
        if (this.topology.bootstrapPeers) {
            await Promise.all(
                this.topology.bootstrapPeers.map(async (ap: any) => {
                    const peer = new PeerClient(
                        ap.address,
                        ap.port,
                        this.config.network,
                        this.chainPoint,
                    );
                    await peer.handShakePeer();
                    peer.startKeepAlive();
                    this.addPeer(peer, "bootstrap");
                    this.addPeer(peer, "hot");
                }),
            );
        }

        // Assign local roots as hot peers
        if (this.topology.localRoots) {
            await Promise.all(
                this.topology.localRoots.flatMap((root: TopologyRoot) =>
                    root.accessPoints.map(async (ap: any) => {
                        const peer = new PeerClient(
                            ap.address,
                            ap.port,
                            this.config.network,
                        );
                        await peer.handShakePeer();
                        peer.startKeepAlive();
                        this.addPeer(peer, "hot");
                    })
                ),
            );
        }

        // Assign public roots as warm peers (commented out in original)
        // if (this.topology.publicRoots)
        // {
        //     this.topology.publicRoots.flatMap((root: TopologyRoot) =>
        //         root.accessPoints.map((ap: any) => {
        //             // const peer = new PeerClient(ap.address, ap.port);
        //             // this.addPeer(peer, "warm");
        //
        //         })
        //     );
        // }

        await this.peerSyncCurrentTasks();
    }

    private addPeer(
        peer: PeerClient,
        category: "hot" | "warm" | "cold" | "bootstrap" | "new",
    ) {
        this.allPeers.set(peer.peerId, peer);
        switch (category) {
            case "hot":
                this.hotPeers.push(peer);
                break;
            case "warm":
                this.warmPeers.push(peer);
                break;
            case "cold":
                this.coldPeers.push(peer);
                break;
            case "bootstrap":
                this.bootstrapPeers.push(peer);
                break;
            case "new":
                this.newPeers.push(peer);
                break;
        }
    }

    private removePeer(peerId: string) {
        const peer = this.allPeers.get(peerId);
        if (peer) {
            this.allPeers.delete(peerId);
            this.hotPeers = this.hotPeers.filter((p) => p.peerId !== peerId);
            this.warmPeers = this.warmPeers.filter((p) => p.peerId !== peerId);
            this.coldPeers = this.coldPeers.filter((p) => p.peerId !== peerId);
            this.bootstrapPeers = this.bootstrapPeers.filter((p) =>
                p.peerId !== peerId
            );
            this.newPeers = this.newPeers.filter((p) => p.peerId !== peerId);
            peer.terminate();
        }
    }

    private async peerSyncCurrentTasks() {
        logger.debug("Starting peer sync tasks...");
        await Promise.all(this.hotPeers.map(async (peer) => {
            try {
                logger.log(
                    `Connecting to hot peer ${peer.peerId} at ${peer.host}:${peer.port} for current sync`,
                );
                peer.startSyncLoop(this.syncEventCallback.bind(this));
                // const peersAddresses = await peer.askForPeers();
                // console.log("peersAddresses: ", peersAddresses);
                // this.addNewSharedPeers(peersAddresses);
            } catch (error) {
                logger.error(
                    `Failed to initialize hot peer ${peer.peerId}:`,
                    error,
                );
                this.removePeer(peer.peerId);
            }
        }));
    }

    private addNewSharedPeers(peersAddresses: PeerAddress[]) {
        logger.log("Adding new shared peers from network...");
        peersAddresses.forEach((address) => {
            if (address instanceof PeerAddressIPv4) {
                const newPeer = new PeerClient(
                    uint32ToIpv4(address.address),
                    address.portNumber,
                    this.config.network,
                );
                this.addPeer(newPeer, "new");
                logger.log(
                    `Added new peer ${newPeer.peerId} from network at ${
                        uint32ToIpv4(address.address)
                    }:${address.portNumber}`,
                );
            }
        });
    }

    private async syncEventCallback(
        peerId: string,
        type: "rollForward" | "rollBackwards",
        data: ChainSyncRollForward | ChainSyncRollBackwards,
    ) {
        if (
            type === "rollBackwards" && data instanceof ChainSyncRollBackwards
        ) {
            // Handle rollback logic here if needed (e.g., remove entries from DB after rollback point)
            // For now, just log
            logger.debug(`Rollback event for peer ${peerId}`);
            // TODO: Implement DB cleanup if required
            return;
        }
        // For rollForward
        if (!(data instanceof ChainSyncRollForward)) return;
        // logger.debug("data before: ", data);
        const validateHeaderRes = await headerValidation(
            data,
            this.shelleyGenesisConfig,
            this.lState,
        );
        if (!validateHeaderRes) return;

        const { slot, blockHeaderHash, multiEraHeader } = validateHeaderRes;
        // logger.debug("multiEraHeader: ", multiEraHeader.toCborBytes());
        // Store validated header in LMDB (as JSON) using worker
        await putHeader(slot, blockHeaderHash, multiEraHeader.toCborBytes());
        // logger.debug(`Stored header for hash ${blockHeaderHash}`);

        // const headerRes = await getHeader(slot, blockHeaderHash);
        // logger.debug(`Retrieved header from DB for hash ${blockHeaderHash}:`, headerRes);

        // Fetch and store the corresponding block
        const blockPeer = this.allPeers.get(peerId);
        if (!blockPeer) return;

        /**
         * Calculating block_body_hash
         * The block_body_hash is not a simple blake2b_256 hash of the entire serialized block body.
         * Instead, it is a Merkle root-like hash (often referred to as a "Merkle triple root" or quadruple root, depending on the era) of the key components of the block body.
         * This design allows for efficient verification of the block's contents (transactions, witnesses, metadata, etc.) without re-serializing the entire body,
         * while enabling segregated witness handling (introduced in the Alonzo era and carried forward).
         * blake2b_256(
            concatUint8Arr(
                blake2b_256( tx_bodies ),
                blake2b_256( tx_witnesses ),
                blake2b_256( tx_metadatas ),
                blake2b_256( tx_invalidTxsIdxs ),
            )
        )
        */
        const block = await fetchBlock(blockPeer, slot, blockHeaderHash);
        // logger.debug("Fetched block: ", block.blockData);
        if (block) {
            await putBlock(blockHeaderHash, block.blockData); // Assuming block is MultiEraBlock; adjust if needed
            // logger.debug(`Stored block for hash ${blockHeaderHash} from peer ${peerId}`);
        } else {
            logger.error(
                `Failed to fetch block for hash ${blockHeaderHash} from peer ${peerId}`,
            );
        }
    }
}

// Initialize the peer manager
async function start() {
    const peerManager = new PeerManager();
    peerManager.init().catch((error) => {
        logger.error("Error initializing PeerManager:", error);
    });
}
start().catch((error) => console.error("Failed to start:", error));
