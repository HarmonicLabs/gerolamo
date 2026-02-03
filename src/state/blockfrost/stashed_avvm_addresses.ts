import { Database } from "bun:sqlite";

export async function populateStashedAvvmAddresses(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO stashed_avvm_addresses (id, addresses) VALUES (?, ?)`,
        [1, JSON.stringify([])],
    );
}
