import { Worker } from "node:worker_threads";
import { fromHex } from "@harmoniclabs/uint8array-utils";

const worker = new Worker("./src/network/sqlWorkers/sqlWorker.ts");
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

// Convenience: Get header by slot (uses slotIndexDB internally)
export async function getHeaderBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHeaderBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

// Convenience: Get header by hash
export async function getHeaderByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHeaderByHash", blockHeaderHash, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

// Convenience: Get block by slot (uses slotIndexDB internally)
export async function getBlockBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getBlockBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

// Convenience: Get block by hash
export async function getBlockByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getBlockByHash", blockHeaderHash, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

// Helper: Get hash by slot (for internal use or queries)
export async function getHashBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHashBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
}

// Utility to check if a string is a valid 64-char hex hash32
function isHex(str: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(str);
}

// Export for API use: Resolve identifier to hash (slot or hex hash string)
export async function resolveToHash(
    identifier: string,
): Promise<Uint8Array | undefined> {
    if (isHex(identifier)) {
        return fromHex(identifier);
    } else {
        const slot = BigInt(identifier);
        return getHashBySlot(slot);
    }
}
