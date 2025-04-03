import { initWorker as initLedgerWorker } from "./ledgerStateAndChainSel";
import { initWorker as initPeerWorker } from "./peerWorker";
import { parentPort } from "node:worker_threads";
import {
    isLedgerStateChainSelWorkerSetupKind,
    isPeerWorkerSetupKind,
    MainMessageKind,
} from "../common";
import { logger } from "../utils/logger";

parentPort?.on("message", async (message) => {
    if (
        message.kind === MainMessageKind.LedgerStateChainSelWorkerSetup &&
        isLedgerStateChainSelWorkerSetupKind(message.data)
    ) {
        return initLedgerWorker(message.data);
    } else if (
        message.kind === MainMessageKind.PeerWorkerSetup &&
        isPeerWorkerSetupKind(message.data)
    ) {
        return initPeerWorker(message.data);
    } else {
        logger.error();
        throw new Error("Type of data unidentified");
    }
});
