import { logger } from "../utils/logger";
import { getMaxSlot, getNextChunk, getValidBlocksBefore, getValidHeadersBefore } from "./readDB";
import { deleteVolatileBlocks, deleteVolatileHeaders, insertChunk, insertImmutableBlocks } from "./writeDB";
import type { AugmentedBlockRow, VolatileBlockRow, VolatileHeaderRow } from "./types.js";

interface ImmutableChunk {
    chunk_no: number;
    tip_hash: string;
    tip_slot_no: bigint;
    slot_range_start: bigint;
    slot_range_end: bigint;
}

export async function createChunk(dbPath: string, oldBlocks: VolatileBlockRow[]): Promise<ImmutableChunk> {
    if (oldBlocks.length === 0) throw new Error('No blocks to chunk');

    // Assume oldBlocks sorted by slot ASC
    const firstBlock = oldBlocks[0]!;
    const lastBlock = oldBlocks[oldBlocks.length - 1]!;

    // Get next chunk_no
    const nextChunk = await getNextChunk(dbPath);
    const chunk_no = nextChunk.next_chunk;

    return {
        chunk_no,
        tip_hash: lastBlock.block_hash,
        tip_slot_no: lastBlock.slot,
        slot_range_start: firstBlock.slot,
        slot_range_end: lastBlock.slot
    };
};

export async function gcVolatileToImmutable(dbPath: string) {
    const cutoff = (await getMaxSlot(dbPath)) - 2160n;
    const oldBlocks = await getValidBlocksBefore(dbPath, cutoff);  // SELECT * FROM volatile_blocks WHERE slot < ? AND is_valid = TRUE ORDER BY slot ASC (ensures block_fetch_RawCbor, is_valid incl.)
    const oldHeaders = await getValidHeadersBefore(dbPath, cutoff);  // SELECT * FROM volatile_headers WHERE slot < ? ORDER BY slot ASC

    if (oldBlocks.length === 0) return;  // Chunk only if blocks; headers follow

    // Map headers by hash for denorm to blocks (1:1, header_hash == block_hash)
    const headerMap = new Map(oldHeaders.map(h => [h.header_hash, h.rollforward_header_cbor]));
    const augmentedBlocks: AugmentedBlockRow[] = oldBlocks.map(block => ({
        slot: block.slot,
        block_hash: block.block_hash,
        prev_hash: block.prev_hash,
        header_data: block.header_data,
        block_data: block.block_data,
        block_fetch_RawCbor: block.block_fetch_RawCbor,
        rollforward_header_cbor: headerMap.get(block.block_hash) ?? new Uint8Array(0)
    }));

    const chunk = await createChunk(dbPath, oldBlocks);
    const chunk_id = insertChunk(dbPath, chunk);
    insertImmutableBlocks(dbPath, augmentedBlocks, chunk_id);
    deleteVolatileBlocks(dbPath, oldBlocks.map(b => b.block_hash));
    deleteVolatileHeaders(dbPath, oldHeaders.map(h => h.header_hash));
    logger.debug(`GC'd ${oldBlocks.length} blocks + ${oldHeaders.length} headers (w/ RawCbor + rollforward_header_cbor) to chunk ${chunk.chunk_no}`);
};