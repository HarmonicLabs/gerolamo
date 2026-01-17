import { Hash32 } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { Buffer } from "node:buffer";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../utils/logger";

// Stable state represents the immutable portion of the blockchain
export interface StableState {
    immutableTip: Hash32;
    blockCount: number;
    totalSlots: bigint;
}

// Block component types for selective data retrieval
export type BlockComponent =
    | "GetBlock" // Full block data
    | "GetHeader" // Block header
    | "GetHash" // Block hash
    | "GetSlot" // Slot number
    | "GetIsEBB" // Is epoch boundary block
    | "GetBlockSize" // Block size in bytes
    | "GetHeaderSize"; // Header size in bytes

// Point represents a position in the chain
export interface Point {
    slot: bigint;
    hash: Hash32;
}

// RealPoint represents a point that definitely refers to a block (not genesis)
export type RealPoint = Point;

// Stream bounds for block queries
export interface StreamFrom {
    type: "inclusive" | "exclusive";
    point: Point;
}

export interface StreamTo {
    point: RealPoint;
}

// Missing block error
export class MissingBlockError extends Error {
    constructor(public point: Point) {
        super(
            `Block not found at slot ${point.slot}, hash ${
                toHex(point.hash.toBuffer())
            }`,
        );
    }
}

export interface StreamTo {
    point: RealPoint;
}

// Tip information
export interface Tip {
    slot: bigint;
    hash: Hash32;
    blockNo: bigint;
}

// Initialize the stable state database tables
export async function initStableState(): Promise<void> {
    // Create immutable_blocks table for permanent chain storage
    await sql`
        CREATE TABLE IF NOT EXISTS immutable_blocks (
            slot INTEGER PRIMARY KEY,
            hash BLOB NOT NULL,
            block_data JSONB NOT NULL,
            prev_hash BLOB,
            UNIQUE(hash)
        );
    `;

    // Create stable_state table to track immutable tip and metadata
    await sql`
        CREATE TABLE IF NOT EXISTS stable_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            immutable_tip_hash BLOB,
            immutable_tip_slot INTEGER,
            total_blocks INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Insert initial stable state if not exists
    await sql`
        INSERT OR IGNORE INTO stable_state (id, immutable_tip_hash, immutable_tip_slot, total_blocks)
        VALUES (1, NULL, 0, 0);
    `;
}

// Get the current stable state
export async function getStableState(): Promise<StableState> {
    const rows = await sql`
        SELECT immutable_tip_hash, immutable_tip_slot, total_blocks
        FROM stable_state WHERE id = 1
    `.values() as [Uint8Array | null, number, number][];

    if (rows.length === 0) {
        throw new Error("Stable state not initialized");
    }

    const [tipHash, tipSlot, blockCount] = rows[0];
    const immutableTip = tipHash
        ? new Hash32(tipHash)
        : new Hash32(Buffer.alloc(32));

    return {
        immutableTip,
        blockCount,
        totalSlots: BigInt(tipSlot),
    };
}

// Transition blocks from volatile to stable state
export async function transitionToStable(
    blocks: Array<{ slot: bigint; hash: Hash32; data: any; prevHash?: Hash32 }>,
): Promise<void> {
    if (blocks.length === 0) return;

    // Sort blocks by slot to ensure proper ordering
    blocks.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

    // Prepare bulk insert data
    const insertData = blocks.map((block) => [
        block.slot,
        block.hash.toBuffer(),
        JSON.stringify(block.data),
        block.prevHash?.toBuffer(),
    ]);

    // Bulk insert blocks into immutable storage
    await sql`
        INSERT OR REPLACE INTO immutable_blocks (slot, hash, block_data, prev_hash)
        VALUES ${sql(insertData)}
    `;

    // Update stable state with new tip
    const newTip = blocks[blocks.length - 1];
    const newBlockCount = blocks.length;

    await sql`
        UPDATE stable_state
        SET immutable_tip_hash = ${newTip.hash.toBuffer()},
            immutable_tip_slot = ${newTip.slot},
            total_blocks = total_blocks + ${newBlockCount},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
    `;

    logger.info("Advanced stable state", {
        blocksCount: newBlockCount,
        immutableTipSlot: newTip.slot.toString(),
        immutableTipHash: toHex(newTip.hash.bytes),
    });
}

// Check if a block exists in stable state
export async function hasBlockInStable(hash: Hash32): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM immutable_blocks WHERE hash = ${hash.toBuffer()} LIMIT 1
    `.values();
    return rows.length > 0;
}

