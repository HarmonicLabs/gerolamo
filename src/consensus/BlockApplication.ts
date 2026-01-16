import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { DB } from "../db/DB";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export async function applyBlock(
    db: DB,
    block: MultiEraBlock,
    _slot: bigint,
    blockHash: Uint8Array,
): Promise<void> {
    const actualBlock = block.block;

    // Apply all transactions concurrently
    await Promise.all(
        actualBlock.transactionBodies.map((txBody: any) =>
            db.applyTransaction(txBody, blockHash)
        ),
    );
}
