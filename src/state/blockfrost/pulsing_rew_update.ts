import { Database } from "bun:sqlite";

export async function populatePulsingRewUpdate(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO pulsing_rew_update (id, data) VALUES (?, ?)`,
        [1, JSON.stringify({})],
    );
}
