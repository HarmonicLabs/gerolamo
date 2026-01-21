import { sql } from "bun";

export async function populateSnapshots() {
    await sql`
        INSERT OR REPLACE INTO snapshots ${
        sql({
            id: 1,
            stake_id: null,
            rewards_id: null,
            delegations_id: null,
        })
    }
    `;
}
