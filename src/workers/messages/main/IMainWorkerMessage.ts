import { MainMessageKind } from "./messages/MainMessageKind";
import { PeerWorkerSetupData } from "./messages/PeerWorkerSetup";
import { LedgerStateChainSelWorkerSetupData } from "./messages/LedgerStateChainSelWorkerSetup";

export interface IMainWorkerMessage<K extends MainMessageKind = MainMessageKind> {
    kind: K;
    data: DataOfMainMessage<K>;
}

export type DataOfMainMessage<K extends MainMessageKind> =
    K extends MainMessageKind.PeerWorkerSetup ? PeerWorkerSetupData :
    K extends MainMessageKind.LedgerStateChainSelWorkerSetup ? LedgerStateChainSelWorkerSetupData :
    never;