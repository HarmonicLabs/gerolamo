import { sql } from "bun";

export async function populateNonMyopic() {
    await sql`INSERT OR REPLACE INTO non_myopic (id, reward_pot, likelihoods_id) VALUES (${1}, ${0}, ${null})`;
}
