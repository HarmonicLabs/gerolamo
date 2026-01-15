import { Database } from "bun:sqlite";

export async function populateNonMyopic(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO non_myopic (id, reward_pot, likelihoods_id) VALUES (?, ?, ?)`,
        [1, 0, null]
    );
}
