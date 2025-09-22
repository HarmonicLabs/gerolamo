import { ChainSyncRollBackwards, ChainSyncRollForward, PeerAddress, PeerAddressIPv4 }  from "@harmoniclabs/ouroboros-miniprotocols-ts";
import {  NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { logger } from "../utils/logger";
import { parseTopology } from "./topology/parseTopology";
import { Topology, TopologyRoot } from "./topology/topology";
import { uint32ToIpv4 } from "./utils/uint32ToIpv4";
import { closeDB } from "./lmdbWorkers/lmdb";
import { ShelleyGenesisConfig } from "../config/ShelleyGenesisTypes";
import { RawNewEpochState } from "../rawNES";

//This class is not being used anymore in flavor of workers however
//still need to move the interfaces from here.

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
    allPeers: Map<string, PeerClient>;

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

    async init(config: GerolamoConfig) {
        this.config = config;
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
    };

    public getAllPeers(): ReadonlyArray<PeerClient> {
        return Array.from(this.allPeers.values());
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
        // logger.log("this allpeers", this.allPeers);
        await Promise.all(this.hotPeers.map(async (peer) => {
            try {
                logger.log(`Connecting to hot peer ${peer.peerId} at ${peer.host}:${peer.port} for current sync` );
                peer.startSyncLoop();
                // const peersAddresses = await peer.askForPeers();
                // console.log("peersAddresses: ", peersAddresses);
                // this.addNewSharedPeers(peersAddresses);
            } catch (error) {
                logger.error(`Failed to initialize hot peer ${peer.peerId}:`, error );
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
                logger.log( `Added new peer ${newPeer.peerId} from network at ${uint32ToIpv4(address.address) }:${address.portNumber}`);
            }
        });
    }s

    async shutdown() {
        logger.debug("Shutting down PeerManager");
        for (const peer of this.allPeers.values()) {
            peer.terminate();
        };
        try {
            await closeDB();
            logger.debug("LMDB worker closed");
        } catch (error) {
            logger.error(`Error closing LMDB worker: ${error}`);
        };
    };
};

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
