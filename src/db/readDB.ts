import { Database } from 'bun:sqlite';

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

export function getBlockByHash(hash: string): any {
    const stmt = getDB().prepare('SELECT * FROM volatile_blocks WHERE block_hash = ? UNION SELECT * FROM immutable_blocks WHERE block_hash = ?');
    return stmt.get(hash, hash);
};

export function getBlockBySlot(slot: bigint): any {
    const stmt = getDB().prepare('SELECT * FROM volatile_blocks WHERE slot = ? UNION SELECT * FROM immutable_blocks WHERE slot = ?');
    return stmt.get(slot, slot);
};

export function getTransactionByTxId(txid: string): any {
    const stmt = getDB().prepare('SELECT * FROM transactions WHERE txid = ?');
    return stmt.get(txid);
};

export function getBlocksInEpoch(epoch: number): any[] {
    const stmt = getDB().prepare(`
        SELECT * FROM volatile_blocks vb
        INNER JOIN transactions t ON vb.block_hash = t.block_hash
        WHERE t.epoch = ?
        UNION
        SELECT * FROM immutable_blocks ib
        INNER JOIN transactions t ON ib.block_hash = t.block_hash
        WHERE t.epoch = ?
    `);
    return stmt.all(epoch, epoch);
};

export async function getMaxSlot(): Promise<bigint> {
    const stmt = getDB().prepare('SELECT MAX(slot) as max_slot FROM volatile_blocks');
    const row = await stmt.get() as { max_slot: number | null } | undefined;
    return BigInt(row?.max_slot ?? 0);
};
export async function getValidHeadersBefore(cutoffSlot: bigint): Promise<any[]> {
    const stmt = getDB().prepare(`
        SELECT * FROM volatile_headers
        WHERE slot < ? AND is_valid = TRUE
        ORDER BY slot ASC
    `);
    const rows = stmt.all(cutoffSlot);
    return rows;
};

export async function getValidBlocksBefore(cutoffSlot: bigint): Promise<any[]> {
    const stmt = getDB().prepare(`
        SELECT * FROM volatile_blocks
        WHERE slot < ? AND is_valid = TRUE
        ORDER BY slot ASC
    `);
    const rows = stmt.all(cutoffSlot);
    return rows;
};

export async function getNextChunk(): Promise<{ next_chunk: number }> {
    const stmt = getDB().prepare('SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks');
    const row = stmt.get() as { next_chunk: number };
    return row;
};

export function getLedgerSnapshot(snapshotNo: number): any {
    const stmt = getDB().prepare('SELECT * FROM ledger_snapshots WHERE snapshot_no = ?');
    return stmt.get(snapshotNo);
};