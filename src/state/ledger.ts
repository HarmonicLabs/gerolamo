// THis is used now by the CLI for initializing a new epoch state in the ledger DB it still uses Gerolamos DB.ts
// Tables are created during DB.ensureInitialized() which loads the schema.
// This file can be removed once confirmed no other dependencies exist.

import { sql } from "bun";
import { ensureInitialized } from "../db";

export async function initNewEpochState() {
    await ensureInitialized();

    // Ensure initial stable state row exists (legacy behavior)
    await sql`INSERT OR IGNORE INTO stable_state (id, immutable_tip_hash, immutable_tip_slot, total_blocks) VALUES (${1}, ${null}, ${0}, ${0})`;
}
