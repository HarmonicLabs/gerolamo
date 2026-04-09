import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyTransaction } from "../db";
import { logger } from "../utils/logger";
import { sql } from "../sql-compat";

import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules.
 * All DB writes are wrapped in a single transaction for atomicity and performance.
 */
export async function applyBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    await sql.begin(async (tx) => {
        // Store block metadata
        await tx`INSERT OR IGNORE INTO blocks (hash, slot, prev_hash, is_valid) VALUES (${
            blockHash
        }, ${Number(slot)}, NULL, ${true})`;

        // Apply all transactions if any exist
        if (block?.transactionBodies?.length) {
            for (const txBody of block.transactionBodies) {
                logger.debug(`Applying transaction: ${toHex(txBody.hash.toBuffer())}`);
                await applyTransaction(txBody, blockHash);
            }
        }
    });
}
