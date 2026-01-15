-- schemas.sql
-- SQLite schema inspired by Cardano's ImmutableDB, VolatileDB, and LedgerDB
-- THis is subject to change as we refine the design

-- VolatileDB: Recent, mutable headers (prunable on forks)
CREATE TABLE IF NOT EXISTS volatile_headers (
    slot BIGINT PRIMARY KEY,
    header_hash TEXT NOT NULL UNIQUE,
    rollforward_header_cbor BLOB NOT NULL,
    is_valid BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_volatile_headers_hash ON volatile_headers(header_hash);
CREATE INDEX IF NOT EXISTS idx_volatile_headers_slot ON volatile_headers(slot);

-- VolatileDB: Recent, mutable blocks (prunable on forks)
CREATE TABLE IF NOT EXISTS volatile_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Unique auto-incremented ID for the block entry
    slot BIGINT NOT NULL,  -- Absolute slot number of the block
    block_hash TEXT NOT NULL UNIQUE,  -- Hex string of the block's hash
    prev_hash TEXT NOT NULL,  -- Hex string of the previous block's hash
    header_data BLOB NOT NULL,  -- Serialized CBOR data of the block header
    block_data BLOB NOT NULL,  -- Serialized CBOR data of the full block (including transactions)
    block_fetch_RawCbor BLOB NOT NULL,  -- Raw CBOR data as fetched from the Ouroboros mini-protocols ready for serving.
    is_valid BOOLEAN DEFAULT TRUE,  -- Validation status flag (FALSE on errors or forks)
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))   -- Timestamp when the block was inserted
);

CREATE INDEX IF NOT EXISTS idx_volatile_slot ON volatile_blocks (slot);
CREATE INDEX IF NOT EXISTS idx_volatile_hash ON volatile_blocks (block_hash);
CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON volatile_blocks (prev_hash);

-- Trigger GC (delete invalid old blocks; customize k=2160)
CREATE TRIGGER IF NOT EXISTS gc_volatile AFTER INSERT ON volatile_blocks
BEGIN
    DELETE FROM volatile_blocks WHERE slot < (SELECT MAX(slot) - 2160 FROM volatile_blocks) AND is_valid = FALSE;
    DELETE FROM volatile_headers WHERE slot < (SELECT MAX(slot) - 2160 FROM volatile_headers) AND is_valid = FALSE;
END;

-- ImmutableDB: Stable, historical blocks in chunks
CREATE TABLE IF NOT EXISTS immutable_chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Unique auto-incremented ID for the chunk
    chunk_no INTEGER NOT NULL UNIQUE,  -- Sequential number of the chunk (unique across chunks)
    tip_hash TEXT NOT NULL,  -- Hex string of the hash of the last (tip) block in the chunk
    tip_slot_no BIGINT NOT NULL,  -- Absolute slot number of the last (tip) block in the chunk
    slot_range_start BIGINT NOT NULL,  -- Absolute slot of the first block in the chunk
    slot_range_end BIGINT NOT NULL,    -- Absolute slot of the last (tip) block in the chunk
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))  -- Timestamp when the chunk was created
);

CREATE TABLE IF NOT EXISTS immutable_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Unique auto-incremented ID for the block entry
    chunk_id INTEGER NOT NULL REFERENCES immutable_chunks(chunk_id) ON DELETE CASCADE,  -- Foreign key to the containing chunk
    slot BIGINT NOT NULL,  -- Absolute slot number of the block
    block_hash TEXT NOT NULL UNIQUE,  -- Hex string of the block's hash
    prev_hash TEXT NOT NULL,  -- Hex string of the previous block's hash
    header_data BLOB NOT NULL,  -- Serialized CBOR data of the block header
    block_data BLOB NOT NULL,  -- Serialized CBOR data of the full block (including transactions)
    rollforward_header_cbor BLOB NOT NULL,  -- Serialized CBOR data of the rollforward header
    block_fetch_RawCbor BLOB NOT NULL,  -- Raw CBOR data as fetched from the Ouroboros mini-protocols ready for serving.
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))  -- Timestamp when the block was inserted
);

CREATE INDEX IF NOT EXISTS idx_immutable_slot ON immutable_blocks (slot);
CREATE INDEX IF NOT EXISTS idx_immutable_hash ON immutable_blocks (block_hash);
CREATE INDEX IF NOT EXISTS idx_immutable_chunk ON immutable_blocks (chunk_id);

-- LedgerDB: State snapshots
CREATE TABLE IF NOT EXISTS ledger_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Unique auto-incremented ID for the snapshot
    snapshot_no INTEGER NOT NULL UNIQUE,  -- Sequential number of the snapshot
    tip_point TEXT NOT NULL,  -- JSON or serialized tip (slot + hash) of the ledger state
    utxo_size BIGINT,  -- Size of the UTxO set in the snapshot
    deleg_map_size BIGINT,  -- Size of the delegation map
    drep_count BIGINT,  -- Count of DReps (Delegated Representatives)
    drep_map_size BIGINT,  -- Size of the DRep map
    state_data BLOB NOT NULL,  -- Serialized full ledger state (UTxO, delegations, etc.)
    enclosed_time TIMESTAMP,  -- Timestamp enclosed in the snapshot
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))  -- Timestamp when the snapshot was created
);

