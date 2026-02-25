import { sql } from "bun";

export async function populateChainAccountState() {
    await sql`INSERT OR REPLACE INTO chain_account_state (id, treasury, reserves) VALUES (${1}, ${0}, ${0})`;
}