// Get a block from stable state
export async function getBlockFromStable(hash: Hash32): Promise<any | null> {
    const rows = await sql`
        SELECT block_data FROM immutable_blocks WHERE hash = ${hash.toBuffer()}
    `.values() as [any][];

    if (rows.length === 0) {
        return null;
    }

    return rows[0][0]; // JSONB is automatically parsed by Bun
}

// Get blocks in a slot range from stable state
export async function getBlocksInRange(
    startSlot: bigint,
    endSlot: bigint,
): Promise<Array<{ slot: bigint; hash: Hash32; data: any }>> {
    const rows = await sql`
        SELECT slot, hash, block_data FROM immutable_blocks
        WHERE slot >= ${startSlot} AND slot <= ${endSlot}
        ORDER BY slot ASC
    `.values() as [number, Uint8Array, any][];

    return rows.map(([slot, hash, data]) => ({
        slot: BigInt(slot),
        hash: new Hash32(hash),
        data, // JSONB is automatically parsed by Bun
    }));
}

// Get the chain from genesis to current tip
export async function getStableChain(): Promise<
    Array<{ slot: bigint; hash: Hash32; data: any }>
> {
    const rows = await sql`
        SELECT slot, hash, block_data FROM immutable_blocks
        ORDER BY slot ASC
    `.values() as [number, Uint8Array, any][];

    return rows.map(([slot, hash, data]) => ({
        slot: BigInt(slot),
        hash: new Hash32(hash),
        data, // JSONB is automatically parsed by Bun
    }));
}

// Remove blocks from volatile storage after they've become stable
export async function garbageCollectVolatile(blocks: Hash32[]): Promise<void> {
    if (blocks.length === 0) return;

    logger.debug("Garbage collecting volatile blocks", { count: blocks.length });

    const hashes = blocks.map((h) => h.toBuffer());
    await sql`DELETE FROM blocks WHERE hash IN ${sql(hashes)}`;
}

// Get blocks that are ready to become immutable (older than current slot - k)
export async function getBlocksReadyForImmutable(
    currentSlot: bigint,
    securityParamK: number = 2160,
): Promise<Hash32[]> {
    const cutoffSlot = currentSlot - BigInt(securityParamK);

    const blockRows = await sql`
        SELECT hash FROM blocks
        WHERE slot <= ${cutoffSlot}
        ORDER BY slot ASC
    `.values() as [string][];

    return blockRows.map(([hash]) => new Hash32(hash));
}

// Transition blocks from volatile to stable when they become immutable (k blocks deep)
export async function makeBlocksImmutable(
    blockHashes: Hash32[],
): Promise<void> {
    if (blockHashes.length === 0) return;

    logger.info("Making blocks immutable", { count: blockHashes.length });

    // Get block data from volatile storage
    const hashBuffers = blockHashes.map((h) => h.toBuffer());

    const blockRows = await sql`
        SELECT slot, hash, data FROM blocks
        WHERE hash IN ${sql(hashBuffers)}
        ORDER BY slot ASC
    `.values() as [number, Uint8Array, any][];

    if (blockRows.length === 0) return;

    // Convert to the expected format for transitionToStable
    const blocks = blockRows.map(([slot, hash, data]) => ({
        slot: BigInt(slot),
        hash: new Hash32(hash),
        data, // JSONB is automatically parsed by Bun
        // prevHash would need to be determined from block data
    }));

    // Transition to stable state
    await transitionToStable(blocks);

    // Garbage collect from volatile storage
    await garbageCollectVolatile(blockHashes);
}

// Get the current tip of the immutable database
export async function getTip(): Promise<Tip | null> {
    const rows = await sql`
        SELECT immutable_tip_hash, immutable_tip_slot, total_blocks
        FROM stable_state WHERE id = 1
    `.values() as [Uint8Array | null, number, number][];

    if (rows.length === 0 || !rows[0][0]) {
        return null; // Empty database
    }

    const [tipHash, tipSlot, blockCount] = rows[0];
    return {
        slot: BigInt(tipSlot),
        hash: new Hash32(tipHash!),
        blockNo: BigInt(blockCount), // Approximate block number
    };
}

