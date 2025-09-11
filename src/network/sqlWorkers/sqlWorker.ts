import { parentPort } from "worker_threads";
import { Database } from "bun:sqlite";

const DB_NAME = "gerolamo.sqlite";

const db = await Bun.file(DB_NAME).exists() ? Database.open(DB_NAME) : new Database(DB_NAME);

// Create tables if they don't exist
db.run(`
    CREATE TABLE IF NOT EXISTS headers (
        id BLOB PRIMARY KEY,
        header_data BLOB NOT NULL
    )
`);

db.run(`
    CREATE TABLE IF NOT EXISTS blocks (
        id BLOB PRIMARY KEY,
        block_data BLOB NOT NULL
    )
`);

db.run(`
    CREATE TABLE IF NOT EXISTS slot_index (
        slot INTEGER PRIMARY KEY,
        block_hash BLOB NOT NULL,
        FOREIGN KEY (block_hash) REFERENCES headers(id)
    )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_slot_index_slot ON slot_index(slot)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_headers_id ON headers(id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_blocks_id ON blocks(id)`);

parentPort!.on("message", (msg: any) => {
    if (msg.type === "putHeader") {
        const insertHeader = db.prepare("INSERT OR REPLACE INTO headers (id, header_data) VALUES (?, ?)");
        const insertSlot = db.prepare("INSERT OR REPLACE INTO slot_index (slot, block_hash) VALUES (?, ?)");

        insertHeader.run(msg.blockHeaderHash, msg.header);
        insertSlot.run(Number(msg.slot), msg.blockHeaderHash);

        // console.log("Stored Header hash ", msg.blockHeaderHash, " at slot ", msg.slot);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "putBlock") {
        const insertBlock = db.prepare("INSERT OR REPLACE INTO blocks (id, block_data) VALUES (?, ?)");
        insertBlock.run(msg.blockHeaderHash, msg.block);
        parentPort!.postMessage({ type: "done", id: msg.id });
    }
    if (msg.type === "getHeader") {
        const getSlot = db.prepare("SELECT block_hash FROM slot_index WHERE slot = ?");
        const slotResult = getSlot.get(Number(msg.slot)) as { block_hash: Uint8Array } | undefined;

        if (slotResult) {
            const getHeader = db.prepare("SELECT header_data FROM headers WHERE id = ?");
            const headerResult = getHeader.get(slotResult.block_hash) as { header_data: Uint8Array } | undefined;
            parentPort!.postMessage({ type: "result", id: msg.id, data: headerResult ? headerResult.header_data : null });
        } else {
            parentPort!.postMessage({ type: "result", id: msg.id, data: null });
        }
    }
});
