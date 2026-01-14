import { Database } from 'bun:sqlite';
import { logger } from '../utils/logger';

const DB_PATH = './src/db/chain/Gerolamo.db';
let db: Database | null = null;
let pragmasRun = false;  // Track to run PRAGMAs only once (safe outside tx)

function getDB(): Database {
    if (!db) {
        db = new Database(DB_PATH, { create: true });
    }
    if (!pragmasRun) {
        db.run(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA wal_autocheckpoint = 100;
            PRAGMA busy_timeout = 5000;
            PRAGMA cache_size = 10000;
            PRAGMA temp_store = MEMORY;
        `);
        pragmasRun = true;
    }
    return db;
};

interface HeaderInsertData {
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
};

interface BlockInsertData {
    slot: bigint;
    blockHash: string;
    prevHash: string;
    headerData: Uint8Array;
    blockData: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
};

export async function insertHeaderBatchVolatile(records: Array<{
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
}>) {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map(r => r.headerHash));
    if (hashes.size !== records.length) {
        logger.warn(`Batch has ${records.length - hashes.size} duplicate hashes!`);
    }

    const tx = getDB().transaction(() => {
        const stmt = getDB().prepare(`
            INSERT OR IGNORE INTO volatile_headers 
            (slot, header_hash, rollforward_header_cbor)
            VALUES (?, ?, ?)
        `);
        for (const record of records) {
            stmt.run(
                record.slot,
                record.headerHash,
                record.rollforward_header_cbor
            );
        }
    });
    tx();
    logger.debug(`Inserted ${records.length} volatile headers (ignored dups)`);
}

export async function insertBlockVolatile(block: BlockInsertData): Promise<void> {
    const stmt = getDB().prepare(`
        INSERT INTO volatile_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(block_hash) DO UPDATE SET
            slot = excluded.slot,
            prev_hash = excluded.prev_hash,
            header_data = excluded.header_data,
            block_data = excluded.block_data;
            block_fetch_RawCbor = excluded.block_fetch_RawCbor
    `);
    stmt.run(
        block.slot,
        block.blockHash,
        block.prevHash,
        block.headerData,
        block.blockData,
        block.block_fetch_RawCbor
    );
};

export async function insertBlockBatchVolatile(records: Array<{
    slot: bigint;
    blockHash: string;
    prevHash: string;
    headerData: Uint8Array;
    blockData: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
}>) {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map(r => r.blockHash));
    if (hashes.size !== records.length) {
        logger.warn(`Batch has ${records.length - hashes.size} duplicate hashes!`);
    }

    const tx = getDB().transaction(() => {
        const stmt = getDB().prepare(`
            INSERT OR IGNORE INTO volatile_blocks 
            (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor, is_valid)
            VALUES (?, ?, ?, ?, ?, ?, TRUE)
        `);
        for (const record of records) {
            stmt.run(
                Number(record.slot),
                record.blockHash,
                record.prevHash,
                record.headerData,
                record.blockData,
                record.block_fetch_RawCbor

            );
        }
    });
    tx();
    logger.debug(`Inserted ${records.length} volatile blocks (ignored dups)`);
}

export function insertChunk(chunk: { chunk_no: number; tip_hash: string; tip_slot_no: bigint; slot_range_start: bigint; slot_range_end: bigint; }): number {
    const stmt = getDB().prepare(`
        INSERT INTO immutable_chunks (chunk_no, tip_hash, tip_slot_no, slot_range_start, slot_range_end)
        VALUES (?, ?, ?, ?, ?)
        RETURNING chunk_id
    `);
    const result = stmt.get(
        chunk.chunk_no,
        chunk.tip_hash,
        chunk.tip_slot_no,
        chunk.slot_range_start,
        chunk.slot_range_end
    ) as { chunk_id: number };
    return result.chunk_id;
};

export function insertImmutableBlocks(blocks: any[], chunk_id: number): void {
    const stmt = getDB().prepare(`
        INSERT INTO immutable_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor, rollforward_header_cbor, chunk_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
    `);
    for (const block of blocks) {
        stmt.run(block.slot, block.block_hash, block.prev_hash, block.header_data, block.block_data, block.block_fetch_RawCbor, block.rollforward_header_cbor, chunk_id);
    }
};

export function deleteVolatileBlocks(blockHashes: string[]): void {
    const stmt = getDB().prepare(`
        DELETE FROM volatile_blocks
        WHERE block_hash = ?;
    `);
    for (const hash of blockHashes) {
        stmt.run(hash);
    }
};

export function deleteVolatileHeaders(headerHashes: string[]): void {
    const stmt = getDB().prepare(`
        DELETE FROM volatile_headers
        WHERE header_hash = ?;
    `);
    for (const hash of headerHashes) {
        stmt.run(hash);
    }
};