import { NodeConfig } from "../../../../NodeConfig";
import { WorkerInfo } from "../data/WokerInfo";
import { IMainWorkerMessage } from "../IMainWorkerMessage";
import { MainMessageKind } from "./MainMessageKind";

export interface LedgerStateChainSelWorkerSetup extends IMainWorkerMessage<MainMessageKind.LedgerStateChainSelWorkerSetup> {
    readonly kind: MainMessageKind.LedgerStateChainSelWorkerSetup;
    readonly data: LedgerStateChainSelWorkerSetupData; 
}

export interface LedgerStateChainSelWorkerSetupData {
    readonly config: NodeConfig;
    readonly peerWorkers: WorkerInfo[];
    readonly mempoolBuffer: SharedArrayBuffer;
}

export function isLedgerStateChainSelWorkerSetupKind( message: any ): message is LedgerStateChainSelWorkerSetup
{
    return message.kind === MainMessageKind.LedgerStateChainSelWorkerSetup;
}