-- DB storage location: store/db/{network}/
-- Where {network} is 'mainnet' or 'preprod'

-- Volatile headers table
CREATE TABLE IF NOT EXISTS volatile_headers (
    slot BIGINT PRIMARY KEY,
    header_hash TEXT NOT NULL UNIQUE,
    rollforward_header_cbor BLOB NOT NULL,
    is_valid BOOLEAN DEFAULT TRUE
);

-- Protocol parameters table
CREATE TABLE IF NOT EXISTS protocol_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    params JSONB
);

-- Chain account state table
CREATE TABLE IF NOT EXISTS chain_account_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    treasury INTEGER,
    reserves INTEGER
);

-- Pool distribution table
CREATE TABLE IF NOT EXISTS pool_distr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pools JSONB,
    total_active_stake INTEGER
);

-- Blocks made table
CREATE TABLE IF NOT EXISTS blocks_made (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_key_hash BLOB,
    epoch INTEGER,
    block_count INTEGER,
    status TEXT CHECK(status IN ('CURR', 'PREV', 'LEGACY')) NOT NULL DEFAULT 'CURR',
    UNIQUE(pool_key_hash, epoch)
);

-- Stake table
CREATE TABLE IF NOT EXISTS stake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stake_credentials BLOB,
    amount INTEGER
);

-- Delegations table
CREATE TABLE IF NOT EXISTS delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stake_credentials BLOB,
    pool_key_hash BLOB
);

-- Rewards table
CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stake_credentials BLOB,
    amount INTEGER
);

-- Likelihoods table (for non-myopic)
CREATE TABLE IF NOT EXISTS likelihoods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_key_hash BLOB,
    likelihood JSONB
);

-- UTxO table
CREATE TABLE IF NOT EXISTS utxo (
    utxo_ref BLOB,
    tx_out JSONB,
    tx_hash TEXT,
    PRIMARY KEY (utxo_ref)
);

-- Certificate state table
CREATE TABLE IF NOT EXISTS cert_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data JSONB
);

-- Pulsing reward update table
CREATE TABLE IF NOT EXISTS pulsing_rew_update (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data JSONB
);

-- Stashed AVVM addresses table
CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    addresses JSONB
);

-- Non-myopic table
CREATE TABLE IF NOT EXISTS non_myopic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_pot INTEGER,
    likelihoods_id INTEGER,
    FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
);

-- Ledger state table
CREATE TABLE IF NOT EXISTS ledger_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utxo_deposited INTEGER,
    utxo_fees INTEGER,
    utxo_donation INTEGER,
    utxo_gov_state BLOB,
    utxo_instant_stake BLOB,
    cert_state_id INTEGER,
    FOREIGN KEY (cert_state_id) REFERENCES cert_state(id)
);

-- Snapshots table
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stake_id INTEGER,
    rewards_id INTEGER,
    delegations_id INTEGER,
    FOREIGN KEY (stake_id) REFERENCES stake(id),
    FOREIGN KEY (rewards_id) REFERENCES rewards(id),
    FOREIGN KEY (delegations_id) REFERENCES delegations(id)
);

-- Epoch state table
CREATE TABLE IF NOT EXISTS epoch_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_account_state_id INTEGER,
    ledger_state_id INTEGER,
    snapshots_id INTEGER,
    non_myopic_id INTEGER,
    pparams_id INTEGER,
    FOREIGN KEY (chain_account_state_id) REFERENCES chain_account_state(id),
    FOREIGN KEY (ledger_state_id) REFERENCES ledger_state(id),
    FOREIGN KEY (snapshots_id) REFERENCES snapshots(id),
    FOREIGN KEY (non_myopic_id) REFERENCES non_myopic(id),
    FOREIGN KEY (pparams_id) REFERENCES protocol_params(id)
);

