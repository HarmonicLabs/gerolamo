import { Database } from "bun:sqlite";

export async function populateChainAccountState(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO chain_account_state (id, treasury, reserves) VALUES (?, ?, ?)`,
        [1, 0, 0]
    );
}
