import { Database } from "bun:sqlite";

export async function populateSnapshots(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO snapshots (id, stake_id, rewards_id, delegations_id) VALUES (?, ?, ?, ?)`,
        [1, null, null, null]
    );
}