CREATE INDEX IF NOT EXISTS idx_ledger_snapshot_no ON ledger_snapshots (snapshot_no);
CREATE INDEX IF NOT EXISTS idx_ledger_tip ON ledger_snapshots (tip_point);

-- Optional Trigger to mimic Snapshot Cleanup (e.g., keep only last N snapshots)
CREATE TRIGGER IF NOT EXISTS cleanup_snapshots AFTER INSERT ON ledger_snapshots
BEGIN
    DELETE FROM ledger_snapshots WHERE snapshot_no < (SELECT MAX(snapshot_no) - 10 FROM ledger_snapshots);  -- Keep last 10; configurable
END;

-- Transactions Table: Unified storage for transactions from immutable and volatile blocks
CREATE TABLE IF NOT EXISTS transactions (
    txid TEXT PRIMARY KEY NOT NULL UNIQUE,  -- Hex string of the transaction hash (unique ID)
    block_hash TEXT NOT NULL,  -- Hex string of the containing block's hash
    tx_index INTEGER NOT NULL CHECK (tx_index >= 0),  -- 0-based index within the block
    slot BIGINT NOT NULL CHECK (slot >= 0),  -- Absolute slot of the containing block
    epoch INTEGER NOT NULL CHECK (epoch >= 0),  -- Epoch of the containing block
    chunk_id INTEGER,  -- Reference to immutable chunk (NULL for volatile)
    snapshot_id INTEGER,  -- Reference to ledger snapshot (optional)
    is_immutable BOOLEAN NOT NULL,  -- TRUE if from immutable block, FALSE if volatile
    transaction_data BLOB NOT NULL,  -- Serialized CBOR data of the transaction
    inserted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- Timestamp when inserted
    UNIQUE (block_hash, tx_index),  -- Ensures uniqueness within a block
    CHECK (chunk_id IS NULL OR is_immutable = TRUE),  -- Chunk only for immutable
    CHECK (snapshot_id IS NULL OR snapshot_id > 0),  -- Valid snapshot ID if set
    FOREIGN KEY (chunk_id) REFERENCES immutable_chunks(chunk_id),  -- Link to chunks
    FOREIGN KEY (snapshot_id) REFERENCES ledger_snapshots(snapshot_id)  -- Link to snapshots
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_tx_block_hash ON transactions (block_hash);
CREATE INDEX IF NOT EXISTS idx_tx_slot ON transactions (slot);
CREATE INDEX IF NOT EXISTS idx_tx_epoch ON transactions (epoch);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_id ON transactions (chunk_id);
CREATE INDEX IF NOT EXISTS idx_tx_snapshot_id ON transactions (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tx_is_immutable ON transactions (is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_epoch_slot ON transactions (epoch, slot);
CREATE INDEX IF NOT EXISTS idx_tx_block_hash_tx_index ON transactions (block_hash, tx_index);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_slot ON transactions (chunk_id, slot);
CREATE INDEX IF NOT EXISTS idx_tx_snapshot_slot ON transactions (snapshot_id, slot);
CREATE INDEX IF NOT EXISTS idx_tx_immutable_slot ON transactions (is_immutable, slot);
CREATE INDEX IF NOT EXISTS idx_tx_immutable_epoch ON transactions (is_immutable, epoch);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_epoch ON transactions (chunk_id, epoch);
CREATE INDEX IF NOT EXISTS idx_tx_multi_time ON transactions (epoch, slot, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_epoch_slot ON transactions (chunk_id, epoch, slot);
CREATE INDEX IF NOT EXISTS idx_tx_snapshot_epoch_slot ON transactions (snapshot_id, epoch, slot);
CREATE INDEX IF NOT EXISTS idx_tx_immutable_block_slot ON transactions (is_immutable, block_hash, slot);
CREATE INDEX IF NOT EXISTS idx_tx_snapshot_immutable_epoch ON transactions (snapshot_id, is_immutable, epoch);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_epoch_slot_immutable ON transactions (chunk_id, epoch, slot, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_snapshot_epoch_slot_immutable ON transactions (snapshot_id, epoch, slot, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_immutable_block_epoch_slot ON transactions (is_immutable, block_hash, epoch, slot);
CREATE INDEX IF NOT EXISTS idx_tx_chunk_snapshot_epoch_slot_immutable ON transactions (chunk_id, snapshot_id, epoch, slot, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_block_chunk_snapshot_epoch_slot ON transactions (block_hash, chunk_id, snapshot_id, epoch, slot);
CREATE INDEX IF NOT EXISTS idx_tx_block_chunk_snapshot_epoch_slot_immutable ON transactions (block_hash, chunk_id, snapshot_id, epoch, slot, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_block_first ON transactions (block_hash, tx_index, slot, epoch, chunk_id, snapshot_id, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_epoch_first ON transactions (epoch, slot, block_hash, tx_index, chunk_id, snapshot_id, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_snapshot_first ON transactions (snapshot_id, epoch, slot, block_hash, tx_index, chunk_id, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_chunk_first ON transactions (chunk_id, epoch, slot, block_hash, tx_index, snapshot_id, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_immutable_first ON transactions (is_immutable, epoch, slot, block_hash, tx_index, chunk_id, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tx_full_slot_first ON transactions (slot, epoch, block_hash, tx_index, chunk_id, snapshot_id, is_immutable);
CREATE INDEX IF NOT EXISTS idx_tx_full_tx_index_first ON transactions (tx_index, block_hash, slot, epoch, chunk_id, snapshot_id, is_immutable);