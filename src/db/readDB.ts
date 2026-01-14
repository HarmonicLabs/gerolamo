import { Database } from 'bun:sqlite';
import { getDB } from './dbUtils.js';
import type { 
    VolatileBlockRow, 
    ImmutableBlockRow, 
    VolatileHeaderRow, 
    TransactionRow, 
    LedgerSnapshotRow 
} from './types.js';

export function getBlockByHash(dbPath: string, hash: string): VolatileBlockRow | ImmutableBlockRow | undefined {
    const stmt = getDB(dbPath).prepare('SELECT * FROM volatile_blocks WHERE block_hash = ? UNION SELECT * FROM immutable_blocks WHERE block_hash = ?');
    return stmt.get(hash, hash) as VolatileBlockRow | ImmutableBlockRow | undefined;
};

export function getBlockBySlot(dbPath: string, slot: bigint): VolatileBlockRow | ImmutableBlockRow | undefined {
    const stmt = getDB(dbPath).prepare('SELECT * FROM volatile_blocks WHERE slot = ? UNION SELECT * FROM immutable_blocks WHERE slot = ?');
    return stmt.get(slot, slot) as VolatileBlockRow | ImmutableBlockRow | undefined;
};

export function getTransactionByTxId(dbPath: string, txid: string): TransactionRow | undefined {
    const stmt = getDB(dbPath).prepare('SELECT * FROM transactions WHERE txid = ?');
    return stmt.get(txid) as TransactionRow | undefined;
};

export function getBlocksInEpoch(dbPath: string, epoch: number): unknown[] {
    const stmt = getDB(dbPath).prepare(`
        SELECT * FROM volatile_blocks vb
        INNER JOIN transactions t ON vb.block_hash = t.block_hash
        WHERE t.epoch = ?
        UNION
        SELECT * FROM immutable_blocks ib
        INNER JOIN transactions t ON ib.block_hash = t.block_hash
        WHERE t.epoch = ?
    `);
    return stmt.all(epoch, epoch) as unknown[];
};

export async function getMaxSlot(dbPath: string): Promise<bigint> {
    const stmt = getDB(dbPath).prepare('SELECT MAX(slot) as max_slot FROM volatile_blocks');
    const row = stmt.get() as { max_slot: number | null } | undefined;
    return BigInt(row?.max_slot ?? 0);
};

export async function getValidHeadersBefore(dbPath: string, cutoffSlot: bigint): Promise<VolatileHeaderRow[]> {
    const stmt = getDB(dbPath).prepare(`
        SELECT * FROM volatile_headers
        WHERE slot < ? AND is_valid = TRUE
        ORDER BY slot ASC
    `);
    const rows = stmt.all(cutoffSlot);
    return rows as VolatileHeaderRow[];
};

export async function getValidBlocksBefore(dbPath: string, cutoffSlot: bigint): Promise<VolatileBlockRow[]> {
    const stmt = getDB(dbPath).prepare(`
        SELECT * FROM volatile_blocks
        WHERE slot < ? AND is_valid = TRUE
        ORDER BY slot ASC
    `);
    const rows = stmt.all(cutoffSlot);
    return rows as VolatileBlockRow[];
};

export async function getNextChunk(dbPath: string): Promise<{ next_chunk: number }> {
    const stmt = getDB(dbPath).prepare('SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks');
    const row = stmt.get() as { next_chunk: number };
    return row;
};

export function getLedgerSnapshot(dbPath: string, snapshotNo: number): LedgerSnapshotRow | undefined {
    const stmt = getDB(dbPath).prepare('SELECT * FROM ledger_snapshots WHERE snapshot_no = ?');
    return stmt.get(snapshotNo) as LedgerSnapshotRow | undefined;
};