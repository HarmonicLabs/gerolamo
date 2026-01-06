import { sql } from "bun";

export async function populateLedgerState() {
    await sql`
        INSERT OR REPLACE INTO ledger_state ${
        sql({
            id: 1,
            utxo_deposited: 0,
            utxo_fees: 0,
            utxo_donation: 0,
            cert_state_id: null,
        })
    }
    `;
}
