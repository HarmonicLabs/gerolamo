import { RealPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { logger } from "./logger";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { ChainDb } from "../lib/consensus/ChainDb/ChainDb";
import { parseTopology } from "./parseTopology";
import { getMaxWorkers } from "./utils/getMaxWorkers";
import { Worker, MessageChannel } from "node:worker_threads";
import { WorkerInfo } from "./workers/messages/main/data/WorkerInfo";
import {
    MempoolSize,
    SharedMempool,
} from "@harmoniclabs/shared-cardano-mempool-ts";
import { PeerWorkerSetup } from "./workers/messages/main/messages/PeerWorkerSetup";
import { MainMessageKind } from "./workers/messages/main/messages/MainMessageKind";
import { LedgerStateChainSelWorkerSetup } from "./workers/messages/main/messages/LedgerStateChainSelWorkerSetup";
import { NodeConfig } from "./NodeConfig";

export async function runNode(): Promise<void> {
    const networkMagic = 1; // preprod
    const startPoint = new RealPoint({
        blockHeader: {
            hash: fromHex(
                "5da6ba37a4a07df015c4ea92c880e3600d7f098b97e73816f8df04bbb5fad3b7",
            ),
            slotNumber: 69638382,
        },
    });

    setupWorkers(
        networkMagic,
        startPoint,
    );

    logger.info("running node");
}

interface SetupWorkersResult {
    lStateWorker: Worker;
    peerWorkers: Worker[];
}

function setupWorkers(
    networkMagic: number,
    startPoint: RealPoint,
): SetupWorkersResult {
    const maxWorkers = getMaxWorkers();
    const topology = parseTopology("./topology.json");
    const initialPeersConnections = topology.localRoots.concat(
        topology.publicRoots,
    );

    const mempoolBuffer = SharedMempool.initMemory(MempoolSize.kb256);

    const lStateWorker = new Worker("./workers/ledgerState.js");
    const lStateId = 1; // main is 0

    // const aviabaleWorkers = maxWorkers - 2; // main and lState for now
    const nPeersWorkers = 1; // aviabaleWorkers; // Math.ceil(  nPeers / peersPerWorker  );

    const peerWorkers = new Array<Worker>(nPeersWorkers);
    for (let i = 0; i < nPeersWorkers; i++)
        peerWorkers[i] = new Worker("./workers/peer.js");

    const workerInfos: WorkerInfo[][] = new Array(nPeersWorkers);
    const lstateWorkersInfos = new Array<WorkerInfo>(nPeersWorkers);
    for (let i = 0; i < nPeersWorkers; i++)
        workerInfos[i] = new Array(nPeersWorkers);

    for (let workerIdx = 0; workerIdx < nPeersWorkers; workerIdx++) {
        // workerId is 0 is main
        // workerId is 1 is ledger state
        // workerId is 2 is first peer worker
        const workerId = workerIdx + 2;
        const lStateChannel = new MessageChannel();
        // lState => worker
        lstateWorkersInfos[workerIdx] = {
            id: workerId,
            port: lStateChannel.port1,
        };
        // worker => lState
        workerInfos[workerIdx][0] = { id: lStateId, port: lStateChannel.port2 };

        for (let j = workerIdx + 1; j < nPeersWorkers; j++) {
            const otherWorkerId = j + 2;
            const peerChannel = new MessageChannel();
            // this => other
            workerInfos[workerIdx][j] = {
                id: otherWorkerId,
                port: peerChannel.port1,
            };
            // other => this
            workerInfos[j][workerIdx] = {
                id: workerId,
                port: peerChannel.port2,
            };
        }
    }

    const config: NodeConfig = {
        networkMagic,
        immutableDbPath: "./db/immutable",
        volatileDbPath: "./db/volatile",
        ledgerStatePath: "./db/ledgerState",
        startPoint: startPoint.toJSON() as any,
    };

    lStateWorker.postMessage(
        {
            kind: MainMessageKind.LedgerStateChainSelWorkerSetup,
            data: {
                config,
                mempoolBuffer,
                peerWorkers: lstateWorkersInfos,
            },
        } as LedgerStateChainSelWorkerSetup,
        lstateWorkersInfos.map((info) => info.port), // transfer ports
    );

    for (let i = 0; i < nPeersWorkers; i++) {
        const [lStateInfos, ...otherPeerWorkers] = workerInfos[i];
        peerWorkers[i].postMessage(
            {
                kind: MainMessageKind.PeerWorkerSetup,
                data: {
                    workerId: i + 2,
                    config,
                    initialPeersConnections,
                    ledgerStateChainSelWorker: lStateInfos,
                    mempoolBuffer,
                    otherPeerWorkers: otherPeerWorkers,
                },
            } as PeerWorkerSetup,
            workerInfos[i].map((info) => info.port), // transfer ports
        );
    }

    return {
        lStateWorker,
        peerWorkers,
    };
}
