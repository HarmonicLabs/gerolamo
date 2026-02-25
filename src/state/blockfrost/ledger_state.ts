import { sql } from "bun";

export async function populateLedgerState() {
    await sql`INSERT OR REPLACE INTO ledger_state (id, utxo_deposited, utxo_fees, utxo_donation, cert_state_id) VALUES (${1}, ${0}, ${0}, ${0}, ${null})`;
}
