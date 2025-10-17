import {
    ChainPoint,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    PeerAddress,
    PeerAddressIPv4,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { MultiEraHeader, NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { logger } from "../utils/logger";
import { parseTopology } from "./topology/parseTopology";
import { Topology, TopologyRoot } from "./topology/topology";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { headerValidation } from "./headerValidation";
import { fetchBlock } from "./fetchBlocks";
import { uint32ToIpv4 } from "./utils/uint32ToIpv4";
import { closeDB, putBlock, putHeader, rollBackWards } from "./sqlWorkers/sql";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { RawNewEpochState } from "../rawNES";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { calculatePreProdCardanoEpoch } from "./utils/epochCalculations";
import { Cbor, CborArray } from "@harmoniclabs/cbor";

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
    readonly enableMinibf?: boolean; // Add this field
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
    shelleyGenesisConfig: ShelleyGenesisConfig;
    lState: RawNewEpochState;

    constructor() {}

    async init() {
        // logger.debug("Reading config file: ", this.config);
        this.topology = await parseTopology(this.config.topologyFile);
        // logger.debug("Parsed topology:", this.topology);
        const shelleyGenesisFile = Bun.file(this.config.shelleyGenesisFile);
        this.shelleyGenesisConfig = await shelleyGenesisFile.json();
        this.lState = RawNewEpochState.init();

        // Assign bootstrap peers
        if (this.topology.bootstrapPeers) {
            await Promise.all(
                this.topology.bootstrapPeers.map(async (ap: any) => {
                    const peer = new PeerClient(
                        ap.address,
                        ap.port,
                        this.config,
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
                            this.config,
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
        // logger.debug("Starting peer sync tasks...");
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
                    this.config,
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
            const slotNumber = data.tip.point.blockHeader?.slotNumber;
            if (slotNumber === undefined) {
                logger.error(
                    `Rollback failed for peer ${peerId}: missing slot number in rollback point`,
                );
                return;
            }
            logger.debug(
                `Received rollback to slot ${slotNumber} from peer ${peerId}`,
            );

            // Need to make sure that it's not syncing before rollbacks are implemented
            /*
            const success = await rollBackWards(slotNumber);
            if (!success) {
                logger.error(`Rollback failed for peer ${peerId}`);
                this.shutdown(); // Disconnect peer on failure
            }
            */

            return;
        }

        // For rollForward
        if (!(data instanceof ChainSyncRollForward)) return;
        if (
            !(
                data.data instanceof CborArray
            )
        ) throw new Error("invalid CBOR for header");
        // logger.debug("ChainSyncRollForward data: ", Cbor.encode(data.data).toString());
        const validateHeaderRes = await headerValidation(
            data,
            this.shelleyGenesisConfig,
            this.lState,
        );
        // logger.debug("Validated header res: ", validateHeaderRes);

        /*This is just tempo for quick testing
        const blockPeerTest = this.allPeers.get(peerId);
        if (!blockPeerTest) return;
        const blockTest = await fetchBlock(blockPeerTest, 102379274, fromHex("9122f44b2848ff4bb91f872ee01636b666fd3418a87edbe0d9b70a2df417941d"));
        logger.debug("Test fetch block: ", blockTest.toCbor().toString());
        */
        if (!validateHeaderRes) return;

        const tipSlot = data.tip.point.blockHeader?.slotNumber;
        const { slot, blockHeaderHash, multiEraHeader } = validateHeaderRes;
        // logger.debug("multiEraHeader: ", multiEraHeader.toCborBytes());
        // Store validated header in LMDB (as JSON) using worker
        await putHeader(slot, blockHeaderHash, multiEraHeader.toCborBytes());
        // logger.debug(`Stored header for hash ${blockHeaderHash}`);

        const headerEpoch = calculatePreProdCardanoEpoch(Number(slot));
        logger.debug(
            `Validated - Era: ${multiEraHeader.era} - Epoch: ${headerEpoch} - Slot: ${slot} of ${tipSlot} - Percent Complete: ${
                ((Number(slot) / Number(tipSlot)) * 100).toFixed(2)
            }%`,
        );

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

    async shutdown() {
        logger.debug("Shutting down PeerManager");
        for (const peer of this.allPeers.values()) {
            peer.terminate();
        }
        try {
            await closeDB();
            logger.debug("SQL worker closed");
        } catch (error) {
            logger.error(`Error closing SQL worker: ${error}`);
        }
    }
}

// Initialize the peer manager
/*
export async function start(config: Bun.BunFile) {
    const peerManager = new PeerManager();
    peerManager.init(config).catch((error) => {
        logger.error("Error initializing PeerManager:", error);
    });
}
start().catch((error) => console.error("Failed to start:", error));
*/
