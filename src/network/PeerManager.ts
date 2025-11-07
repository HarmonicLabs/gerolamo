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
import {
    closeDB,
    initDB,
    putBlock,
    putHeader,
    rollBackWards,
} from "./sqlWorkers/sql";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { SQLNewEpochState } from "../consensus/ledger";
import { BlockValidator } from "../consensus/blockValidation";
import { BlockApplier } from "../consensus/BlockApplication";
import { ChainCandidate, ChainSelector } from "../consensus/chainSelection";
import { SQL } from "bun";
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
    lState: SQLNewEpochState;
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
    lState: SQLNewEpochState;
    chainSelector: ChainSelector;
    chainCandidates: Map<string, ChainCandidate> = new Map();
    currentFollowedPeer: string | null = null;
    private chainSelectionTimeout: number | null = null;

    constructor(config: GerolamoConfig, lState?: SQLNewEpochState) {
        this.config = config;
        if (lState) {
            this.lState = lState;
            this.chainSelector = new ChainSelector(lState);
        }
    }

    async init() {
        this.topology = await parseTopology(this.config.topologyFile);
        const shelleyGenesisFile = Bun.file(this.config.shelleyGenesisFile);
        this.shelleyGenesisConfig = await shelleyGenesisFile.json();
        if (!this.lState) {
            throw new Error("Ledger state must be provided");
        }
        if (!this.chainSelector) {
            this.chainSelector = new ChainSelector(this.lState);
        }

        // Initialize chain sync database tables
        await initDB();

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
        await Promise.all(this.hotPeers.map(async (peer) => {
            peer.startSyncLoop(this.syncEventCallback.bind(this));
        }));
    }

    private addNewSharedPeers(peersAddresses: PeerAddress[]) {
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
                return;
            }
            logger.debug(
                `Received rollback to slot ${slotNumber} from peer ${peerId}`,
            );

            // Rollback volatile state
            const success = await rollBackWards(slotNumber);
            if (!success) {
                logger.error(
                    `Rollback failed for peer ${peerId}: rollback point not found`,
                );
                this.removePeer(peerId);
                return;
            }
            logger.debug(
                `Rolled back to slot ${slotNumber} for peer ${peerId}`,
            );
            // Note: Ledger state rollback not implemented; assumes linear chain

            return;
        }

        // For rollForward
        if (!(data instanceof ChainSyncRollForward)) return;
        if (
            !(
                data.data instanceof CborArray
            )
        ) throw new Error("invalid CBOR for header");

        const validateHeaderRes = await headerValidation(
            data,
            this.shelleyGenesisConfig,
            this.lState,
        );

        /*This is just tempo for quick testing
        const blockPeerTest = this.allPeers.get(peerId);
        if (!blockPeerTest) return;
        const blockTest = await fetchBlock(blockPeerTest, 102379274, fromHex("9122f44b2848ff4bb91f872ee01636b666fd3418a87edbe0d9b70a2df417941d"));

        */
        if (!validateHeaderRes) return;

        const tipSlot = data.tip.point.blockHeader?.slotNumber;
        const { slot, blockHeaderHash, multiEraHeader } = validateHeaderRes;

        // Store validated header in LMDB (as JSON) using worker
        await putHeader(slot, blockHeaderHash, multiEraHeader.toCborBytes());
        logger.debug(
            `Header added to volatile state: slot ${slot}, hash ${
                toHex(blockHeaderHash)
            }`,
        );

        // Update chain candidate for this peer
        let candidate = this.chainCandidates.get(peerId);
        if (!candidate) {
            candidate = {
                tip: multiEraHeader,
                stake: 0n, // Placeholder, calculate later
                mithrilVerified: false,
                length: 1,
            };
            this.chainCandidates.set(peerId, candidate);
        } else {
            candidate.tip = multiEraHeader;
            candidate.length += 1;
        }

        // Perform chain selection after updating candidate
        if (this.chainSelectionTimeout) {
            clearTimeout(this.chainSelectionTimeout);
        }
        this.chainSelectionTimeout = setTimeout(async () => {
            await this.performChainSelection();
            this.chainSelectionTimeout = null;
        }, 100);

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

        if (block) {
            await putBlock(blockHeaderHash, block.toCborBytes());
            logger.debug(
                `Block added to volatile state: slot ${slot}, hash ${
                    toHex(blockHeaderHash)
                }`,
            );

            // Validate and apply the block to the ledger state
            const blockValidator = new BlockValidator(this.lState);
            const isValid = await blockValidator.validateBlock(block, slot);
            if (isValid) {
                const blockApplier = new BlockApplier(this.lState);
                await blockApplier.applyBlock(block, slot);
                logger.debug(
                    `Block applied to stable state: slot ${slot}, hash ${
                        toHex(blockHeaderHash)
                    }`,
                );
            }
        }
    }

    private async performChainSelection() {
        const candidates = Array.from(this.chainCandidates.values());
        if (candidates.length === 0) return;

        logger.debug(
            `Performing chain selection with ${candidates.length} candidates`,
        );
        if (candidates.length > 1) {
            logger.warn(`Fork detected: ${candidates.length} competing chains`);
            candidates.forEach((cand, idx) => {
                logger.warn(
                    `Candidate ${idx}: tip slot ${cand.tip.header.body.slot}, length ${cand.length}, stake ${cand.stake}`,
                );
            });
        }

        const bestChain = await this.chainSelector.evaluateChains(candidates);
        if (bestChain) {
            // Find the peer ID of the best chain
            const bestPeerId = Array.from(this.chainCandidates.entries()).find((
                [_id, cand],
            ) => cand === bestChain)?.[0];
            if (bestPeerId) {
                if (bestPeerId !== this.currentFollowedPeer) {
                    logger.info(
                        `Switching chain selection from peer ${
                            this.currentFollowedPeer || "none"
                        } to ${bestPeerId} (tip slot ${bestChain.tip.header.body.slot})`,
                    );
                    this.currentFollowedPeer = bestPeerId;
                    // Disconnect other hot peers to follow only the best
                    this.hotPeers = this.hotPeers.filter((p) =>
                        p.peerId === bestPeerId
                    );
                    // Remove from allPeers as well, but keep the best
                    for (const peer of Array.from(this.allPeers.values())) {
                        if (peer.peerId !== bestPeerId) {
                            this.removePeer(peer.peerId);
                        }
                    }
                } else {
                    logger.debug(
                        `Continuing to follow peer ${bestPeerId} as best chain`,
                    );
                }
            }
        }
    }

    async shutdown() {
        for (const peer of this.allPeers.values()) {
            peer.terminate();
        }
        try {
            await closeDB();
        } catch (error) {
        }
    }
}
