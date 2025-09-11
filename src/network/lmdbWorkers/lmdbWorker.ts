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
        // console.log("Sotred Header hash ", msg.blockHeaderHash, " at slot ", msg.slot);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "putBlock") {
        blocksDB.put(msg.slot, msg.blockHeaderHash, msg.block);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "getHeader") {
        const blockHeaderHash = slotIndexDB.get(msg.slot);
        const header = headersDB.get(blockHeaderHash);
        parentPort!.postMessage({ type: "result", id: msg.id, data: header });
    }
});
