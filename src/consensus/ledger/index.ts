import { SQL } from "bun";
import { ConwayUTxO } from "@harmoniclabs/cardano-ledger-ts";
import { Cbor, CborArray, CborObj } from "@harmoniclabs/cbor";
import { RawPoolDistr } from "../../rawNES/pool_distr";

// Skeleton classes for interacting with the NewEpochState SQLite schema

export class SQLNewEpochState {
    db: SQL;

    constructor(db: SQL) {
        this.db = db;
    }

    async init(): Promise<void> {
        return this.initNewEpochState()
            .then(this.initBlocksMade)
            .then(this.initEpochState)
            .then(this.initPulsingRewUpdate)
            .then(this.initPoolDistr)
            .then(this.initAvvmAddresses);
    }

    private async initNewEpochState(): Promise<void> {
        return this.db`
            CREATE TABLE IF NOT EXISTS new_epoch_state (
                epoch INTEGER PRIMARY KEY,
                last_epoch_modified INTEGER,
                slots_per_kes_period INTEGER DEFAULT 1,
                max_kes_evolutions INTEGER DEFAULT 1,
                epoch_state_id INTEGER,
                pulsing_rew_update_id INTEGER,
                pool_distr_id INTEGER,
                stashed_avvm_addresses_id INTEGER,
                FOREIGN KEY (epoch_state_id) REFERENCES epoch_state(id),
                FOREIGN KEY (pulsing_rew_update_id) REFERENCES pulsing_rew_update(id),
                FOREIGN KEY (pool_distr_id) REFERENCES pool_distr(id),
                FOREIGN KEY (stashed_avvm_addresses_id) REFERENCES stashed_avvm_addresses(id)
            );
        `;
    }

    private async initBlocksMade(): Promise<void> {
        return this.db`
            CREATE TABLE IF NOT EXISTS blocks_made (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER,
                is_prev BOOLEAN,
                pool_hash BLOB,
                blocks INTEGER,
                FOREIGN KEY (epoch) REFERENCES new_epoch_state(epoch)
            );
        `;
    }

    private async initEpochState(): Promise<void> {
        await this.db`                
            CREATE TABLE IF NOT EXISTS epoch_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chain_account_state_id INTEGER,
                ledger_state_id INTEGER,
                snapshots_id INTEGER,
                non_myopic_id INTEGER,
                FOREIGN KEY (chain_account_state_id) REFERENCES chain_account_state(id),
                FOREIGN KEY (ledger_state_id) REFERENCES ledger_state(id),
                FOREIGN KEY (snapshots_id) REFERENCES snapshots(id),
                FOREIGN KEY (non_myopic_id) REFERENCES non_myopic(id)
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS chain_account_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                treasury INTEGER,
                reserves INTEGER
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS ledger_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                utxo BLOB,
                cert_state BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_id INTEGER,
                delegations_id INTEGER,
                pparams_id INTEGER,
                FOREIGN KEY (stake_id) REFERENCES stake(id),
                FOREIGN KEY (delegations_id) REFERENCES delegations(id),
                FOREIGN KEY (pparams_id) REFERENCES pparams(id)
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS stake (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_credential BLOB,
                amount INTEGER
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS delegations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_credential BLOB,
                pool_key_hash BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS pparams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stake_credential BLOB,
                params BLOB
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS non_myopic (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                likelihoods_id INTEGER,
                reward_pot INTEGER,
                FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
            );
        `;

        await this.db`
            CREATE TABLE IF NOT EXISTS likelihoods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_key_hash BLOB,
                likelihood_numerator INTEGER,
                likelihood_denominator INTEGER
            );
        `;
    }

    private async initPulsingRewUpdate(): Promise<void> {
        await this.db`            
            CREATE TABLE IF NOT EXISTS pulsing_rew_update (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    private async initPoolDistr(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS pool_distr (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    private async initAvvmAddresses(): Promise<void> {
        await this.db`
            CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data BLOB
            );
        `;
    }

    // Methods to get and set UTxO
    async getUTxO(): Promise<ConwayUTxO[]> {
        const result = await this.db`
            SELECT utxo FROM ledger_state
            WHERE id = (
                SELECT ledger_state_id FROM epoch_state
                WHERE id = (
                    SELECT epoch_state_id FROM new_epoch_state WHERE epoch = 0
                )
            )
        `;
        if (result.length === 0 || !result[0].utxo) return [];
        const bytes = result[0].utxo as Uint8Array;
        const cbor = Cbor.parse(bytes);
        if (!(cbor instanceof CborArray)) return [];
        return cbor.array.map((obj: CborObj) => ConwayUTxO.fromCborObj(obj));
    }

    async setUTxO(utxo: ConwayUTxO[]): Promise<void> {
        const cborArray = new CborArray(utxo.map(u => u.toCborObj()));
        const bytes = Cbor.encode(cborArray);
        await this.db`
            UPDATE ledger_state SET utxo = ${bytes}
            WHERE id = (
                SELECT ledger_state_id FROM epoch_state
                WHERE id = (
                    SELECT epoch_state_id FROM new_epoch_state WHERE epoch = 0
                )
            )
        `;
    }

    // Methods to get and set treasury
    async getTreasury(): Promise<bigint> {
        const result = await this.db`
            SELECT treasury FROM chain_account_state
            WHERE id = (
                SELECT chain_account_state_id FROM epoch_state
                WHERE id = (
                    SELECT epoch_state_id FROM new_epoch_state WHERE epoch = 0
                )
            )
        `;
        return result.length > 0 ? BigInt(result[0].treasury as number) : 0n;
    }

    async setTreasury(treasury: bigint): Promise<void> {
        await this.db`
            UPDATE chain_account_state SET treasury = ${treasury}
            WHERE id = (
                SELECT chain_account_state_id FROM epoch_state
                WHERE id = (
                    SELECT epoch_state_id FROM new_epoch_state WHERE epoch = 0
                )
            )
        `;
    }

    // Method to get lastEpochModified
    async getLastEpochModified(): Promise<bigint> {
        const result = await this.db`SELECT last_epoch_modified FROM new_epoch_state WHERE epoch = 0`;
        return result.length > 0 ? BigInt(result[0].last_epoch_modified as number) : 0n;
    }

    async setLastEpochModified(epoch: bigint): Promise<void> {
        await this.db`UPDATE new_epoch_state SET last_epoch_modified = ${epoch} WHERE epoch = 0`;
    }

    // Method to get pool distribution
    async getPoolDistr(): Promise<RawPoolDistr> {
        const result = await this.db`
            SELECT data FROM pool_distr
            WHERE id = (
                SELECT pool_distr_id FROM new_epoch_state WHERE epoch = 0
            )
        `;
        if (result.length === 0 || !result[0].data) return new RawPoolDistr([], 0n);
        const bytes = result[0].data as Uint8Array;
        const cbor = Cbor.parse(bytes);
        return RawPoolDistr.fromCborObj(cbor);
    }
}
