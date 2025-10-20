import { SQL } from "bun";
import { fromHex } from "@harmoniclabs/uint8array-utils";

class SqlStorage {
    db: SQL;

    constructor(db: SQL) {
        this.db = db;
    }

    async putHeader(
        slot: number | bigint,
        blockHeaderHash: Uint8Array,
        header: Uint8Array,
    ): Promise<void> {
        await this.db.begin(async (tx) => {
            await tx`
                INSERT OR REPLACE INTO headers (hash, header_data)
                VALUES (${blockHeaderHash}, ${header})
            `;
            await tx`
                INSERT OR REPLACE INTO slot_index (slot, block_hash)
                VALUES (${BigInt(slot)}, ${blockHeaderHash})
            `;
        });
    }

    async putBlock(
        blockHeaderHash: Uint8Array,
        block: Uint8Array,
    ): Promise<void> {
        await this.db`
            INSERT OR REPLACE INTO blocks (hash, block_data)
            VALUES (${blockHeaderHash}, ${block})
        `;
    }

    async getHeader(
        slot: string | bigint,
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | null> {
        const result = await this.db`
            SELECT h.header_data
            FROM headers h
            JOIN slot_index si ON h.hash = si.block_hash
            WHERE si.slot = ${BigInt(slot)} AND si.block_hash = ${blockHeaderHash}
        `;
        return result.length > 0 ? result[0].header_data : null;
    }

    async getHeaderBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT h.header_data
            FROM headers h
            JOIN slot_index si ON h.hash = si.block_hash
            WHERE si.slot = ${BigInt(slot)}
        `;
        return result.length > 0 ? result[0].header_data : undefined;
    }

    async getHeaderByHash(
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT header_data FROM headers WHERE hash = ${blockHeaderHash}
        `;
        return result.length > 0 ? result[0].header_data : undefined;
    }

    async getBlockBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT b.block_data
            FROM blocks b
            JOIN slot_index si ON b.hash = si.block_hash
            WHERE si.slot = ${BigInt(slot)}
        `;
        return result.length > 0 ? result[0].block_data : undefined;
    }

    async getBlockByHash(
        blockHeaderHash: Uint8Array,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT block_data FROM blocks WHERE hash = ${blockHeaderHash}
        `;
        return result.length > 0 ? result[0].block_data : undefined;
    }

    async getHashBySlot(
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT block_hash FROM slot_index WHERE slot = ${BigInt(slot)}
        `;
        return result.length > 0 ? result[0].block_hash : undefined;
    }

    async getLastSlot(): Promise<{ slot: bigint; hash: Uint8Array } | null> {
        const result = await this.db`
            SELECT slot, block_hash FROM slot_index
            ORDER BY slot DESC LIMIT 1
        `;
        return result.length > 0
            ? { slot: result[0].slot, hash: result[0].block_hash }
            : null;
    }

    async rollBackWards(
        rollbackPoint: number | bigint,
    ): Promise<boolean> {
        const rollbackPointBig = BigInt(rollbackPoint);

        // Check if rollback point exists
        const exists = await this.db`
            SELECT 1 FROM slot_index WHERE slot = ${rollbackPointBig}
        `;
        if (exists.length === 0) {
            return false;
        }

        await this.db.begin(async (tx) => {
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

        return true;
    }

    async putEpochNonce(
        epoch: number | bigint,
        nonce: Uint8Array,
    ): Promise<void> {
        await this.db`
            INSERT OR REPLACE INTO epoch_nonces (epoch, nonce)
            VALUES (${BigInt(epoch)}, ${nonce})
        `;
    }

    async getEpochNonce(
        epoch: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT nonce FROM epoch_nonces WHERE epoch = ${BigInt(epoch)}
        `;
        return result.length > 0 ? result[0].nonce : undefined;
    }

    async putEpochSlotHeaderHashes(
        epoch: number | bigint,
        headerHashes: { [key: string]: Uint8Array },
    ): Promise<void> {
        const epochBig = BigInt(epoch);
        await this.db.begin(async (tx) => {
            for (const [slotStr, hash] of Object.entries(headerHashes)) {
                await tx`
                    INSERT OR REPLACE INTO epoch_slot_header_hashes (epoch, slot, hash)
                    VALUES (${epochBig}, ${BigInt(slotStr)}, ${hash})
                `;
            }
        });
    }

    async getEpochSlotHeaderHashes(
        epoch: number | bigint,
    ): Promise<[{ [key: string]: Uint8Array }] | null> {
        const results = await this.db`
            SELECT slot, hash FROM epoch_slot_header_hashes
            WHERE epoch = ${BigInt(epoch)}
        `;
        if (results.length === 0) {
            return null;
        } else {
            const result = results.reduce(
                (acc: { [key: string]: Uint8Array }, row: { slot: bigint; hash: Uint8Array }) => {
                    acc[row.slot.toString()] = row.hash;
                    return acc;
                },
                {} as { [key: string]: Uint8Array },
            );
            return [result];
        }
    }

    async putEpochRollingNonces(
        epoch: number | bigint,
        rollingNonces: { [key: string]: Uint8Array },
    ): Promise<void> {
        const epochBig = BigInt(epoch);
        await this.db.begin(async (tx) => {
            for (const [slotStr, nonce] of Object.entries(rollingNonces)) {
                await tx`
                    INSERT OR REPLACE INTO epoch_rolling_nonces (epoch, slot, nonce)
                    VALUES (${epochBig}, ${BigInt(slotStr)}, ${nonce})
                `;
            }
        });
    }

    async getEpochRollingNonce(
        epoch: number | bigint,
        slot: number | bigint,
    ): Promise<Uint8Array | undefined> {
        const result = await this.db`
            SELECT nonce FROM epoch_rolling_nonces
            WHERE epoch = ${BigInt(epoch)} AND slot = ${BigInt(slot)}
        `;
        return result.length > 0 ? result[0].nonce : undefined;
    }

    async putEpochVrfOutputs(
        epoch: number | bigint,
        vrfOutputs: { [key: string]: Uint8Array },
    ): Promise<void> {
        const epochBig = BigInt(epoch);
        await this.db.begin(async (tx) => {
            for (const [slotStr, vrf] of Object.entries(vrfOutputs)) {
                await tx`
                    INSERT OR REPLACE INTO epoch_vrf_outputs (epoch, slot, vrf)
                    VALUES (${epochBig}, ${BigInt(slotStr)}, ${vrf})
                `;
            }
        });
    }

    async getEpochVrfOutputs(
        epoch: number | bigint,
    ): Promise<[{ [key: string]: Uint8Array }] | null> {
        const results = await this.db`
            SELECT slot, vrf FROM epoch_vrf_outputs
            WHERE epoch = ${BigInt(epoch)}
        `;
        if (results.length === 0) {
            return null;
        } else {
            const result = results.reduce(
                (acc: { [key: string]: Uint8Array }, row: { slot: bigint; vrf: Uint8Array }) => {
                    acc[row.slot.toString()] = row.vrf;
                    return acc;
                },
                {} as { [key: string]: Uint8Array },
            );
            return [result];
        }
    }

    async closeDB(): Promise<void> {
        await this.db.close();
    }
}

