import { parentPort } from "worker_threads";
import { open } from "lmdb";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../../utils/logger";
import { ChainPoint } from "@harmoniclabs/ouroboros-miniprotocols-ts";

const rootDB = open({
    path: "./src/store/gerolamo.lmdb",
    maxDbs: 10,
    eventTurnBatching: true,
    strictAsyncOrder: true,
});
const headersDB = rootDB.openDB({ name: "headers", encoding: "binary" });
const blocksDB = rootDB.openDB({ name: "blocks", encoding: "binary" });
const slotIndexDB = rootDB.openDB({
    name: "slot_to_hash",
    encoding: "binary",
    keyEncoding: "ordered-binary",
});
const slotEpochStartIndexDB = rootDB.openDB({
    name: "slot_to_epochStart",
    encoding: "binary",
    keyEncoding: "ordered-binary",
});

parentPort!.on("message", async (msg: any) => {
    if (msg.type === "putHeader") {
        headersDB.put(msg.blockHeaderHash, msg.header);
        slotIndexDB.put(Number(msg.slot), msg.blockHeaderHash);
        // logger.debug(`Stored header at slot ${msg.slot}, hash ${toHex(msg.blockHeaderHash)}`);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "putBlock") {
        blocksDB.put(msg.blockHeaderHash, msg.block);
        // logger.debug(`Stored block with hash ${toHex(msg.blockHeaderHash)}`);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "getHeaderBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        const header = blockHeaderHash
            ? headersDB.get(blockHeaderHash)
            : undefined;
        parentPort!.postMessage({ type: "result", id: msg.id, data: header });
    }
    if (msg.type === "getHeaderByHash") {
        const header = headersDB.get(msg.blockHeaderHash);
        parentPort!.postMessage({ type: "result", id: msg.id, data: header });
    }
    if (msg.type === "getBlockBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        const block = blockHeaderHash
            ? blocksDB.get(blockHeaderHash)
            : undefined;
        parentPort!.postMessage({ type: "result", id: msg.id, data: block });
    }
    if (msg.type === "getBlockByHash") {
        const block = blocksDB.get(msg.blockHeaderHash);
        parentPort!.postMessage({ type: "result", id: msg.id, data: block });
    }
    if (msg.type === "getHashBySlot") {
        const blockHeaderHash = slotIndexDB.get(Number(msg.slot));
        parentPort!.postMessage({
            type: "result",
            id: msg.id,
            data: blockHeaderHash,
        });
    }
    if (msg.type === "getLastSlot") {
        const range = slotIndexDB.getRange({ reverse: true, limit: 1 });
        for (const { key } of range) {
            if (typeof key === "number") {
                // logger.debug(`Highest slot found:`, key);
                const hash = slotIndexDB.get(key);
                parentPort!.postMessage({
                    type: "result",
                    id: msg.id,
                    data: { slot: key, hash: hash },
                });
            }
        }
    }
    if (msg.type === "rollBackwards") {
        const rollbackRes = await handleRollback(msg.rollbackPoint);
        parentPort!.postMessage({
            type: "result",
            id: msg.id,
            data: rollbackRes,
        });
    }

    if (msg.type === "closeDB") {
        logger.debug("Closing LMDB database in worker");
        rootDB.close();
        logger.debug("LMDB database closed");
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
});

async function handleRollback(rollbackPoint: ChainPoint) {
    if (!(rollbackPoint instanceof ChainPoint)) {
        throw new Error("invalid rollback point");
    }
    const blockHeader = rollbackPoint.blockHeader;
    if (!blockHeader) throw new Error("rollback point missing blockHeader");

    const rollbackSlot = Number(blockHeader.slotNumber);
    const rollbackHash = toHex(blockHeader.hash);

    // Validate rollback point exists
    const storedHash = await slotIndexDB.get(rollbackSlot);
    if (!storedHash || storedHash !== rollbackHash) {
        logger.error(
            `Rollback point slot=${rollbackSlot}, hash=${rollbackHash} not found or mismatched`,
        );
        return false;
    }

    // Start a transaction for atomic cleanup
    return rootDB.transaction(async () => {
        // Iterate over slotIndexDB to find slots > rollbackSlot
        const slotsToRemove: number[] = [];
        for (
            const { key } of slotIndexDB.getRange({ start: rollbackSlot + 1 })
        ) {
            if (typeof key === "number") {
                slotsToRemove.push(key);
            }
        }

        // Remove entries
        for (const slot of slotsToRemove) {
            const hash = await slotIndexDB.get(slot);
            if (hash) {
                await slotIndexDB.remove(slot);
                // Only remove header/block if not referenced by another slot
                const isHashReferenced = await checkHashReferenced(hash, slot);
                if (!isHashReferenced) {
                    await headersDB.remove(hash);
                    await blocksDB.remove(hash);
                }
                logger.debug(`Removed slot=${slot}, hash=${hash}`);
            }
        }

        logger.debug(
            `Rolled back to slot=${rollbackSlot}, hash=${rollbackHash}`,
        );
        return true;
    });
}

async function checkHashReferenced(
    hash: string,
    excludeSlot: number,
): Promise<boolean> {
    for (const { key, value } of slotIndexDB.getRange()) {
        if (typeof key === "number" && key !== excludeSlot && value === hash) {
            return true;
        }
    }
    return false;
}