// Append a block to the immutable database
export async function appendBlock(
    block: { slot: bigint; hash: Hash32; data: any; prevHash?: Hash32 },
): Promise<void> {
    // Validate that slot is greater than current tip
    const currentTip = await getTip();
    if (currentTip && block.slot <= currentTip.slot) {
        throw new Error(
            `Block slot ${block.slot} must be greater than current tip slot ${currentTip.slot}`,
        );
    }

    await transitionToStable([block]);

    logger.info("Appended block to immutable", {
        slot: block.slot.toString(),
        hash: toHex(block.hash.bytes),
    });
}

// Get a specific block component
export async function getBlockComponent(
    component: BlockComponent,
    point: RealPoint,
): Promise<any> {
    const block = await getBlockFromStable(point.hash);
    if (!block) {
        throw new MissingBlockError(point);
    }

    // Extract the requested component
    switch (component) {
        case "GetBlock":
            return block;
        case "GetHash":
            return point.hash;
        case "GetSlot":
            return point.slot;
        case "GetIsEBB":
            // Check if this is an epoch boundary block
            // This would need more sophisticated logic based on the block data
            return false; // Placeholder
        case "GetBlockSize":
            return JSON.stringify(block).length;
        case "GetHeaderSize":
            // Extract header size - this would need to parse the block structure
            return 0; // Placeholder
        default:
            throw new Error(`Unsupported block component: ${component}`);
    }
}

// Stream blocks between bounds (returns array for manual streaming)
export async function stream(
    component: BlockComponent,
    from: StreamFrom,
    to: StreamTo,
): Promise<Array<{ slot: bigint; hash: Hash32; data: any }>> {
    // Determine the slot range
    let startSlot: bigint;
    let endSlot: bigint = to.point.slot;

    if (from.type === "inclusive") {
        startSlot = from.point.slot;
    } else {
        // Find the next slot after the exclusive bound
        startSlot = from.point.slot + 1n;
    }

    // Get blocks in the range
    const blocks = await getBlocksInRange(startSlot, endSlot);

    // Filter based on actual bounds if needed
    let filteredBlocks = blocks;

    if (from.type === "exclusive") {
        filteredBlocks = blocks.filter((b) => b.slot > from.point.slot);
    }

    return filteredBlocks;
}

// Validate the integrity of the immutable database
export async function validateIntegrity(): Promise<boolean> {
    try {
        // Check that all blocks form a valid chain
        const blocks = await getStableChain();

        for (let i = 1; i < blocks.length; i++) {
            const prevBlock = blocks[i - 1];
            const currentBlock = blocks[i];

            // Check that prev_hash matches
            if (
                currentBlock.data.prevHash !== toHex(prevBlock.hash.toBuffer())
            ) {
                logger.error(
                    `Chain validation failed at slot ${currentBlock.slot}: prev_hash mismatch`,
                );
                return false;
            }

            // Check slot ordering
            if (currentBlock.slot <= prevBlock.slot) {
                logger.error(
                    `Chain validation failed: non-increasing slots at ${currentBlock.slot}`,
                );
                return false;
            }
        }

        return true;
    } catch (error) {
        logger.error("Integrity validation failed:", error);
        return false;
    }
}

// Close the immutable database (cleanup resources)
export async function closeDB(): Promise<void> {
    // In a real implementation, this would close file handles, etc.
    // For SQLite, we don't need to do anything special as Bun handles connection pooling
    logger.info("Immutable database closed");
}

// Recovery mechanism - truncate to last valid block
export async function recoverFromCorruption(): Promise<void> {
    const isValid = await validateIntegrity();
    if (isValid) {
        logger.info("Database integrity is valid");
        return;
    }

    logger.error("Database corruption detected, attempting recovery...");

    // Find the last valid block by checking the chain
    const blocks = await getStableChain();
    let lastValidIndex = -1;

    for (let i = 1; i < blocks.length; i++) {
        const prevBlock = blocks[i - 1];
        const currentBlock = blocks[i];

        if (
            currentBlock.data.prevHash !== toHex(prevBlock.hash.toBuffer()) ||
            currentBlock.slot <= prevBlock.slot
        ) {
            break;
        }
        lastValidIndex = i;
    }

    if (lastValidIndex >= 0) {
        // Truncate to the last valid block
        const lastValidBlock = blocks[lastValidIndex];
        await sql`
            DELETE FROM immutable_blocks
            WHERE slot > ${lastValidBlock.slot}
        `;

        // Update the tip
        await sql`
            UPDATE stable_state
            SET immutable_tip_hash = ${lastValidBlock.hash.toBuffer()},
                immutable_tip_slot = ${lastValidBlock.slot},
                total_blocks = ${lastValidIndex + 1},
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `;

        logger.info(`Recovered database to slot ${lastValidBlock.slot}`);
    } else {
        // Complete corruption - reset to empty
        await sql`DELETE FROM immutable_blocks`;
        await sql`
            UPDATE stable_state
            SET immutable_tip_hash = NULL,
                immutable_tip_slot = 0,
                total_blocks = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `;
        logger.info("Database completely corrupted, reset to empty");
    }
}

