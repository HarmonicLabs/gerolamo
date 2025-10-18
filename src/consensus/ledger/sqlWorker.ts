import { SQL } from "bun";

import { SQL } from "bun";

const DB_NAME = "./gerolamo.db";
const sql = new SQL(`sqlite://${DB_NAME}`);

// Initialize database tables and indexes
async function initDB() {
    // Schema version
    await sql`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY CHECK (version = 3)
        )
    `;

    // Basic metadata for NewEpochState
    await sql`
        CREATE TABLE IF NOT EXISTS nes_metadata (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            last_epoch_modified INTEGER NOT NULL,
            slots_per_kes_period INTEGER NOT NULL,
            max_kes_evolutions INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    // Blocks made by pools (prev and curr)
    await sql`
        CREATE TABLE IF NOT EXISTS nes_blocks_made (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            pool_hash BLOB NOT NULL,
            blocks_count INTEGER NOT NULL,
            is_current_epoch BOOLEAN NOT NULL,
            UNIQUE(epoch_no, pool_hash, is_current_epoch)
        )
    `;

    // Chain account state (treasury, reserves)
    await sql`
        CREATE TABLE IF NOT EXISTS nes_chain_account (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            treasury BIGINT NOT NULL,
            reserves BIGINT NOT NULL
        )
    `;

    // UTxO entries
    await sql`
        CREATE TABLE IF NOT EXISTS nes_utxo (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            tx_hash BLOB NOT NULL,
            tx_index INTEGER NOT NULL,
            address TEXT NOT NULL,
            amount BIGINT NOT NULL,
            datum_hash BLOB,
            script_ref BLOB,
            UNIQUE(epoch_no, tx_hash, tx_index)
        )
    `;

    // UTxO state metadata
    await sql`
        CREATE TABLE IF NOT EXISTS nes_utxo_state (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            deposited BIGINT NOT NULL,
            fees BIGINT NOT NULL,
            donation BIGINT NOT NULL
        )
    `;

    // Stake distribution
    await sql`
        CREATE TABLE IF NOT EXISTS nes_stake (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            stake_credentials BLOB NOT NULL,
            amount BIGINT NOT NULL,
            snapshot_type TEXT NOT NULL, -- 'mark', 'set', 'go'
            UNIQUE(epoch_no, stake_credentials, snapshot_type)
        )
    `;

    // Delegations
    await sql`
        CREATE TABLE IF NOT EXISTS nes_delegations (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            stake_credentials BLOB NOT NULL,
            pool_hash BLOB NOT NULL,
            snapshot_type TEXT NOT NULL, -- 'mark', 'set', 'go'
            UNIQUE(epoch_no, stake_credentials, snapshot_type)
        )
    `;

    // Pool parameters
    await sql`
        CREATE TABLE IF NOT EXISTS nes_pool_params (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            pool_hash BLOB NOT NULL,
            vrf_key_hash BLOB NOT NULL,
            pledge BIGINT NOT NULL,
            cost BIGINT NOT NULL,
            margin_numerator INTEGER NOT NULL,
            margin_denominator INTEGER NOT NULL,
            reward_account BLOB NOT NULL,
            owners BLOB NOT NULL, -- JSON array of owner hashes
            relays BLOB NOT NULL, -- JSON array of relay objects
            metadata_url TEXT,
            metadata_hash BLOB,
            snapshot_type TEXT NOT NULL, -- 'mark', 'set', 'go'
            UNIQUE(epoch_no, pool_hash, snapshot_type)
        )
    `;

    // Pool distribution
    await sql`
        CREATE TABLE IF NOT EXISTS nes_pool_distr (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            pool_hash BLOB NOT NULL,
            stake BIGINT NOT NULL,
            sigma DOUBLE NOT NULL,
            UNIQUE(epoch_no, pool_hash)
        )
    `;

    // Pool distribution metadata
    await sql`
        CREATE TABLE IF NOT EXISTS nes_pool_distr_meta (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            total_stake BIGINT NOT NULL
        )
    `;

    // Rewards
    await sql`
        CREATE TABLE IF NOT EXISTS nes_rewards (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            stake_credentials BLOB NOT NULL,
            amount BIGINT NOT NULL,
            reward_type TEXT NOT NULL, -- 'member', 'leader', 'reserves', etc.
            pool_hash BLOB, -- NULL for non-pool rewards
            UNIQUE(epoch_no, stake_credentials, reward_type)
        )
    `;

    // Non-myopic rewards data
    await sql`
        CREATE TABLE IF NOT EXISTS nes_non_myopic (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            likelihoods BLOB NOT NULL, -- Serialized Map<PoolKeyHash, Rational>
            reward_pot BIGINT NOT NULL
        )
    `;

    // Stashed AVVM addresses
    await sql`
        CREATE TABLE IF NOT EXISTS nes_stashed_avvm (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL,
            address BLOB NOT NULL,
            UNIQUE(epoch_no, address)
        )
    `;

    // Snapshot metadata
    await sql`
        CREATE TABLE IF NOT EXISTS nes_snapshots_meta (
            id INTEGER PRIMARY KEY,
            epoch_no INTEGER NOT NULL UNIQUE,
            mark_fee BIGINT NOT NULL,
            set_fee BIGINT NOT NULL,
            go_fee BIGINT NOT NULL
        )
    `;

    // Indexes for performance
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_metadata_epoch ON nes_metadata(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_blocks_made_epoch ON nes_blocks_made(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_chain_account_epoch ON nes_chain_account(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_utxo_epoch ON nes_utxo(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_utxo_state_epoch ON nes_utxo_state(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_stake_epoch ON nes_stake(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_delegations_epoch ON nes_delegations(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_pool_params_epoch ON nes_pool_params(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_pool_distr_epoch ON nes_pool_distr(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_rewards_epoch ON nes_rewards(epoch_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_nes_stashed_avvm_epoch ON nes_stashed_avvm(epoch_no)`;

    // Insert schema version
    await sql`
        INSERT OR IGNORE INTO schema_version (version) VALUES (3)
    `;
}

