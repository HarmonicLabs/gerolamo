import { fromHex } from "@harmoniclabs/uint8array-utils";

class SqlStorage {
    private worker: Worker;
    private idCounter = 0;
    private pendingPromises = new Map<number, (value: any) => void>();

    constructor() {
        this.worker = new Worker("./src/network/sqlWorkers/sqlWorker.ts");
        this.worker.addEventListener("message", (msg: any) => {
            if (msg.type === "done") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(undefined);
                    this.pendingPromises.delete(msg.id);
                }
            } else if (msg.type === "result") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(msg.data);
                    this.pendingPromises.delete(msg.id);
                }
            } else if (msg.type === "error") {
                const resolve = this.pendingPromises.get(msg.id);
                if (resolve) {
                    resolve(Promise.reject(new Error(msg.error)));
                    this.pendingPromises.delete(msg.id);
                }
            }
        });
    }

    async putHeader(
        slot: number | bigint,
        blockHeaderHash: Uint8Array,
        header: Uint8Array,
    ): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "putHeader",
            slot,
            blockHeaderHash,
            header,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async putBlock(
        blockHeaderHash: Uint8Array,
        block: Uint8Array,
    ): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "putBlock",
            blockHeaderHash,
            block,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getHeader(
        slot: string | bigint,
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "getHeader",
            slot,
            blockHeaderHash,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getHeaderBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getHeaderBySlot", slot, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getHeaderByHash(
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "getHeaderByHash",
            blockHeaderHash,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getBlockBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getBlockBySlot", slot, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getBlockByHash(
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "getBlockByHash",
            blockHeaderHash,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getHashBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getHashBySlot", slot, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getLastSlot(): Promise<{ slot: bigint; hash: Uint8Array } | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getLastSlot", id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async rollBackWards(
        rollbackPoint: number | bigint,
    ): Promise<boolean> {
        const curId = this.idCounter++;
        this.worker.postMessage({
            type: "rollBackWards",
            rollbackPoint,
            id: curId,
        });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async putEpochNonce(epoch: number | bigint, nonce: Uint8Array): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "putEpochNonce", epoch, nonce, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getEpochNonce(epoch: number | bigint): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getEpochNonce", epoch, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async putEpochSlotHeaderHashes(epoch: number | bigint, headerHashes: { [key: string]: Uint8Array }): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "putEpochSlotHeaderHashes", epoch, headerHashes, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getEpochSlotHeaderHashes(epoch: number | bigint): Promise<[{ [key: string]: Uint8Array }] | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getEpochSlotHeaderHashes", epoch, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async putEpochRollingNonces(epoch: number | bigint, rollingNonces: { [key: string]: Uint8Array }): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "putEpochRollingNonces", epoch, rollingNonces, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getEpochRollingNonce(epoch: number | bigint, slot: number | bigint): Promise<Uint8Array | undefined> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getEpochRollingNonce", epoch, slot, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async putEpochVrfOutputs(epoch: number | bigint, vrfOutputs: { [key: string]: Uint8Array }): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "putEpochVrfOutputs", epoch, vrfOutputs, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async getEpochVrfOutputs(epoch: number | bigint): Promise<[{ [key: string]: Uint8Array }] | null> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "getEpochVrfOutputs", epoch, id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    async closeDB(): Promise<void> {
        const curId = this.idCounter++;
        this.worker.postMessage({ type: "closeDB", id: curId });
        return new Promise((resolve, reject) => {
            this.pendingPromises.set(curId, (result) => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        });
    }

    terminate(): void {
        this.worker.terminate();
    }
}

// Utility to check if a string is a valid 64-char hex hash32
function isHex(str: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(str);
}

// Create an instance for the exports
const storage = new SqlStorage();

export async function putHeader(
    slot: number | bigint,
    blockHeaderHash: Uint8Array,
    header: Uint8Array,
): Promise<void> {
    return storage.putHeader(slot, blockHeaderHash, header);
}

export async function putBlock(
    blockHeaderHash: Uint8Array,
    block: Uint8Array,
): Promise<void> {
    return storage.putBlock(blockHeaderHash, block);
}

export async function getHeader(
    slot: string | bigint,
    blockHeaderHash: Uint8Array,
): Promise<any> {
    return storage.getHeader(slot, blockHeaderHash);
}

export async function getHeaderBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    return storage.getHeaderBySlot(slot);
}

export async function getHeaderByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined> {
    return storage.getHeaderByHash(blockHeaderHash);
}

export async function getBlockBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    return storage.getBlockBySlot(slot);
}

export async function getBlockByHash(
    blockHeaderHash: Uint8Array,
): Promise<Uint8Array | undefined> {
    return storage.getBlockByHash(blockHeaderHash);
}

export async function getHashBySlot(
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    return storage.getHashBySlot(slot);
}

export async function getLastSlot(): Promise<
    { slot: bigint; hash: Uint8Array } | null
> {
    return storage.getLastSlot();
}

export async function rollBackWards(
    rollbackPoint: number | bigint,
): Promise<boolean> {
    return storage.rollBackWards(rollbackPoint);
}

export async function putEpochNonce(epoch: number | bigint, nonce: Uint8Array): Promise<void> {
    return storage.putEpochNonce(epoch, nonce);
}

export async function getEpochNonce(epoch: number | bigint): Promise<Uint8Array | undefined> {
    return storage.getEpochNonce(epoch);
}

export async function putEpochSlotHeaderHashes(epoch: number | bigint, headerHashes: { [key: string]: Uint8Array }): Promise<void> {
    return storage.putEpochSlotHeaderHashes(epoch, headerHashes);
}

export async function getEpochSlotHeaderHashes(epoch: number | bigint): Promise<[{ [key: string]: Uint8Array }] | null> {
    return storage.getEpochSlotHeaderHashes(epoch);
}

export async function putEpochRollingNonces(epoch: number | bigint, rollingNonces: { [key: string]: Uint8Array }): Promise<void> {
    return storage.putEpochRollingNonces(epoch, rollingNonces);
}

export async function getEpochRollingNonce(epoch: number | bigint, slot: number | bigint): Promise<Uint8Array | undefined> {
    return storage.getEpochRollingNonce(epoch, slot);
}

export async function putEpochVrfOutputs(epoch: number | bigint, vrfOutputs: { [key: string]: Uint8Array }): Promise<void> {
    return storage.putEpochVrfOutputs(epoch, vrfOutputs);
}

export async function getEpochVrfOutputs(epoch: number | bigint): Promise<[{ [key: string]: Uint8Array }] | null> {
    return storage.getEpochVrfOutputs(epoch);
}

export async function closeDB(): Promise<void> {
    await storage.closeDB();
    storage.terminate();
}

export async function resolveToHash(
    identifier: string,
): Promise<Uint8Array | undefined> {
    if (isHex(identifier)) {
        return fromHex(identifier);
    } else {
        const slot = BigInt(identifier);
        return storage.getHashBySlot(slot);
    }
}