// Chunk-based storage management (simplified implementation)
const CHUNK_SIZE = 1000; // Blocks per chunk

// Get chunk index for a slot
function getChunkIndex(slot: bigint): number {
    return Number(slot / BigInt(CHUNK_SIZE));
}

// Get chunk file path (conceptual - in a real implementation this would be a file path)
function getChunkPath(chunkIndex: number): string {
    return `chunk_${chunkIndex}.dat`;
}

// Validate chunk integrity (placeholder for CRC32 validation mentioned in spec)
export async function validateChunk(chunkIndex: number): Promise<boolean> {
    const startSlot = BigInt(chunkIndex * CHUNK_SIZE);
    const endSlot = BigInt((chunkIndex + 1) * CHUNK_SIZE - 1);

    const blocks = await getBlocksInRange(startSlot, endSlot);

    // In a real implementation, this would validate CRC32 checksums
    // For now, just check that we have blocks in the expected range
    return blocks.length > 0 || chunkIndex === 0; // Allow empty genesis chunk
}

// Reconstruct chunk from available data (for recovery)
export async function reconstructChunk(chunkIndex: number): Promise<void> {
    const chunkPath = getChunkPath(chunkIndex);

    // In a real implementation, this would rebuild the chunk file
    // For now, this is a placeholder
    logger.info(`Reconstructing chunk ${chunkPath}`);

    // Validate after reconstruction
    const isValid = await validateChunk(chunkIndex);
    if (!isValid) {
        throw new Error(`Failed to reconstruct chunk ${chunkIndex}`);
    }
}

// Get blocks from a specific chunk
export async function getBlocksFromChunk(
    chunkIndex: number,
): Promise<Array<{ slot: bigint; hash: Hash32; data: any }>> {
    const startSlot = BigInt(chunkIndex * CHUNK_SIZE);
    const endSlot = BigInt((chunkIndex + 1) * CHUNK_SIZE - 1);

    return await getBlocksInRange(startSlot, endSlot);
}

// Background maintenance - validate all chunks
export async function validateAllChunks(): Promise<boolean> {
    const tip = await getTip();
    if (!tip) return true; // Empty database is valid

    const maxChunkIndex = getChunkIndex(tip.slot);

    const validationResults = await Promise.all(
        Array.from({ length: maxChunkIndex + 1 }, (_, i) => validateChunk(i)),
    );

    return validationResults.every((isValid, i) => {
        if (!isValid) {
            logger.error(`Chunk ${i} validation failed`);
        }
        return isValid;
    });
}

// Resource registry for managing iterators and resources (simplified)
export class ResourceRegistry {
    private resources: Set<any> = new Set();

    register(resource: any): void {
        this.resources.add(resource);
    }

    async release(): Promise<void> {
        await Promise.all(
            Array.from(this.resources).map(async (resource) => {
                if (resource.close && typeof resource.close === "function") {
                    await resource.close();
                }
            }),
        );
        this.resources.clear();
    }
}

// Create a block stream with optional resource management
export async function createStreamIterator(
    component: BlockComponent,
    from: StreamFrom,
    to: StreamTo,
    registry?: ResourceRegistry,
): Promise<Array<{ slot: bigint; hash: Hash32; data: any }>> {
    const blocks = await stream(component, from, to);

    // Register the blocks array for cleanup if registry is provided
    if (registry) {
        registry.register(blocks);
    }

    return blocks;
}

// Utility function to create stream bounds
export function createStreamFromInclusive(point: RealPoint): StreamFrom {
    return { type: "inclusive", point };
}

export function createStreamFromExclusive(point: Point): StreamFrom {
    return { type: "exclusive", point };
}

export function createStreamToInclusive(point: RealPoint): StreamTo {
    return { point };
}
