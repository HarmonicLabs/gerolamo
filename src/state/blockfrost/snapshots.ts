import { sql } from "bun";

export async function populateSnapshots() {
    await sql`INSERT OR REPLACE INTO snapshots (id, stake_id, rewards_id, delegations_id) VALUES (${1}, ${null}, ${null}, ${null})`;
}
