import { Database } from "bun:sqlite";

export async function populateNewEpochState(db: Database, currentEpoch: number) {
    db.run(
        `INSERT OR REPLACE INTO new_epoch_state (id, last_epoch_modified, epoch_state_id, pulsing_rew_update_id, pool_distr_id, stashed_avvm_addresses_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [1, currentEpoch, 1, 1, 1, 1]
    );
}
