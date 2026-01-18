import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { DB } from "../db/DB";
import { logger } from "../utils/logger";
/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export async function applyBlock(
    db: DB,
    block: MultiEraBlock["block"],
    _slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    if (!block?.transactionBodies?.length) {
        logger.debug("applyBlock: no transactions to apply");
        return;
    }
    logger.info("applyBlock:", block);
    // Apply all transactions concurrently
    await Promise.all(
        block.transactionBodies.map((txBody) =>
            db.applyTransaction(txBody, blockHash)
        ),
    );
}
