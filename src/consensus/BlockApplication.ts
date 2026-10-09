import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { applyByronTxPayload, applyDirectDeposits, applyInvalidTransaction, applyTransaction, deleteBlockSpends, newBlockSpends, type KnownUtxoRow, type SqlClient, flushPendingUtxoWrites } from "../db";
import { logger } from "../utils/logger";
import { migrateGovCredentials } from "./governance/govCredMigration";
import { sql } from "../sql";
import { addDonationToPot, addFeeToPot } from "../db/leaderState";
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
    opts: { epoch?: number; govActionLifetime?: number; era?: number; knownInputs?: Map<string, KnownUtxoRow> } = {},
): Promise<void> {
    if (isByronBlock(block as any)) {
        const payloads = getByronTxPayloads(block as any);
        if (payloads.length === 0) {
            return;
        }
        for (const [txIndex, entry] of payloads.entries()) {
            await applyByronTxPayload(entry, blockHash, client, { slot: Number(slot), txIndex, blockHeight });
        }
        await flushPendingUtxoWrites(client ?? sql);
        return;
    }

    // One-off, inside the first Conway block this build applies (bug 153): typed governance credentials.
    if (Number(opts.era ?? 0) >= 7) await migrateGovCredentials();

    // Shelley+ txs (writes go through optional client for batch hydrate)
    // Forward Mini-BF indexes (tx_index / address_tx / block_tx) via indexCtx.
    const txBodies = getShelleyTxBodies(block);
    const slotNum = Number(slot);
    // Phase-2 failures marked by the producer: only their collateral is consumed.
    const invalid = new Set<number>((((block as any).invalidTransactions ?? []) as Array<number | bigint>).map((i) => Number(i)));
    let txIndex = 0;
    const feeAcc = { total: 0n, donations: 0n };
    const blockSpends = newBlockSpends();
    for (const txBody of txBodies) {
        const ctx = { slot: slotNum, txIndex, blockHeight, epoch: opts.epoch, govActionLifetime: opts.govActionLifetime, era: opts.era, knownInputs: opts.knownInputs, feeAcc, blockSpends };
        if (invalid.has(txIndex)) await applyInvalidTransaction(txBody, blockHash, client, ctx);
        else if (Number(opts.era ?? 0) >= 8) await applyDijkstraTransaction(txBody, blockHash, client, ctx);
        else await applyTransaction(txBody, blockHash, client, ctx);
        txIndex++;
    }
    // Outputs first (a same-block spend needs its row), then one DELETE for every input of the block.
    await flushPendingUtxoWrites(client ?? sql);
    await deleteBlockSpends(client ?? sql, blockSpends);
    if (feeAcc.total > 0n) {
        // The block's fees, once (every transaction used to update the pot row itself).
        const db = client ?? sql;
        try {
            await addFeeToPot(db, feeAcc.total);
            if (feeAcc.donations > 0n) await addDonationToPot(db, feeAcc.donations);
        } catch {
            /* pots not initialised yet (pre-Shelley) */
        }
    }
    await flushPendingUtxoWrites(client ?? sql); // multi-row writes of this block's UTxO rows and deltas
}

/**
 * Dijkstra (bug 429): a phase-2 valid top-level transaction applies its sub-transactions first
 * (SUBLEDGERS, in order; each is a transaction of its own whose id is the hash of its body and
 * which pays no fee), then its own effects, then its direct deposits (ENTITIES credits them
 * after the certificates). A phase-2 invalid transaction only loses its collateral, its
 * sub-transactions included (handled by `applyInvalidTransaction`).
 */
export async function applyDijkstraTransaction(
    txBody: any,
    blockHash: Uint8Array,
    client: SqlClient | undefined,
    ctx: Parameters<typeof applyTransaction>[3] & object,
    deps: { applyTransaction: typeof applyTransaction; applyDirectDeposits: typeof applyDirectDeposits } = { applyTransaction, applyDirectDeposits },
): Promise<void> {
    for (const sub of (txBody.subTransactions ?? []) as any[]) {
        const subBody = sub?.body ?? sub;
        await deps.applyTransaction(subBody, blockHash, client, ctx);
        // sub-transactions have no fee, so applyTransaction does not see their donation
        const donation = BigInt(subBody?.donation ?? 0);
        if (donation > 0n && ctx.feeAcc) ctx.feeAcc.donations += donation;
        if (subBody?.directDeposits) await deps.applyDirectDeposits(subBody.directDeposits, blockHash, client);
    }
    await deps.applyTransaction(txBody, blockHash, client, ctx);
    if (txBody.directDeposits) await deps.applyDirectDeposits(txBody.directDeposits, blockHash, client);
}
