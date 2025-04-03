import { TopologyRoot } from "../../../lib/topology";
import { NodeConfig } from "../../node/NodeConfig";
import { WorkerInfo } from "../data/WorkerInfo";
import { IMainWorkerMessage } from "../IMainWorkerMessage";
import { MainMessageKind } from "./MainMessageKind";

export interface PeerWorkerSetup
    extends IMainWorkerMessage<MainMessageKind.PeerWorkerSetup> {
    readonly kind: MainMessageKind.PeerWorkerSetup;
    readonly data: PeerWorkerSetupData;
}

export interface PeerWorkerSetupData {
    readonly workerId: number;
    /** peers this worker needs to (try to) connect to **/
    readonly initialPeersConnections: TopologyRoot[];

    readonly config: NodeConfig;

    readonly otherPeerWorkers: WorkerInfo[];
    readonly ledgerStateChainSelWorker: WorkerInfo;

    readonly mempoolBuffer: SharedArrayBuffer;
}

export function isPeerWorkerSetupKind(
    message: any,
): message is PeerWorkerSetup {
    return message.kind === MainMessageKind.PeerWorkerSetup;
}
