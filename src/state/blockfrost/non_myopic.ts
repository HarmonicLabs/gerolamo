import { sql } from "bun";

export async function populateNonMyopic() {
    await sql`
        INSERT OR REPLACE INTO non_myopic ${
        sql({
            id: 1,
            reward_pot: 0,
            likelihoods_id: null,
        })
    }
    `;
}
