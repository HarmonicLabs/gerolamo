import { Worker } from "worker_threads";
import { fromHex } from "@harmoniclabs/uint8array-utils"; // Add this import for hex handling in convenience functions

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

export function startLmdbWorker() {
  return worker;
};

export async function putHeader(
    epochNonce: Uint8Array,
    epoch: number | bigint,
    slot: number | bigint,
    blockHeaderHash: Uint8Array,
    multiEraHeader: Uint8Array,
    currentRollingNonces: { [key: number]: Uint8Array; }[],
    currentEpochHeaderHashes: { [key: number]: Uint8Array; }[],
    currentVrfOutputs: { [key: number]: Uint8Array; }[],
): Promise<void> {
    const curId = idCounter++;
    worker.postMessage({
        type: "putHeader",
        epochNonce,
        epoch,
        slot,
        blockHeaderHash,
        multiEraHeader,
        currentRollingNonces,
        currentEpochHeaderHashes,
        currentVrfOutputs,
        id: curId,
    });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

export async function putBlock(
    blockHeaderHash: Uint8Array,
    block: Uint8Array,
): Promise<void> {
    const curId = idCounter++;
    worker.postMessage({ type: "putBlock", blockHeaderHash, block, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

export async function getEpochNonce(
    epoch: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getEpochNonce", epoch, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
export async function getRollingNonce(
    epoch: number | bigint,
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getRollingNonce", epoch, slot });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
export async function putEpochNonce(
    epoch: number | bigint,
    nonce: Uint8Array,
): Promise<void> {
    const curId = idCounter++;
    if (!(nonce instanceof Uint8Array && nonce.length === 32)) {
        throw new Error(`Invalid nonce format for epoch ${epoch}: must be 32-byte Uint8Array`);
    }
    worker.postMessage({ type: "putEpochNonce", epoch, nonce, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
// Convenience: Get header by slot (uses slotIndexDB internally)
export async function getHeaderBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHeaderBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

// Convenience: Get header by hash
export async function getHeaderByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined>
{
    const curId = idCounter++;
    worker.postMessage({ type: "getHeaderByHash", blockHeaderHash, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

// Convenience: Get block by slot (uses slotIndexDB internally)
export async function getBlockBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getBlockBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

// Convenience: Get block by hash
export async function getBlockByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined>
{
    const curId = idCounter++;
    worker.postMessage({ type: "getBlockByHash", blockHeaderHash, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};


export async function getHeader(
    slot: number | bigint,
    blockHeaderHash: Uint8Array, // Ignored in worker, but kept for signature
): Promise<Uint8Array | undefined>
{
    return getHeaderBySlot(slot);
};

// Helper: Get hash by slot (for internal use or queries)
export async function getHashBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    const curId = idCounter++;
    worker.postMessage({ type: "getHashBySlot", slot, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};

export async function getLastSlot(): Promise<{ slot: number; hash: Uint8Array; } | null>
{
    const curId = idCounter++;
    worker.postMessage({ type: "getLastSlot", id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
export async function getEpochSlotHeaderHashes(
    epoch: number | bigint,
): Promise<[{ [key: number]: Uint8Array; }] | null> {
    const curId = idCounter++;
    worker.postMessage({ type: "getEpochSlotHeaderHashes", epoch, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
export async function getEpochVrfOutputs(
    epoch: number | bigint,
): Promise<[{ [key: number]: Uint8Array; }] | null> {
    const curId = idCounter++;
    worker.postMessage({ type: "getEpochVrfOutputs", epoch, id: curId });
    return new Promise((resolve) => pendingPromises.set(curId, resolve));
};
export async function rollBackWards(
    slot: number | bigint,
) {
    const curId = idCounter++;
    worker.postMessage({
        type: "rollBackwards",
        rollbackPoint: slot,
        id: curId,
    });
    return new Promise<boolean>((resolve) =>
        pendingPromises.set(curId, resolve)
    );
};

export async function closeDB(): Promise<void> {
    if (worker) {
        const curId = idCounter++;
        worker.postMessage({ type: "closeDB", id: curId });
        return new Promise((resolve) => pendingPromises.set(curId, resolve));
    }
};

// Utility to check if a string is a valid 64-char hex hash32
function isHex(str: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(str);
};

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
};