-- New epoch state table (root)
CREATE TABLE IF NOT EXISTS new_epoch_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_epoch_modified INTEGER,
    prev_blocks_id INTEGER,
    curr_blocks_id INTEGER,
    epoch_state_id INTEGER,
    pulsing_rew_update_id INTEGER,
    pool_distr_id INTEGER,
    stashed_avvm_addresses_id INTEGER,
    FOREIGN KEY (prev_blocks_id) REFERENCES blocks_made(id),
    FOREIGN KEY (curr_blocks_id) REFERENCES blocks_made(id),
    FOREIGN KEY (epoch_state_id) REFERENCES epoch_state(id),
    FOREIGN KEY (pulsing_rew_update_id) REFERENCES pulsing_rew_update(id),
    FOREIGN KEY (pool_distr_id) REFERENCES pool_distr(id),
    FOREIGN KEY (stashed_avvm_addresses_id) REFERENCES stashed_avvm_addresses(id)
);

-- Immutable chunks table
CREATE TABLE IF NOT EXISTS immutable_chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_no INTEGER NOT NULL UNIQUE,
    tip_hash TEXT NOT NULL,
    tip_slot_no BIGINT NOT NULL,
    slot_range_start BIGINT NOT NULL,
    slot_range_end BIGINT NOT NULL,
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
);

-- Immutable blocks table
CREATE TABLE IF NOT EXISTS immutable_blocks (
    slot INTEGER PRIMARY KEY,
    block_hash BLOB NOT NULL,
    block_data JSONB NOT NULL,
    prev_hash BLOB,
    header_data BLOB,
    rollforward_header_cbor BLOB,
    block_fetch_RawCbor BLOB,
    chunk_id INTEGER,
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now')),
    UNIQUE(block_hash),
    FOREIGN KEY (chunk_id) REFERENCES immutable_chunks(chunk_id) ON DELETE CASCADE
);

-- Stable state table
CREATE TABLE IF NOT EXISTS stable_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    immutable_tip_hash BLOB,
    immutable_tip_slot INTEGER,
    total_blocks INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Volatile blocks table
CREATE TABLE IF NOT EXISTS blocks (
    hash BLOB PRIMARY KEY,
    slot INTEGER NOT NULL,
    header_data BLOB,
    block_data BLOB,
    block_fetch_RawCbor BLOB,
    is_valid BOOLEAN DEFAULT TRUE,
    prev_hash BLOB,
    inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
);

-- UTxO deltas table
CREATE TABLE IF NOT EXISTS utxo_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_hash BLOB NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('spend', 'create', 'cert', 'fee', 'withdrawal')),
    utxo JSONB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for volatile_headers
CREATE INDEX IF NOT EXISTS idx_volatile_headers_hash ON volatile_headers(header_hash);
CREATE INDEX IF NOT EXISTS idx_volatile_headers_slot ON volatile_headers(slot);

-- Indexes for volatile blocks
CREATE INDEX IF NOT EXISTS idx_volatile_slot ON blocks (slot);
CREATE INDEX IF NOT EXISTS idx_volatile_hash ON blocks (hash);
CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON blocks (prev_hash);

-- Indexes for immutable blocks
CREATE INDEX IF NOT EXISTS idx_immutable_slot ON immutable_blocks (slot);
CREATE INDEX IF NOT EXISTS idx_immutable_hash ON immutable_blocks (block_hash);
CREATE INDEX IF NOT EXISTS idx_immutable_chunk ON immutable_blocks (chunk_id);

-- Index for utxo table
CREATE INDEX IF NOT EXISTS idx_utxo_tx_hash ON utxo(tx_hash);

-- Trigger GC (delete invalid old blocks; customize k=2160)
CREATE TRIGGER IF NOT EXISTS gc_volatile AFTER INSERT ON blocks
BEGIN
    DELETE FROM blocks WHERE slot < (SELECT MAX(slot) - 2160 FROM blocks) AND is_valid = FALSE;
    DELETE FROM volatile_headers WHERE slot < (SELECT MAX(slot) - 2160 FROM volatile_headers) AND is_valid = FALSE;
END;