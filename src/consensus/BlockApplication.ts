import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyTransaction } from "../db";
import { logger } from "../utils/logger";
import { sql } from "../sql";

import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules.
 *
 * Note: applyTransaction uses the shared `sql` client (not the outer `tx`).
 * Bun SQLite cannot nest sql.begin(), so we do not wrap applyTransaction in
 * another begin. Block metadata insert is best-effort before txs; full CBOR
 * is written separately via insertBlockBatchVolatile after applyBlock returns.
 */
export async function applyBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    // Metadata stub so getMaxSlot / tip can advance even if body UTxO apply is partial.
    await sql`INSERT OR IGNORE INTO blocks (hash, slot, prev_hash, is_valid) VALUES (${
        blockHash
    }, ${Number(slot)}, NULL, ${true})`;

    // Apply all transactions if any exist (row-by-row SQL; no nested begin)
    if (block?.transactionBodies?.length) {
        for (const txBody of block.transactionBodies) {
            const hashBuf = typeof (txBody.hash as any)?.toBuffer === "function"
                ? (txBody.hash as any).toBuffer()
                : (txBody.hash as any);
            logger.debug(
                `Applying transaction: ${
                    hashBuf instanceof Uint8Array ? toHex(hashBuf) : String(txBody.hash)
                }`,
            );
            await applyTransaction(txBody, blockHash);
        }
    }
}
