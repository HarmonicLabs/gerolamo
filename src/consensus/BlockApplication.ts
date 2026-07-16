import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyByronTxPayload, applyTransaction } from "../db";
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
 * Note: applyTransaction uses the shared `sql` client (not the outer `tx`).
 * Bun SQLite cannot nest sql.begin(), so we do not wrap applyTransaction in
 * another begin. Block metadata insert is best-effort before txs; full CBOR
 * is written separately via insertBlockBatchVolatile after applyBlock returns.
 * Byron: metadata + best-effort txPayload apply (preprod often empty payloads).
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

    if (isByronBlock(block as any)) {
        const payloads = getByronTxPayloads(block as any);
        if (payloads.length === 0) {
            logger.debug(
                `Byron block slot=${slot} — empty txPayload (metadata only)`,
            );
            return;
        }
        for (const entry of payloads) {
            await applyByronTxPayload(entry, blockHash);
        }
        return;
    }

    // Shelley+ txs only (row-by-row SQL; no nested begin)
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
        await applyTransaction(txBody, blockHash);
    }
}
