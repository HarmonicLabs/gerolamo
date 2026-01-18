import { Database } from "bun:sqlite";

export async function populateEpochState(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO epoch_state (id, chain_account_state_id, ledger_state_id, snapshots_id, non_myopic_id, pparams_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [1, 1, 1, 1, 1, 1]
    );
}
