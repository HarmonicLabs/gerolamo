import { parentPort } from "worker_threads";
import { open } from "lmdb";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../../utils/logger";
import { ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { log } from "console";

const rootDB = open({
    path: "./src/store/gerolamo.lmdb",
    maxDbs: 10,
    eventTurnBatching: true,
    strictAsyncOrder: true,
});
const headersDB = rootDB.openDB({ name: "headers", encoding: "binary" });
const blocksDB = rootDB.openDB({ name: "blocks", encoding: "binary" });
const slotIndexDB = rootDB.openDB({ name: "slot_to_hash", encoding: "binary" });
const epochSlotHeaderHashIndexDB = rootDB.openDB({ name: "epoch_slot_header_hash_index" });
const epochStartSlotIndexDB = rootDB.openDB({ name: "epoch_start_slot_to_hash", encoding: "binary" });
const epochEndSlotIndexDB = rootDB.openDB({ name: "epoch_end_slot_to_hash", encoding: "binary" });
const epochRollingNonceDb = rootDB.openDB({ name: "epoch_rolling_nonce" });
const epochNonceIndexDb = rootDB.openDB({ name: "epoch_nonce_index", encoding: "binary" });
const epochVrfIndexDb = rootDB.openDB({ name: "epoch_vrf_index" });

parentPort!.on("message", async (msg: any) => {
    if (msg.type === "putHeader") {
        headersDB.put(msg.blockHeaderHash, msg.multiEraHeader);
        slotIndexDB.put(Number(msg.slot), msg.blockHeaderHash);
        epochNonceIndexDb.put(Number(msg.epoch), msg.epochNonce);
        epochSlotHeaderHashIndexDB.put(Number(msg.epoch), msg.currentEpochHeaderHashes);
        epochRollingNonceDb.put(Number(msg.epoch), msg.currentRollingNonces);
        epochVrfIndexDb.put(Number(msg.epoch), msg.currentVrfOutputs);
        parentPort!.postMessage({ type: "done", id: msg.id });
    };
    if (msg.type === "putBlock") {
        blocksDB.put(msg.blockHeaderHash, msg.block);
        parentPort!.postMessage({ type: "done", id: msg.id });
    };
    if (msg.type === "putEpochNonce") {
        epochNonceIndexDb.put(Number(msg.epoch), msg.nonce);
        parentPort!.postMessage({ type: "done", id: msg.id });
    };
    if (msg.type === "getEpochNonce") {
        const epochNonce = epochNonceIndexDb.get(Number(msg.epoch));
        parentPort!.postMessage({ type: "result", id: msg.id, data: epochNonce });
    };
    if (msg.type === "getHeaderBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        const header = blockHeaderHash ? headersDB.get(blockHeaderHash) : undefined;
        parentPort!.postMessage({ type: "result", id: msg.id, data: header });
    };
    if (msg.type === "getHeaderByHash") {
        const header = headersDB.get(msg.blockHeaderHash);
        parentPort!.postMessage({ type: "result", id: msg.id, data: header });
    };
    if (msg.type === "getBlockBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        const block = blockHeaderHash ? blocksDB.get(blockHeaderHash) : undefined;
        parentPort!.postMessage({ type: "result", id: msg.id, data: block });
    };
    if (msg.type === "getBlockByHash") {
        const block = blocksDB.get(msg.blockHeaderHash);
        parentPort!.postMessage({ type: "result", id: msg.id, data: block });
    };
    if (msg.type === "getHashBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        ; parentPort!.postMessage({ type: "result", id: msg.id, data: blockHeaderHash });
    }
    if (msg.type === "getLastSlot") {
        const range = slotIndexDB.getRange({ reverse: true, limit: 1 });
        for (const { key } of range) {
            if (typeof key === "number") {
                const hash = slotIndexDB.get(key);
                parentPort!.postMessage({ type: "result", id: msg.id, data: { slot: key, hash: hash } });
            }
        }
    };
    if (msg.type === "rollBackwards") {
        const rollbackRes = await handleRollback(msg.rollbackPoint);
        parentPort!.postMessage({ type: "result", id: msg.id, data: rollbackRes });
    };

    if (msg.type === "closeDB") {
        logger.debug("Closing LMDB database in worker");
        rootDB.close();
        logger.debug("LMDB database closed");
        parentPort!.postMessage({ type: "done", id: msg.id });
    };
    if (msg.type === "storeRollingNonce") {
        storeRollingNonce(Number(msg.epoch), (msg.slot), msg.rollingNonce);
        parentPort!.postMessage({ type: "done", id: msg.id });
    };
    if (msg.type === "getRollingNonce") {
        const rollingNonce = getRollingNonce(Number(msg.epoch), msg.slot);
        // logger.debug("getting rolling nonce", rollingNonce);
        parentPort!.postMessage({ type: "result", id: msg.id, data: rollingNonce });
    };
    if (msg.type === "getEpochVrfOutputs") {
        const vrfOutputs = epochVrfIndexDb.get(Number(msg.epoch));
        parentPort!.postMessage({ type: "result", id: msg.id, data: vrfOutputs });
    };
});

function storeRollingNonce(epoch: number, slot: number, rollingNonce: Uint8Array) {
    if (!rollingNonce || rollingNonce.length !== 32) {
        throw new Error(`Rolling nonce must be 32 bytes, got ${rollingNonce?.length || 0}`);
    };
    epochRollingNonceDb.put(Number(epoch), { [Number(slot)]: rollingNonce });
    logger.debug(`Stored rolling nonce for slot ${slot}, nonce: ${toHex(rollingNonce)}`);
};

export async function getRollingNonce(epoch: number, slot: number): Promise<Uint8Array | null> {
    const epochData = epochRollingNonceDb.get(epoch);
    const rollingNonce = epochData ? epochData[slot] : null;
    return rollingNonce ? rollingNonce : null;
};
export async function getEpochRollingNonces(epoch: number): Promise<[{ [key: number]: Uint8Array; }] | null> {
    const rollingNonces = epochRollingNonceDb.get(epoch);
    return rollingNonces ? rollingNonces : null;
};
export async function getEpochSlotHeaderHashes(epoch: number): Promise<[{ [key: number]: Uint8Array; }] | null> {
    const epochSlotHeaderHashes = epochSlotHeaderHashIndexDB.get(epoch);
    return epochSlotHeaderHashes ? epochSlotHeaderHashes : null;
};
export async function getEpochNonce(epoch: number): Promise<Uint8Array | null> {
    const epochNonce = epochNonceIndexDb.get(epoch);
    return epochNonce ? epochNonce : null;
};
export async function putEpochNonce(epoch: number, nonce: Uint8Array): Promise<void> {
    epochNonceIndexDb.put(Number(epoch), nonce);
};
export async function getEpochVrfOutputs(epoch: number): Promise<{ [key: number]: Uint8Array; }[] | null> { 
    const vrfOutputs = epochVrfIndexDb.get(epoch);
    return vrfOutputs ? vrfOutputs : null;
};
async function handleRollback(rollbackPoint: ChainPoint) {
    if (!(rollbackPoint instanceof ChainPoint)) {
        throw new Error("invalid rollback point");
    }
    const blockHeader = rollbackPoint.blockHeader;
    if (!blockHeader) throw new Error("rollback point missing blockHeader");

    const rollbackSlot = Number(blockHeader.slotNumber);
    const rollbackHash = toHex(blockHeader.hash);

    const storedHash = await slotIndexDB.get(rollbackSlot);
    if (!storedHash || storedHash !== rollbackHash) {
        logger.error(`Rollback point slot=${rollbackSlot}, hash=${rollbackHash} not found or mismatched`);
        return false;
    }

    return rootDB.transaction(async () => {
        const slotsToRemove: number[] = [];
        for (const { key } of slotIndexDB.getRange({ start: rollbackSlot + 1 })) {
            if (typeof key === "number") {
                slotsToRemove.push(key);
            }
        }

        for (const slot of slotsToRemove) {
            const hash = await slotIndexDB.get(slot);
            if (hash) {
                await slotIndexDB.remove(slot);
                const isHashReferenced = await checkHashReferenced(hash, slot);
                if (!isHashReferenced) {
                    await headersDB.remove(hash);
                    await blocksDB.remove(hash);
                }
                logger.debug(`Removed slot=${slot}, hash=${hash}`);
            }
        }

        logger.debug(`Rolled back to slot=${rollbackSlot}, hash=${rollbackHash}`);
        return true;
    });
};

async function checkHashReferenced(hash: string, excludeSlot: number): Promise<boolean> {
    for (const { key, value } of slotIndexDB.getRange()) {
        if (typeof key === "number" && key !== excludeSlot && value === hash) {
            return true;
        }
    }
    return false;
};