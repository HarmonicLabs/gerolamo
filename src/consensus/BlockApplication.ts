import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyByronTxPayload, applyTransaction, type SqlClient } from "../db";
import { logger } from "../utils/logger";
import { sql } from "../sql";
import {
    getByronTxPayloads,
    getShelleyTxBodies,
    isByronBlock,
} from "../utils/eraAccessors";

import { toHex } from "@harmoniclabs/uint8array-utils";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules.
 *
 * Optional `client` = Bun SQL handle or open transaction (batch hydrate).
 * Default = shared module `sql`. Do not nest sql.begin() inside apply*.
 * The block row itself is written by the orchestrator (insertBlockVolatile)
 * in the same transaction; nothing here touches `blocks`.
 * Byron: metadata + best-effort txPayload apply (preprod often empty payloads).
 */
export async function applyBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
    client?: SqlClient,
    blockHeight: number | null = null,
): Promise<void> {
    if (isByronBlock(block as any)) {
        const payloads = getByronTxPayloads(block as any);
        if (payloads.length === 0) {
            return;
        }
        for (const entry of payloads) {
            await applyByronTxPayload(entry, blockHash, client);
        }
        return;
    }

    // Shelley+ txs (writes go through optional client for batch hydrate)
    // Forward Mini-BF indexes (tx_index / address_tx / block_tx) via indexCtx.
    const txBodies = getShelleyTxBodies(block);
    const slotNum = Number(slot);
    let txIndex = 0;
    for (const txBody of txBodies) {
        await applyTransaction(txBody, blockHash, client, {
            slot: slotNum,
            txIndex: txIndex++,
            blockHeight,
        });
    }
}
