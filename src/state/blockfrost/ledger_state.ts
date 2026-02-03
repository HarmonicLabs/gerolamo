import { Database } from "bun:sqlite";

export async function populateLedgerState(db: Database) {
    db.run(
        `INSERT OR REPLACE INTO ledger_state (id, utxo_deposited, utxo_fees, utxo_donation, cert_state_id) VALUES (?, ?, ?, ?, ?)`,
        [1, 0, 0, 0, null],
    );
}