let initialized = false;

async function ensureInit() {
    if (!initialized) {
        await initDB();
        initialized = true;
    }
}

self.addEventListener("message", async (event: MessageEvent) => {
    const msg = event.data;
    await ensureInit();

    try {
        if (msg.type === "createNES") {
            await sql.begin(async (tx) => {
                await tx`
                    INSERT OR REPLACE INTO nes_metadata
                    (epoch_no, last_epoch_modified, slots_per_kes_period, max_kes_evolutions)
                    VALUES (${msg.epochNo}, ${msg.lastEpochModified}, ${msg.slotsPerKESPeriod}, ${msg.maxKESEvolutions})
                `;
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadNES") {
            const result = await sql`
                SELECT * FROM nes_metadata WHERE epoch_no = ${msg.epochNo}
            `;
            const exists = result.length > 0;
            const metadata = exists ? result[0] : undefined;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: { exists, metadata },
            });

        } else if (msg.type === "saveBlocksMade") {
            await sql.begin(async (tx) => {
                // Clear existing blocks for this epoch and type
                await tx`
                    DELETE FROM nes_blocks_made
                    WHERE epoch_no = ${msg.epochNo} AND is_current_epoch = ${msg.isCurrent}
                `;
                // Insert new blocks
                for (const [poolHash, count] of Object.entries(msg.blocksMade)) {
                    await tx`
                        INSERT INTO nes_blocks_made (epoch_no, pool_hash, blocks_count, is_current_epoch)
                        VALUES (${msg.epochNo}, ${poolHash}, ${count}, ${msg.isCurrent})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadBlocksMade") {
            const result = await sql`
                SELECT pool_hash, blocks_count FROM nes_blocks_made
                WHERE epoch_no = ${msg.epochNo} AND is_current_epoch = ${msg.isCurrent}
            `;
            const blocksMade = Object.fromEntries(
                result.map(row => [row.pool_hash, row.blocks_count])
            );
            self.postMessage({
                type: "result",
                id: msg.id,
                data: blocksMade,
            });

        } else if (msg.type === "saveChainAccount") {
            await sql`
                INSERT OR REPLACE INTO nes_chain_account (epoch_no, treasury, reserves)
                VALUES (${msg.epochNo}, ${msg.treasury}, ${msg.reserves})
            `;
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadChainAccount") {
            const result = await sql`
                SELECT treasury, reserves FROM nes_chain_account WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0] : null,
            });

        } else if (msg.type === "saveUTxO") {
            await sql.begin(async (tx) => {
                // Clear existing UTxO for this epoch
                await tx`DELETE FROM nes_utxo WHERE epoch_no = ${msg.epochNo}`;
                // Insert new UTxO entries
                for (const utxo of msg.utxos) {
                    await tx`
                        INSERT INTO nes_utxo (epoch_no, tx_hash, tx_index, address, amount, datum_hash, script_ref)
                        VALUES (${msg.epochNo}, ${utxo.txHash}, ${utxo.txIndex}, ${utxo.address}, ${utxo.amount}, ${utxo.datumHash}, ${utxo.scriptRef})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "saveUTxOState") {
            await sql`
                INSERT OR REPLACE INTO nes_utxo_state (epoch_no, deposited, fees, donation)
                VALUES (${msg.epochNo}, ${msg.deposited}, ${msg.fees}, ${msg.donation})
            `;
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadUTxO") {
            const utxos = await sql`
                SELECT tx_hash, tx_index, address, amount, datum_hash, script_ref FROM nes_utxo
                WHERE epoch_no = ${msg.epochNo}
            `;
            const state = await sql`
                SELECT deposited, fees, donation FROM nes_utxo_state WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: {
                    utxos: utxos,
                    state: state.length > 0 ? state[0] : null,
                },
            });

        } else if (msg.type === "saveStake") {
            await sql.begin(async (tx) => {
                // Clear existing stake for this epoch and snapshot type
                await tx`
                    DELETE FROM nes_stake
                    WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
                `;
                // Insert new stake entries
                for (const [credentials, amount] of msg.stake) {
                    await tx`
                        INSERT INTO nes_stake (epoch_no, stake_credentials, amount, snapshot_type)
                        VALUES (${msg.epochNo}, ${credentials}, ${amount}, ${msg.snapshotType})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadStake") {
            const result = await sql`
                SELECT stake_credentials, amount FROM nes_stake
                WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
            `;
            const stake = result.map(row => [row.stake_credentials, row.amount]);
            self.postMessage({
                type: "result",
                id: msg.id,
                data: stake,
            });

        } else if (msg.type === "saveDelegations") {
            await sql.begin(async (tx) => {
                // Clear existing delegations for this epoch and snapshot type
                await tx`
                    DELETE FROM nes_delegations
                    WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
                `;
                // Insert new delegation entries
                for (const [credentials, poolHash] of msg.delegations) {
                    await tx`
                        INSERT INTO nes_delegations (epoch_no, stake_credentials, pool_hash, snapshot_type)
                        VALUES (${msg.epochNo}, ${credentials}, ${poolHash}, ${msg.snapshotType})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadDelegations") {
            const result = await sql`
                SELECT stake_credentials, pool_hash FROM nes_delegations
                WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
            `;
            const delegations = result.map(row => [row.stake_credentials, row.pool_hash]);
            self.postMessage({
                type: "result",
                id: msg.id,
                data: delegations,
            });

        } else if (msg.type === "savePoolParams") {
            await sql.begin(async (tx) => {
                // Clear existing pool params for this epoch and snapshot type
                await tx`
                    DELETE FROM nes_pool_params
                    WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
                `;
                // Insert new pool param entries
                for (const [poolHash, params] of msg.poolParams) {
                    await tx`
                        INSERT INTO nes_pool_params (
                            epoch_no, pool_hash, vrf_key_hash, pledge, cost,
                            margin_numerator, margin_denominator, reward_account,
                            owners, relays, metadata_url, metadata_hash, snapshot_type
                        ) VALUES (
                            ${msg.epochNo}, ${poolHash}, ${params.vrfKeyHash}, ${params.pledge}, ${params.cost},
                            ${params.marginNumerator}, ${params.marginDenominator}, ${params.rewardAccount},
                            ${JSON.stringify(params.owners)}, ${JSON.stringify(params.relays)},
                            ${params.metadataUrl}, ${params.metadataHash}, ${msg.snapshotType}
                        )
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadPoolParams") {
            const result = await sql`
                SELECT pool_hash, vrf_key_hash, pledge, cost, margin_numerator, margin_denominator,
                       reward_account, owners, relays, metadata_url, metadata_hash
                FROM nes_pool_params
                WHERE epoch_no = ${msg.epochNo} AND snapshot_type = ${msg.snapshotType}
            `;
            const poolParams = new Map();
            for (const row of result) {
                poolParams.set(row.pool_hash, {
                    vrfKeyHash: row.vrf_key_hash,
                    pledge: row.pledge,
                    cost: row.cost,
                    marginNumerator: row.margin_numerator,
                    marginDenominator: row.margin_denominator,
                    rewardAccount: row.reward_account,
                    owners: JSON.parse(row.owners),
                    relays: JSON.parse(row.relays),
                    metadataUrl: row.metadata_url,
                    metadataHash: row.metadata_hash,
                });
            }
            self.postMessage({
                type: "result",
                id: msg.id,
                data: Array.from(poolParams.entries()),
            });

        } else if (msg.type === "savePoolDistr") {
            await sql.begin(async (tx) => {
                // Clear existing pool distribution for this epoch
                await tx`DELETE FROM nes_pool_distr WHERE epoch_no = ${msg.epochNo}`;
                // Insert new pool distribution entries
                for (const [poolHash, distr] of msg.poolDistr) {
                    await tx`
                        INSERT INTO nes_pool_distr (epoch_no, pool_hash, stake, sigma)
                        VALUES (${msg.epochNo}, ${poolHash}, ${distr.stake}, ${distr.sigma})
                    `;
                }
                // Save metadata
                await tx`
                    INSERT OR REPLACE INTO nes_pool_distr_meta (epoch_no, total_stake)
                    VALUES (${msg.epochNo}, ${msg.totalStake})
                `;
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadPoolDistr") {
            const distr = await sql`
                SELECT pool_hash, stake, sigma FROM nes_pool_distr WHERE epoch_no = ${msg.epochNo}
            `;
            const meta = await sql`
                SELECT total_stake FROM nes_pool_distr_meta WHERE epoch_no = ${msg.epochNo}
            `;
            const poolDistr = distr.map(row => [row.pool_hash, { stake: row.stake, sigma: row.sigma }]);
            self.postMessage({
                type: "result",
                id: msg.id,
                data: {
                    poolDistr,
                    totalStake: meta.length > 0 ? meta[0].total_stake : 0n,
                },
            });

        } else if (msg.type === "saveRewards") {
            await sql.begin(async (tx) => {
                // Clear existing rewards for this epoch
                await tx`DELETE FROM nes_rewards WHERE epoch_no = ${msg.epochNo}`;
                // Insert new reward entries
                for (const reward of msg.rewards) {
                    await tx`
                        INSERT INTO nes_rewards (epoch_no, stake_credentials, amount, reward_type, pool_hash)
                        VALUES (${msg.epochNo}, ${reward.credentials}, ${reward.amount}, ${reward.type}, ${reward.poolHash})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadRewards") {
            const result = await sql`
                SELECT stake_credentials, amount, reward_type, pool_hash FROM nes_rewards
                WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result,
            });

        } else if (msg.type === "saveNonMyopic") {
            await sql`
                INSERT OR REPLACE INTO nes_non_myopic (epoch_no, likelihoods, reward_pot)
                VALUES (${msg.epochNo}, ${msg.likelihoods}, ${msg.rewardPot})
            `;
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadNonMyopic") {
            const result = await sql`
                SELECT likelihoods, reward_pot FROM nes_non_myopic WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0] : null,
            });

        } else if (msg.type === "saveStashedAVVM") {
            await sql.begin(async (tx) => {
                // Clear existing stashed addresses for this epoch
                await tx`DELETE FROM nes_stashed_avvm WHERE epoch_no = ${msg.epochNo}`;
                // Insert new stashed addresses
                for (const address of msg.addresses) {
                    await tx`
                        INSERT INTO nes_stashed_avvm (epoch_no, address) VALUES (${msg.epochNo}, ${address})
                    `;
                }
            });
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadStashedAVVM") {
            const result = await sql`
                SELECT address FROM nes_stashed_avvm WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.map(row => row.address),
            });

        } else if (msg.type === "saveSnapshotsMeta") {
            await sql`
                INSERT OR REPLACE INTO nes_snapshots_meta (epoch_no, mark_fee, set_fee, go_fee)
                VALUES (${msg.epochNo}, ${msg.markFee}, ${msg.setFee}, ${msg.goFee})
            `;
            self.postMessage({ type: "done", id: msg.id });

        } else if (msg.type === "loadSnapshotsMeta") {
            const result = await sql`
                SELECT mark_fee, set_fee, go_fee FROM nes_snapshots_meta WHERE epoch_no = ${msg.epochNo}
            `;
            self.postMessage({
                type: "result",
                id: msg.id,
                data: result.length > 0 ? result[0] : null,
            });

        } else if (msg.type === "closeDB") {
            await sql.close();
            self.postMessage({ type: "done", id: msg.id });

        } else {
            throw new Error(`Unknown message type: ${msg.type}`);
        }
    } catch (error: any) {
        console.error(`Error in ${msg.type}:`, error);
        self.postMessage({
            type: "error",
            id: msg.id,
            error: error.message,
        });
    }
});