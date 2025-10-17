import { SQL } from "bun";

const DB_NAME = "./gerolamo.db";
const sql = new SQL(`sqlite://${DB_NAME}`);

// Initialize database tables and indexes
async function initDB() {
    await sql`
        CREATE TABLE IF NOT EXISTS headers (
            hash BLOB PRIMARY KEY,
            header_data BLOB NOT NULL
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS blocks (
            hash BLOB PRIMARY KEY,
            block_data BLOB NOT NULL
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS slot_index (
            slot BIGINT PRIMARY KEY,
            block_hash BLOB NOT NULL,
            FOREIGN KEY (block_hash) REFERENCES headers(hash)
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS epoch_nonces (
            epoch BIGINT PRIMARY KEY,
            nonce BLOB NOT NULL
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS epoch_slot_header_hashes (
            epoch BIGINT,
            slot BIGINT,
            hash BLOB NOT NULL,
            PRIMARY KEY (epoch, slot)
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS epoch_rolling_nonces (
            epoch BIGINT,
            slot BIGINT,
            nonce BLOB NOT NULL,
            PRIMARY KEY (epoch, slot)
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS epoch_vrf_outputs (
            epoch BIGINT,
            slot BIGINT,
            vrf BLOB NOT NULL,
            PRIMARY KEY (epoch, slot)
        )
    `;

    // Create indexes
    await sql`
        CREATE INDEX IF NOT EXISTS idx_slot_index_slot ON slot_index(slot)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_headers_hash ON headers(hash)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_epoch_slot_header_hashes_epoch_slot ON epoch_slot_header_hashes(epoch, slot)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_epoch_rolling_nonces_epoch_slot ON epoch_rolling_nonces(epoch, slot)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_epoch_vrf_outputs_epoch_slot ON epoch_vrf_outputs(epoch, slot)
    `;
}

let initialized = false;

async function ensureInit() {
    if (!initialized) {
        await initDB();
        initialized = true;
    }
}

