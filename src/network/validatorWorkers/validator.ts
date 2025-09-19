import { Worker } from "worker_threads";
import { ChainSyncRollForward } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { ShelleyGenesisConfig } from "../../config/ShelleyGenesisTypes";
import { RawNewEpochState } from "../../rawNES";
import { PeerClient } from "../PeerClient";
let validationWorker: Worker | null = null;

export async function startValidationWorker() {
    if (validationWorker) return;
    validationWorker = new Worker("./src/network/validatorWorkers/validationWorker.ts");
}

export function validateHeader(peerId: string, data: any, shelleyGenesis: ShelleyGenesisConfig, tip: bigint, onMessage?: (msg:any) => void): Promise<void> {
    if (!validationWorker) throw new Error("Validation worker not started");
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36);
        validationWorker!.postMessage({
            type: "validateHeader",
            id,
            peerId,
            data,
            shelleyGenesis,
            tip
        });
        const handler = (msg: any) => {
            if (msg.id === id) {
                validationWorker!.removeListener("message", handler);
                if (msg.type === "done" && onMessage) {
                    onMessage(msg);
                    resolve();
                } else if (msg.type === "error") {
                    reject(new Error(msg.error));
                } else if (onMessage) {
                    
                }            
            }
        };
        validationWorker!.on("message", handler);
    });
};

export function validateBlock(peerId: string, data: any, onMessage?: (msg:any) => void): Promise<void> {
    if (!validationWorker) throw new Error("Validation worker not started");
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36);
        validationWorker!.postMessage({
            type: "validateBlock",
            id,
            peerId,
            data,

        });
        const handler = (msg: any) => {
            if (msg.id === id) {
                validationWorker!.removeListener("message", handler);
                if (msg.type === "done" && onMessage) {
                    onMessage(msg);
                    resolve();
                } else if (msg.type === "error") {
                    reject(new Error(msg.error));
                } else if (onMessage) {
                    
                }            
            }
        };
        validationWorker!.on("message", handler);
    });
}