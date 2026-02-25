import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyTransaction } from "../db";
import { logger } from "../utils/logger";
import { sql } from "bun";

import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Stores block information in the database
 */
async function storeBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    await sql`INSERT OR IGNORE INTO blocks (hash, slot, prev_hash, is_valid) VALUES (${
        blockHash
    }, ${Number(slot)}, NULL, ${true})`;
}

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export async function applyBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    // Store block information in the database
    await storeBlock(block, slot, blockHash);

    // Apply all transactions if any exist
    if (block?.transactionBodies?.length) {
        for (const txBody of block.transactionBodies) {
            logger.info(`Applying transaction: ${toHex(txBody.hash.toBuffer())}`);
            await applyTransaction(txBody, blockHash);
        }
    }
}
