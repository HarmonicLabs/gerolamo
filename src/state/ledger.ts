// DEPRECATED: This file is no longer needed as ledger tables are initialized via hari_schema.sql in DB.ts.
// Tables are created during DB.ensureInitialized() which loads the schema.
// This file can be removed once confirmed no other dependencies exist.

import { sql } from "bun";

export async function initNewEpochState() {
    // Initialize all NES component tables
    await initProtocolParams();
    await initChainAccountState();
    await initPoolDistr();
    await initBlocksMade();
    await initStake();
    await initDelegations();
    await initRewards();
    await initNonMyopic();
    await initUTxO();
    await initLedgerState();
    await initSnapshots();
    await initEpochState();
    await initPulsingRewUpdate();
    await initStashedAvvmAddresses();
    await initNewEpochStateTable();
    await initStableState();
    await initBlocks(); // volatile blocks
    await initUtxoDeltas();
}

// Protocol parameters table
async function initProtocolParams() {
    await sql`
        CREATE TABLE IF NOT EXISTS protocol_params (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            params JSONB
        );
    `;
}

// Chain account state table
async function initChainAccountState() {
    await sql`
        CREATE TABLE IF NOT EXISTS chain_account_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            treasury INTEGER,
            reserves INTEGER
        );
    `;
}

// Pool distribution table
async function initPoolDistr() {
    await sql`
        CREATE TABLE IF NOT EXISTS pool_distr (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pools JSONB,
            total_active_stake INTEGER
        );
    `;
}

// Blocks made table
async function initBlocksMade() {
    await sql`
        CREATE TABLE IF NOT EXISTS blocks_made (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_key_hash BLOB,
            epoch INTEGER,
            block_count INTEGER,
            status TEXT CHECK(status IN ('CURR', 'PREV', 'LEGACY')) NOT NULL DEFAULT 'CURR',
            UNIQUE(pool_key_hash, epoch)
        );
    `;
}

// Stake table
async function initStake() {
    await sql`
        CREATE TABLE IF NOT EXISTS stake (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            amount INTEGER
        );
    `;
}

// Delegations table
async function initDelegations() {
    await sql`
        CREATE TABLE IF NOT EXISTS delegations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            pool_key_hash BLOB
        );
    `;
}

// Rewards table
async function initRewards() {
    await sql`
        CREATE TABLE IF NOT EXISTS rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            amount INTEGER
        );
    `;
}

// Non-myopic table
async function initNonMyopic() {
    await sql`
        CREATE TABLE IF NOT EXISTS non_myopic (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reward_pot INTEGER,
            likelihoods_id INTEGER,
            FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
        );
    `;
}

// Likelihoods table (for non-myopic)
async function initLikelihoods() {
    await sql`
        CREATE TABLE IF NOT EXISTS likelihoods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_key_hash BLOB,
            likelihood JSONB
        );
    `;
}

// UTxO table
async function initUTxO() {
    await sql`
        CREATE TABLE IF NOT EXISTS utxo (
            utxo_ref BLOB,
            tx_out JSONB,
            PRIMARY KEY (utxo_ref)
        );
    `;
}

// Ledger state table
async function initLedgerState() {
    await sql`
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
    `;
}

// Certificate state table
async function initCertState() {
    await sql`
        CREATE TABLE IF NOT EXISTS cert_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data JSONB
        );
    `;
}

// Snapshots table
async function initSnapshots() {
    await sql`
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_id INTEGER,
            rewards_id INTEGER,
            delegations_id INTEGER,
            FOREIGN KEY (stake_id) REFERENCES stake(id),
            FOREIGN KEY (rewards_id) REFERENCES rewards(id),
            FOREIGN KEY (delegations_id) REFERENCES delegations(id)
        );
    `;
}

// Epoch state table
async function initEpochState() {
    await sql`
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
    `;
}

// Pulsing reward update table
async function initPulsingRewUpdate() {
    await sql`
        CREATE TABLE IF NOT EXISTS pulsing_rew_update (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data JSONB
        );
    `;
}

// Stashed AVVM addresses table
async function initStashedAvvmAddresses() {
    await sql`
        CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            addresses JSONB
        );
    `;
}

// New epoch state table (root)
async function initNewEpochStateTable() {
    await sql`
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
    `;
}

// Stable state tables (immutable blocks)
async function initStableState() {
    await sql`
        CREATE TABLE IF NOT EXISTS immutable_blocks (
            slot INTEGER PRIMARY KEY,
            hash BLOB NOT NULL,
            block_data JSONB NOT NULL,
            prev_hash BLOB,
            UNIQUE(hash)
        );
    `;

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

// Volatile blocks table
async function initBlocks() {
    await sql`
        CREATE TABLE IF NOT EXISTS blocks (
            hash BLOB PRIMARY KEY,
            slot INTEGER NOT NULL,
            header_data BLOB,
            block_data BLOB
        );
    `;
}

// UTxO deltas table
async function initUtxoDeltas() {
    await sql`
        CREATE TABLE IF NOT EXISTS utxo_deltas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_hash BLOB NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('spend', 'create', 'cert', 'fee', 'withdrawal')),
            utxo JSONB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `;
}
