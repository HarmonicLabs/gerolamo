import { SQL } from "bun";
import { uint8ArrayEq } from "@harmoniclabs/uint8array-utils";

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
                chain_account_state TEXT, -- JSON
                ledger_state TEXT, -- JSON
                snapshots TEXT, -- JSON
                non_myopic TEXT -- JSON
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

    async closeDB(): Promise<void> {
        await this.db.close();
    }

    // Getters and setters for NewEpochState fields
    async getLastEpochModified(epoch: bigint): Promise<bigint> {
        const result = await this.db`
            SELECT last_epoch_modified FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        return result.length > 0 ? result[0].last_epoch_modified : 0n;
    }

    async setLastEpochModified(epoch: bigint, value: bigint): Promise<void> {
        await this.db`
            UPDATE new_epoch_state SET last_epoch_modified = ${value} WHERE epoch = ${epoch}
        `;
    }

    async getPrevBlocks(epoch: bigint): Promise<any> { // IBlocksMade
        const results = await this.db`
            SELECT pool_hash, blocks FROM blocks_made WHERE epoch = ${epoch} AND is_prev = true
        `;
        // Convert to IBlocksMade format, assuming it's a map of pool to blocks
        const map = new Map();
        for (const row of results) {
            map.set(row.pool_hash, row.blocks);
        }
        return { blocks: map };
    }

    async setPrevBlocks(epoch: bigint, value: any): Promise<void> { // IBlocksMade
        // First, delete existing
        await this.db`DELETE FROM blocks_made WHERE epoch = ${epoch} AND is_prev = true`;
        // Insert new
        for (const [pool, blocks] of value.blocks.entries()) {
            await this.db`
                INSERT INTO blocks_made (epoch, is_prev, pool_hash, blocks) VALUES (${epoch}, true, ${pool}, ${blocks})
            `;
        }
    }

    async getCurrBlocks(epoch: bigint): Promise<any> {
        const results = await this.db`
            SELECT pool_hash, blocks FROM blocks_made WHERE epoch = ${epoch} AND is_prev = false
        `;
        const map = new Map();
        for (const row of results) {
            map.set(row.pool_hash, row.blocks);
        }
        return { blocks: map };
    }

    async setCurrBlocks(epoch: bigint, value: any): Promise<void> {
        await this.db`DELETE FROM blocks_made WHERE epoch = ${epoch} AND is_prev = false`;
        for (const [pool, blocks] of value.blocks.entries()) {
            await this.db`
                INSERT INTO blocks_made (epoch, is_prev, pool_hash, blocks) VALUES (${epoch}, false, ${pool}, ${blocks})
            `;
        }
    }

    async getEpochState(epoch: bigint): Promise<any> { // IEpochState
        const result = await this.db`
            SELECT epoch_state_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (result.length === 0) return null;
        const id = result[0].epoch_state_id;
        const data = await this.db`
            SELECT chain_account_state, ledger_state, snapshots, non_myopic FROM epoch_state WHERE id = ${id}
        `;
        if (data.length === 0) return null;
        const row = data[0];
        return {
            chainAccountState: JSON.parse(row.chain_account_state),
            ledgerState: JSON.parse(row.ledger_state),
            snapshots: JSON.parse(row.snapshots),
            nonMyopic: JSON.parse(row.non_myopic),
        };
    }

    async setEpochState(epoch: bigint, value: any): Promise<void> {
        let id;
        const existing = await this.db`
            SELECT epoch_state_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (existing.length > 0) {
            id = existing[0].epoch_state_id;
            await this.db`
                UPDATE epoch_state SET
                    chain_account_state = ${JSON.stringify(value.chainAccountState)},
                    ledger_state = ${JSON.stringify(value.ledgerState)},
                    snapshots = ${JSON.stringify(value.snapshots)},
                    non_myopic = ${JSON.stringify(value.nonMyopic)}
                WHERE id = ${id}
            `;
        } else {
            const insert = await this.db`
                INSERT INTO epoch_state (chain_account_state, ledger_state, snapshots, non_myopic)
                VALUES (
                    ${JSON.stringify(value.chainAccountState)},
                    ${JSON.stringify(value.ledgerState)},
                    ${JSON.stringify(value.snapshots)},
                    ${JSON.stringify(value.nonMyopic)}
                )
            `;
            id = insert.lastInsertRowid;
            await this.db`
                UPDATE new_epoch_state SET epoch_state_id = ${id} WHERE epoch = ${epoch}
            `;
        }
    }

    async getPulsingRewUpdate(epoch: bigint): Promise<any> {
        const result = await this.db`
            SELECT pulsing_rew_update_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (result.length === 0) return null;
        const id = result[0].pulsing_rew_update_id;
        const data = await this.db`
            SELECT data FROM pulsing_rew_update WHERE id = ${id}
        `;
        return data.length > 0 ? JSON.parse(data[0].data) : null;
    }

    async setPulsingRewUpdate(epoch: bigint, value: any): Promise<void> {
        let id;
        const existing = await this.db`
            SELECT pulsing_rew_update_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (existing.length > 0) {
            id = existing[0].pulsing_rew_update_id;
            await this.db`
                UPDATE pulsing_rew_update SET data = ${JSON.stringify(value)} WHERE id = ${id}
            `;
        } else {
            const insert = await this.db`
                INSERT INTO pulsing_rew_update (data) VALUES (${JSON.stringify(value)})
            `;
            id = insert.lastInsertRowid;
            await this.db`
                UPDATE new_epoch_state SET pulsing_rew_update_id = ${id} WHERE epoch = ${epoch}
            `;
        }
    }

    async getPoolDistr(epoch: bigint): Promise<any> {
        const result = await this.db`
            SELECT pool_distr_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (result.length === 0) return null;
        const id = result[0].pool_distr_id;
        const data = await this.db`
            SELECT data FROM pool_distr WHERE id = ${id}
        `;
        return data.length > 0 ? JSON.parse(data[0].data) : null;
    }

    async setPoolDistr(epoch: bigint, value: any): Promise<void> {
        let id;
        const existing = await this.db`
            SELECT pool_distr_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (existing.length > 0) {
            id = existing[0].pool_distr_id;
            await this.db`
                UPDATE pool_distr SET data = ${JSON.stringify(value)} WHERE id = ${id}
            `;
        } else {
            const insert = await this.db`
                INSERT INTO pool_distr (data) VALUES (${JSON.stringify(value)})
            `;
            id = insert.lastInsertRowid;
            await this.db`
                UPDATE new_epoch_state SET pool_distr_id = ${id} WHERE epoch = ${epoch}
            `;
        }
    }

    async getStashedAvvmAddresses(epoch: bigint): Promise<any> {
        const result = await this.db`
            SELECT stashed_avvm_addresses_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (result.length === 0) return null;
        const id = result[0].stashed_avvm_addresses_id;
        const data = await this.db`
            SELECT data FROM stashed_avvm_addresses WHERE id = ${id}
        `;
        return data.length > 0 ? JSON.parse(data[0].data) : null;
    }

    async setStashedAvvmAddresses(epoch: bigint, value: any): Promise<void> {
        let id;
        const existing = await this.db`
            SELECT stashed_avvm_addresses_id FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        if (existing.length > 0) {
            id = existing[0].stashed_avvm_addresses_id;
            await this.db`
                UPDATE stashed_avvm_addresses SET data = ${JSON.stringify(value)} WHERE id = ${id}
            `;
        } else {
            const insert = await this.db`
                INSERT INTO stashed_avvm_addresses (data) VALUES (${JSON.stringify(value)})
            `;
            id = insert.lastInsertRowid;
            await this.db`
                UPDATE new_epoch_state SET stashed_avvm_addresses_id = ${id} WHERE epoch = ${epoch}
            `;
        }
    }

    async getSlotsPerKESPeriod(epoch: bigint): Promise<bigint> {
        const result = await this.db`
            SELECT slots_per_kes_period FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        return result.length > 0 ? result[0].slots_per_kes_period : 1n;
    }

    async setSlotsPerKESPeriod(epoch: bigint, value: bigint): Promise<void> {
        await this.db`
            UPDATE new_epoch_state SET slots_per_kes_period = ${value} WHERE epoch = ${epoch}
        `;
    }

    async getMaxKESEvolutions(epoch: bigint): Promise<bigint> {
        const result = await this.db`
            SELECT max_kes_evolutions FROM new_epoch_state WHERE epoch = ${epoch}
        `;
        return result.length > 0 ? result[0].max_kes_evolutions : 1n;
    }

    async setMaxKESEvolutions(epoch: bigint, value: bigint): Promise<void> {
        await this.db`
            UPDATE new_epoch_state SET max_kes_evolutions = ${value} WHERE epoch = ${epoch}
        `;
    }

    // Method to get individual pool stake from poolDistr
    async getIndividualTotalPoolStake(epoch: bigint, pkh: Uint8Array): Promise<bigint> {
        const poolDistr = await this.getPoolDistr(epoch);
        if (!poolDistr) return 0n;
        const entry = poolDistr.unPoolDistr.find(([p, ips]: any) => uint8ArrayEq(p.toCborBytes(), pkh));
        return entry ? entry[1].individualTotalPoolStake : 0n;
    }

    // Method to get total active stake from poolDistr
    async getTotalActiveStake(epoch: bigint): Promise<bigint> {
        const poolDistr = await this.getPoolDistr(epoch);
        return poolDistr ? poolDistr.totalActiveStake : 0n;
    }
}