// Utility to check if a string is a valid 64-char hex hash32
function isHex(str: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(str);
}

// Create an instance for the exports
const db = new SQL('sqlite://./gerolamo.db');
const storage = new SqlStorage(db);

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
): Promise<Uint8Array | null> {
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

export async function putEpochNonce(
    epoch: number | bigint,
    nonce: Uint8Array,
): Promise<void> {
    return storage.putEpochNonce(epoch, nonce);
}

export async function getEpochNonce(
    epoch: number | bigint,
): Promise<Uint8Array | undefined> {
    return storage.getEpochNonce(epoch);
}

export async function putEpochSlotHeaderHashes(
    epoch: number | bigint,
    headerHashes: { [key: string]: Uint8Array },
): Promise<void> {
    return storage.putEpochSlotHeaderHashes(epoch, headerHashes);
}

export async function getEpochSlotHeaderHashes(
    epoch: number | bigint,
): Promise<[{ [key: string]: Uint8Array }] | null> {
    return storage.getEpochSlotHeaderHashes(epoch);
}

export async function putEpochRollingNonces(
    epoch: number | bigint,
    rollingNonces: { [key: string]: Uint8Array },
): Promise<void> {
    return storage.putEpochRollingNonces(epoch, rollingNonces);
}

export async function getEpochRollingNonce(
    epoch: number | bigint,
    slot: number | bigint,
): Promise<Uint8Array | undefined> {
    return storage.getEpochRollingNonce(epoch, slot);
}

export async function putEpochVrfOutputs(
    epoch: number | bigint,
    vrfOutputs: { [key: string]: Uint8Array },
): Promise<void> {
    return storage.putEpochVrfOutputs(epoch, vrfOutputs);
}

export async function getEpochVrfOutputs(
    epoch: number | bigint,
): Promise<[{ [key: string]: Uint8Array }] | null> {
    return storage.getEpochVrfOutputs(epoch);
}

export async function closeDB(): Promise<void> {
    await storage.closeDB();
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