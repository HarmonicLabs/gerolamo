import { sql } from "bun";

export async function initNewEpochState() {
    await initBlocksMade();
    await initEpochState();
    await initPulsingRewUpdate();
    await initPoolDistr();
    await initStashedAVVMAddresses();
    await initStableState();

    // Create new_epoch_state table
    await sql`
        CREATE TABLE IF NOT EXISTS new_epoch_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            last_epoch_modified TEXT,
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

async function initBlocksMade() {
    // Create blocks_made table to store block production per pool per epoch
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

async function initEpochState() {
    // Create blocks table for volatile block storage
    await sql`
        CREATE TABLE IF NOT EXISTS blocks (
            hash BLOB PRIMARY KEY,
            data JSONB NOT NULL,
            slot INTEGER NOT NULL
        );
    `;

    // Create utxo table
    await sql`
        CREATE TABLE IF NOT EXISTS utxo (
            utxo_ref BLOB,
            tx_out JSONB,
            PRIMARY KEY (utxo_ref)
        );
    `;

    // Create cert_state table
    await sql`
        CREATE TABLE IF NOT EXISTS cert_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data JSONB
        );
    `;

    // Create ledger_state table
    await sql`
        CREATE TABLE IF NOT EXISTS ledger_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            utxo_deposited INTEGER,
            utxo_fees INTEGER,
            utxo_gov_state BLOB,
            utxo_instant_stake BLOB,
            utxo_donation INTEGER,
            cert_state_id INTEGER,
            FOREIGN KEY (cert_state_id) REFERENCES cert_state(id)
        );
    `;

    // Create new_epoch_state table
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

    // Create epoch_state table
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

    // Create chain_account_state table
    await sql`
        CREATE TABLE IF NOT EXISTS chain_account_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            treasury INTEGER,
            reserves INTEGER
        );
    `;

    // Create snapshots table
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

    // Create stake table
    await sql`
        CREATE TABLE IF NOT EXISTS stake (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            amount INTEGER
        );
    `;

    // Create rewards table
    await sql`
        CREATE TABLE IF NOT EXISTS rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            amount INTEGER
        );
    `;

    // Create delegations table
    await sql`
        CREATE TABLE IF NOT EXISTS delegations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stake_credentials BLOB,
            pool_key_hash BLOB
        );
    `;

    // Create non_myopic table
    await sql`
        CREATE TABLE IF NOT EXISTS non_myopic (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            likelihoods_id INTEGER,
            reward_pot INTEGER,
            FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
        );
    `;

    // Create likelihoods table
    await sql`
        CREATE TABLE IF NOT EXISTS likelihoods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_key_hash BLOB,
            likelihood JSONB
        );
    `;

    // Create protocol_params table
    await sql`
        CREATE TABLE IF NOT EXISTS protocol_params (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            params JSONB
        );
    `;
}

async function initPulsingRewUpdate() {
    // Create pulsing_rew_update table
    await sql`
        CREATE TABLE IF NOT EXISTS pulsing_rew_update (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data JSONB
        );
    `;
}

async function initPoolDistr() {
    // Create pool_distr table
    await sql`
        CREATE TABLE IF NOT EXISTS pool_distr (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pools JSONB,
            total_active_stake INTEGER
        );
    `;
}

async function initStashedAVVMAddresses() {
    // Create stashed_avvm_addresses table
    await sql`
        CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            addresses JSONB
        );
    `;
}

async function initStableState() {
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
