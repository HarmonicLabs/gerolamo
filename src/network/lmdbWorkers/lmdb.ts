import { Worker } from "worker_threads";

const worker = new Worker("./src/network/lmdbWorkers/lmdbWorker.ts");
let idCounter = 0;
const pendingPromises = new Map<number, (value: any) => void>();

worker.on("message", (msg: any) => {
    if (msg.type === "done") {
        const resolve = pendingPromises.get(msg.id);
        if (resolve) {
            resolve(undefined);
            pendingPromises.delete(msg.id);
        }
    } else if (msg.type === "result") {
        const resolve = pendingPromises.get(msg.id);
        if (resolve) {
            resolve(msg.data);
            pendingPromises.delete(msg.id);
        }
    }
});

export async function putHeader(
    slot: number | bigint,
    blockHeaderHash: Uint8Array,
    header: Uint8Array,
): Promise<void> {
    const curId = idCounter++;
    worker.postMessage({
        type: "putHeader",
        slot,
        blockHeaderHash,
        header,
        id: curId,
    });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

export async function putBlock(
    blockHeaderHash: Uint8Array,
    block: Uint8Array,
): Promise<void> {
    const curId = idCounter++;
    worker.postMessage({ type: "putBlock", blockHeaderHash, block, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

export async function getHeader(
    slot: string | bigint,
    blockHeaderHash: Uint8Array,
): Promise<any> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHeader", slot, blockHeaderHash, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}
