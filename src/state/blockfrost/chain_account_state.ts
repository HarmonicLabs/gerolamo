import { sql } from "bun";

export async function populateChainAccountState() {
    await sql`
        INSERT OR REPLACE INTO chain_account_state ${
        sql({
            id: 1,
            treasury: 0,
            reserves: 0,
        })
    }
    `;
}
