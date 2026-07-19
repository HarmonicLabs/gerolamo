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
 * Block metadata is best-effort before txs; full CBOR is written separately
 * via insertBlockBatchVolatile after applyBlock returns.
 * Byron: metadata + best-effort txPayload apply (preprod often empty payloads).
 */
export async function applyBlock(
    block: MultiEraBlock["block"],
    slot: bigint,
    blockHash: Uint8Array,
    client?: SqlClient,
): Promise<void> {
    const db = client ?? sql;
    // Metadata stub so getMaxSlot / tip can advance even if body UTxO apply is partial.
    await db`INSERT OR IGNORE INTO blocks (hash, slot, prev_hash, is_valid) VALUES (${
        blockHash
    }, ${Number(slot)}, NULL, ${true})`;

    if (isByronBlock(block as any)) {
        const payloads = getByronTxPayloads(block as any);
        if (payloads.length === 0) {
            logger.debug(
                `Byron block slot=${slot} — empty txPayload (metadata only)`,
            );
            return;
        }
        for (const entry of payloads) {
            await applyByronTxPayload(entry, blockHash, client);
        }
        return;
    }

    // Shelley+ txs (writes go through optional client for batch hydrate)
    const txBodies = getShelleyTxBodies(block);
    for (const txBody of txBodies) {
        const hashBuf = typeof (txBody.hash as any)?.toBuffer === "function"
            ? (txBody.hash as any).toBuffer()
            : (txBody.hash as any);
        logger.debug(
            `Applying transaction: ${
                hashBuf instanceof Uint8Array ? toHex(hashBuf) : String(txBody.hash)
            }`,
        );
        await applyTransaction(txBody, blockHash, client);
    }
}
