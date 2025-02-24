import { MainMessageKind } from "./messages/MainMessageKind";
import { PeerWorkerSetup } from "./messages/PeerWorkerSetup";


export type MainWorkerMessage 
    = PeerWorkerSetup
    // | LedgerStateChainSelWorkerSetup
    ;

export function isMainWorkerMessage( msg: any ): msg is MainWorkerMessage
{
    return typeof MainMessageKind[msg.kind] !== "string";
}