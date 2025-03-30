import { parentPort } from "node:worker_threads";
import { MainWorkerMessage } from "../messages/main/MainWorkerMessage";
import { isLedgerStateChainSelWorkerSetupKind } from "../messages/main/messages/LedgerStateChainSelWorkerSetup";
import * as lState from "./schema";
import { SharedMempool } from "@harmoniclabs/shared-cardano-mempool-ts";

const workerId = 1;
let _initialized = false;
let mempool!: SharedMempool;

parentPort?.on("message", async (message: MainWorkerMessage) => {
    if( isLedgerStateChainSelWorkerSetupKind( message ) )
    {
        const { config, peerWorkers, mempoolBuffer } = message.data;
        mempool = new SharedMempool( mempoolBuffer );
        _initialized = true;
        await loadLState();
    }
});

async function loadLState(): Promise<void>
{

}
