import { sql } from "bun";
import {
    Hash32,
    MultiEraBlock,
    MultiEraHeader,
} from "@harmoniclabs/cardano-ledger-ts";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";

/**
 * Store block header data in SQLite
 */
export async function putHeader(
    slot: bigint,
    header: MultiEraHeader,
): Promise<void> {
    const headerBytes = header.toCborBytes();
    const headerHash = new Hash32(blake2b_256(headerBytes));
    await sql`
        INSERT OR REPLACE INTO blocks (hash, slot, header_data)
        VALUES (${headerHash.toBuffer()}, ${slot}, ${headerBytes})
    `;
}

/**
 * Store complete block data in SQLite
 */
export async function putBlock(
    blockHeaderHash: Hash32,
    block: MultiEraBlock,
): Promise<void> {
    const blockBytes = block.toCborBytes();
    await sql`
        UPDATE blocks
        SET block_data = ${blockBytes}
        WHERE hash = ${blockHeaderHash.toBuffer()}
    `;
}

/**
 * Store a complete block with both header and body data in SQLite
 */
export async function storeBlock(
    blockHash: Uint8Array,
    slot: number,
    headerData: Uint8Array,
    blockData: Uint8Array,
): Promise<void> {
    await sql`
        INSERT OR REPLACE INTO blocks (hash, slot, header_data, block_data)
        VALUES (${blockHash}, ${slot}, ${headerData}, ${blockData})
    `;
}

/**
 * Get header by slot number
 */
export async function getHeaderBySlot(
    slot: bigint,
): Promise<MultiEraHeader> {
    const result = await sql`
        SELECT header_data FROM blocks
        WHERE slot = ${slot}
        LIMIT 1
    `.values() as [Uint8Array][];

    if (result.length === 0) {
        throw new Error(`Header not found for slot ${slot}`);
    }

    return MultiEraHeader.fromCbor(result[0][0]);
}

/**
 * Get header by block hash
 */
export async function getHeaderByHash(
    blockHeaderHash: Hash32,
): Promise<MultiEraHeader> {
    const result = await sql`
        SELECT header_data FROM blocks
        WHERE hash = ${blockHeaderHash.toBuffer()}
        LIMIT 1
    `.values() as [Uint8Array][];

    if (result.length === 0) {
        throw new Error(
            `Header not found for hash ${blockHeaderHash.toString()}`,
        );
    }

    return MultiEraHeader.fromCbor(result[0][0]);
}

/**
 * Get block by slot number
 */
export async function getBlockBySlot(
    slot: bigint,
): Promise<MultiEraBlock> {
    const result = await sql`
        SELECT block_data FROM blocks
        WHERE slot = ${slot}
        LIMIT 1
    `.values() as [Uint8Array][];

    if (result.length === 0) {
        throw new Error(`Block not found for slot ${slot}`);
    }

    return MultiEraBlock.fromCbor(result[0][0]);
}

/**
 * Get block by block hash
 */
export async function getBlockByHash(
    blockHeaderHash: Hash32,
): Promise<MultiEraBlock> {
    const result = await sql`
        SELECT block_data FROM blocks
        WHERE hash = ${blockHeaderHash.toBuffer()}
        LIMIT 1
    `.values() as [Uint8Array][];

    if (result.length === 0) {
        throw new Error(
            `Block not found for hash ${blockHeaderHash.toString()}`,
        );
    }

    return MultiEraBlock.fromCbor(result[0][0]);
}

/**
 * Get block hash by slot number
 */
export async function getHashBySlot(
    slot: bigint,
): Promise<Hash32> {
    const result = await sql`
        SELECT hash FROM blocks
        WHERE slot = ${slot}
        LIMIT 1
    `.values() as [Uint8Array][];

    if (result.length === 0) {
        throw new Error(`Block hash not found for slot ${slot}`);
    }

    return new Hash32(result[0][0]);
}

/**
 * Get the last (highest slot) block stored in the database
 */
export async function getLastSlot(): Promise<
    { slot: bigint; hash: Hash32 } | null
> {
    const result = await sql`
        SELECT slot, hash FROM blocks
        ORDER BY slot DESC
        LIMIT 1
    `.values() as [bigint, Uint8Array][];

    if (result.length === 0) {
        return null;
    }

    const [slot, hashBytes] = result[0];
    return { slot, hash: new Hash32(hashBytes) };
}

/**
 * Rollback blocks to a specific slot (delete blocks with higher slots)
 */
export async function rollBackwards(slot: bigint): Promise<boolean> {
    const result = await sql`
        DELETE FROM blocks
        WHERE slot > ${slot}
    `;

    return result.length > 0;
}

/**
 * Utility to check if a string is a valid 64-char hex hash
 */
function isHex(str: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(str);
}

/**
 * Resolve identifier to hash (slot number or hex hash string)
 */
export async function resolveToHash(identifier: string): Promise<Hash32> {
    if (isHex(identifier)) {
        return new Hash32(fromHex(identifier));
    } else {
        const slot = BigInt(identifier);
        return getHashBySlot(slot);
    }
}
