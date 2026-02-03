// THis is used now by the CLI for initializing a new epoch state in the ledger DB it still uses Gerolamos DB.ts
// Tables are created during DB.ensureInitialized() which loads the schema.
// This file can be removed once confirmed no other dependencies exist.

import path from "path";
import { ensureInitialized } from "../db";
import { getBasePath } from "../utils/paths.js";

export async function initNewEpochState() {
    const network = (process.env.NETWORK ?? "preprod") as string;
    const dbPath = path.join(
        getBasePath(),
        "..",
        "store",
        "db",
        network,
        "Gerolamo.db",
    );
    await ensureInitialized();

    // Ensure initial stable state row exists (legacy behavior)
    db.db.run(`
        INSERT OR IGNORE INTO stable_state (id, immutable_tip_hash, immutable_tip_slot, total_blocks)
        VALUES (1, NULL, 0, 0);
    `);
}
