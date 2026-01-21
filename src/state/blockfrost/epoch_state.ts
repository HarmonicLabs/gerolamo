import { sql } from "bun";

export async function populateEpochState() {
    await sql`
        INSERT OR REPLACE INTO epoch_state ${
        sql({
            id: 1,
            chain_account_state_id: 1,
            ledger_state_id: 1,
            snapshots_id: 1,
            non_myopic_id: 1,
            pparams_id: 1,
        })
    }
    `;
}
