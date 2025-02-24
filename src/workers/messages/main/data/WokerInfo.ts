import { isObject } from "@harmoniclabs/obj-utils";
import { MessagePort } from "node:worker_threads";

export interface WorkerInfo {
    readonly id: number;
    readonly port: MessagePort;
}

export function isWorkerInfo( message: any ): message is WorkerInfo
{
    return isObject( message ) && (
        typeof message.id === "number"
        && typeof globalThis.MessagePort !== "undefined"
        && message.port instanceof globalThis.MessagePort
    );
}