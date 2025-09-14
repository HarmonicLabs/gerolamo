import { parentPort } from "worker_threads";
import { open as openLMDB } from "lmdb";

const rootDB = openLMDB({ path: "./gerolamo.lmdb" });
const headersDB = rootDB.openDB({ name: "headers", encoding: "binary" });
const blocksDB = rootDB.openDB({ name: "blocks", encoding: "binary" });
const slotIndexDB = rootDB.openDB({ name: "slot_to_hash", encoding: "binary" });

parentPort!.on("message", (msg: any) => {
    if (msg.type === "putHeader") {
        headersDB.put(msg.blockHeaderHash, msg.header);
        slotIndexDB.put(msg.slot, msg.blockHeaderHash);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "putBlock") {
        // Fixed: Use blockHeaderHash as key (not slot, which wasn't sent)
        blocksDB.put(msg.blockHeaderHash, msg.block);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "getHeaderBySlot") {
        const blockHeaderHash = slotIndexDB.get(msg.slot);
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
        const blockHeaderHash = slotIndexDB.get(msg.slot);
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
        const blockHeaderHash = slotIndexDB.get(msg.slot);
        parentPort!.postMessage({
            type: "result",
            id: msg.id,
            data: blockHeaderHash,
        });
    }
});