self.addEventListener("message", async (event: MessageEvent) => {
    const msg = event.data;
    await ensureInit();

    if (msg.type === "putHeader") {
        try {
            await sql.begin(async (tx) => {
                await tx`
                    INSERT OR REPLACE INTO headers (hash, header_data)
                    VALUES (${msg.blockHeaderHash}, ${msg.header})
                `;
                await tx`
                    INSERT OR REPLACE INTO slot_index (slot, block_hash)
                    VALUES (${BigInt(msg.slot)}, ${msg.blockHeaderHash})
                `;
            });
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putHeader:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "putBlock") {
        try {
            await sql`
                INSERT OR REPLACE INTO blocks (hash, block_data)
                VALUES (${msg.blockHeaderHash}, ${msg.block})
            `;
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putBlock:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getHeader") {
        try {
            const result = await sql`
                SELECT h.header_data
                FROM headers h
                JOIN slot_index si ON h.hash = si.block_hash
                WHERE si.slot = ${
                BigInt(msg.slot)
            } AND si.block_hash = ${msg.blockHeaderHash}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].header_data : null,
            });
        } catch (error: any) {
            console.error("Error in getHeader:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getHeaderBySlot") {
        try {
            const result = await sql`
                SELECT h.header_data
                FROM headers h
                JOIN slot_index si ON h.hash = si.block_hash
                WHERE si.slot = ${BigInt(msg.slot)}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].header_data : undefined,
            });
        } catch (error: any) {
            console.error("Error in getHeaderBySlot:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getHeaderByHash") {
        try {
            const result = await sql`
                SELECT header_data FROM headers WHERE hash = ${msg.blockHeaderHash}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].header_data : undefined,
            });
        } catch (error: any) {
            console.error("Error in getHeaderByHash:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getBlockBySlot") {
        try {
            const result = await sql`
                SELECT b.block_data
                FROM blocks b
                JOIN slot_index si ON b.hash = si.block_hash
                WHERE si.slot = ${BigInt(msg.slot)}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].block_data : undefined,
            });
        } catch (error: any) {
            console.error("Error in getBlockBySlot:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getBlockByHash") {
        try {
            const result = await sql`
                SELECT block_data FROM blocks WHERE hash = ${msg.blockHeaderHash}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].block_data : undefined,
            });
        } catch (error: any) {
            console.error("Error in getBlockByHash:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getHashBySlot") {
        try {
            const result = await sql`
                SELECT block_hash FROM slot_index WHERE slot = ${
                BigInt(msg.slot)
            }
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].block_hash : undefined,
            });
        } catch (error: any) {
            console.error("Error in getHashBySlot:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getLastSlot") {
        try {
            const result = await sql`
                SELECT slot, block_hash FROM slot_index
                ORDER BY slot DESC LIMIT 1
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0
                    ? { slot: result[0].slot, hash: result[0].block_hash }
                    : null,
            });
        } catch (error: any) {
            console.error("Error in getLastSlot:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "rollBackWards") {
        try {
            const rollbackPointBig = BigInt(msg.rollbackPoint);

            // Check if rollback point exists
            const exists = await sql`
                SELECT 1 FROM slot_index WHERE slot = ${rollbackPointBig}
            `;
            if (exists.length === 0) {
                self.postMessage({ type: "result", id: msg.id, data: false });
                return;
            }

            await sql.begin(async (tx) => {
                // Get slots to remove
                const slotsToRemove = await tx`
                    SELECT slot FROM slot_index WHERE slot > ${rollbackPointBig}
                `;

                for (const { slot } of slotsToRemove) {
                    // Get hash for this slot
                    const hashResult = await tx`
                        SELECT block_hash FROM slot_index WHERE slot = ${slot}
                    `;
                    if (hashResult.length > 0) {
                        const hash = hashResult[0].block_hash;

                        // Remove from slot_index
                        await tx`DELETE FROM slot_index WHERE slot = ${slot}`;

                        // Check if hash is referenced elsewhere
                        const refCount = await tx`
                            SELECT COUNT(*) as count FROM slot_index WHERE block_hash = ${hash}
                        `;
                        if (refCount[0].count === 0) {
                            // Remove from headers and blocks
                            await tx`DELETE FROM headers WHERE hash = ${hash}`;
                            await tx`DELETE FROM blocks WHERE hash = ${hash}`;
                        }
                    }
                }
            });

            self.postMessage({ type: "result", id: msg.id, data: true });
        } catch (error: any) {
            console.error("Error in rollBackWards:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "putEpochNonce") {
        try {
            await sql`
                INSERT OR REPLACE INTO epoch_nonces (epoch, nonce)
                VALUES (${BigInt(msg.epoch)}, ${msg.nonce})
            `;
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putEpochNonce:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getEpochNonce") {
        try {
            const result = await sql`
                SELECT nonce FROM epoch_nonces WHERE epoch = ${
                BigInt(msg.epoch)
            }
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].nonce : undefined,
            });
        } catch (error: any) {
            console.error("Error in getEpochNonce:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "putEpochSlotHeaderHashes") {
        try {
            const epochBig = BigInt(msg.epoch);
            await sql.begin(async (tx) => {
                for (
                    const [slotStr, hash] of Object.entries(msg.headerHashes)
                ) {
                    await tx`
                        INSERT OR REPLACE INTO epoch_slot_header_hashes (epoch, slot, hash)
                        VALUES (${epochBig}, ${BigInt(slotStr)}, ${hash})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putEpochSlotHeaderHashes:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getEpochSlotHeaderHashes") {
        try {
            const results = await sql`
                SELECT slot, hash FROM epoch_slot_header_hashes
                WHERE epoch = ${BigInt(msg.epoch)}
            `;
            if (results.length === 0) {
                self.postMessage({ type: "result", id: msg.id, data: null });
            } else {
                const result = results.reduce(
                    (
                        acc: { [key: string]: Uint8Array },
                        row: { slot: bigint; hash: Uint8Array },
                    ) => {
                        acc[row.slot.toString()] = row.hash;
                        return acc;
                    },
                    {} as { [key: string]: Uint8Array },
                );
                self.postMessage({
                    type: "result",
                    id: msg.id,
                    data: [result],
                });
            }
        } catch (error: any) {
            console.error("Error in getEpochSlotHeaderHashes:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "putEpochRollingNonces") {
        try {
            const epochBig = BigInt(msg.epoch);
            await sql.begin(async (tx) => {
                for (
                    const [slotStr, nonce] of Object.entries(msg.rollingNonces)
                ) {
                    await tx`
                        INSERT OR REPLACE INTO epoch_rolling_nonces (epoch, slot, nonce)
                        VALUES (${epochBig}, ${BigInt(slotStr)}, ${nonce})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putEpochRollingNonces:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getEpochRollingNonce") {
        try {
            const result = await sql`
                SELECT nonce FROM epoch_rolling_nonces
                WHERE epoch = ${BigInt(msg.epoch)} AND slot = ${
                BigInt(msg.slot)
            }
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0].nonce : undefined,
            });
        } catch (error: any) {
            console.error("Error in getEpochRollingNonce:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "putEpochVrfOutputs") {
        try {
            const epochBig = BigInt(msg.epoch);
            await sql.begin(async (tx) => {
                for (const [slotStr, vrf] of Object.entries(msg.vrfOutputs)) {
                    await tx`
                        INSERT OR REPLACE INTO epoch_vrf_outputs (epoch, slot, vrf)
                        VALUES (${epochBig}, ${BigInt(slotStr)}, ${vrf})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in putEpochVrfOutputs:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "getEpochVrfOutputs") {
        try {
            const results = await sql`
                SELECT slot, vrf FROM epoch_vrf_outputs
                WHERE epoch = ${BigInt(msg.epoch)}
            `;
            if (results.length === 0) {
                self.postMessage({ type: "result", id: msg.id, data: null });
            } else {
                const result = results.reduce(
                    (
                        acc: { [key: string]: Uint8Array },
                        row: { slot: bigint; vrf: Uint8Array },
                    ) => {
                        acc[row.slot.toString()] = row.vrf;
                        return acc;
                    },
                    {} as { [key: string]: Uint8Array },
                );
                self.postMessage({
                    type: "result",
                    id: msg.id,
                    data: [result],
                });
            }
        } catch (error: any) {
            console.error("Error in getEpochVrfOutputs:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    } else if (msg.type === "closeDB") {
        try {
            await sql.close();
            self.postMessage({ type: "done", id: msg.id });
        } catch (error: any) {
            console.error("Error in closeDB:", error);
            self.postMessage({
                type: "error",
                id: msg.id,
                error: error.message,
            });
        }
    }
});
