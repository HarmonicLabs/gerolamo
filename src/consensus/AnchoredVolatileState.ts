import { Hash32, PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { logger } from "../utils/logger";

// Point interface for anchoring
export interface Point {
    slot: bigint;
    hash: Hash32;
}

// Volatile state interface representing the current state
export interface VolatileState {
    utxoCount: number;
    totalFees: bigint;
    recentBlocks: number;
}

// Store update interface
export interface StoreUpdate {
    point: Point;
    issuer: PoolKeyHash;
    fees: bigint;
}

// Query the volatile state from the database for a given anchor
export async function getVolatileState(
    anchor: [Point, PoolKeyHash],
): Promise<VolatileState> {
    const [point] = anchor;

    // Query UTxO count
    const utxoRows = await sql`SELECT COUNT(*) as count FROM utxo`.values() as [
        number,
    ][];
    const utxoCount = utxoRows[0][0];

    // Query total fees from chain account state
    const feesRows =
        await sql`SELECT treasury FROM chain_account_state WHERE id = 1`
            .values() as [string][];
    const totalFees = feesRows.length > 0 ? BigInt(feesRows[0][0]) : 0n;

    // Query recent blocks count (simplified - could be based on slot range)
    const blockRows =
        await sql`SELECT COUNT(*) as count FROM blocks WHERE slot >= ${
            point.slot - 1000n
        }`.values() as [number][];
    const recentBlocks = blockRows[0][0];

    logger.debug("Queried volatile state", {
        anchorSlot: point.slot.toString(),
        anchorHash: toHex(point.hash.toBuffer()),
        utxoCount,
        totalFees: totalFees.toString(),
        recentBlocks,
    });

    return {
        utxoCount,
        totalFees,
        recentBlocks,
    };
}

// Update the volatile state in the database
export async function updateVolatileState(
    anchor: [Point, PoolKeyHash],
    updates: Partial<VolatileState>,
): Promise<void> {
    logger.info("Updating volatile state", {
        anchorSlot: anchor[0].slot.toString(),
        updates,
    });

    // Update fees/treasury
    if (updates.totalFees !== undefined) {
        await sql`UPDATE chain_account_state SET treasury = ${updates.totalFees} WHERE id = 1`;
    }

    // Update reserves if specified (though typically this is handled at epoch boundaries)
    if (updates.reserves !== undefined) {
        await sql`UPDATE chain_account_state SET reserves = ${updates.reserves} WHERE id = 1`;
    }

    // Note: utxoCount and recentBlocks are derived metrics computed from database queries
    // and don't need explicit updates. They are automatically updated when underlying
    // tables (utxo, blocks) are modified through block application functions.

    // For rollback scenarios, the following operations would be needed:
    // 1. Remove blocks from volatile storage (blocks table)
    // 2. Undo UTxO changes (restore spent outputs, remove created outputs)
    // 3. Undo certificate applications (reverse stake/delegation changes)
    // 4. Undo withdrawals (restore rewards)
    // 5. Undo fee collection (subtract from treasury)

    // These rollback operations would be implemented as separate functions
    // called during chain reorganization.
}

// Extend VolatileState to include reserves for completeness
export interface VolatileState {
    utxoCount: number;
    totalFees: bigint;
    recentBlocks: number;
    reserves?: bigint; // Optional, typically updated at epoch boundaries
}

// Rollback a block from volatile state (for chain reorganization)
export async function rollbackBlock(blockHash: Hash32): Promise<void> {
    logger.warn("Rolling back volatile block", {
        hash: toHex(blockHash.toBuffer()),
    });

    // Find the block to rollback
    const blockRows =
        await sql`SELECT * FROM blocks WHERE hash = ${blockHash.toBuffer()}`
            .values();
    if (blockRows.length === 0) {
        throw new Error(
            `Block ${
                toHex(blockHash.toBuffer())
            } not found in volatile storage`,
        );
    }

    // This would need to:
    // 1. Parse the block's transactions
    // 2. Reverse each transaction's effects:
    //    - Remove created UTxOs
    //    - Restore spent UTxOs
    //    - Reverse certificate applications
    //    - Restore withdrawn rewards
    //    - Subtract collected fees
    // 3. Remove the block from storage

    // Implementation would depend on storing enough information to reverse operations
    // For now, this is a placeholder
    await sql`DELETE FROM blocks WHERE hash = ${blockHash.toBuffer()}`;
}

// Add a block to volatile storage
export async function addBlockToVolatile(
    blockHash: Hash32,
    blockData: any,
    slot: bigint,
): Promise<void> {
    // Store block in volatile storage
    await sql`
        INSERT OR REPLACE INTO blocks (hash, data, slot)
        VALUES (${blockHash.toBuffer()}, ${JSON.stringify(blockData)}, ${slot})
    `;

    logger.debug("Added block to volatile", {
        slot: slot.toString(),
        hash: toHex(blockHash.toBuffer()),
    });
}

// Create a store update from an anchor
export async function intoStoreUpdate(
    anchor: [Point, PoolKeyHash],
): Promise<StoreUpdate> {
    const [point, issuer] = anchor;
    const state = await getVolatileState(anchor);
    return {
        point,
        issuer,
        fees: state.totalFees,
    };
}

// Helper function to create an anchor
export function createAnchor(
    point: Point,
    issuer: PoolKeyHash,
): [Point, PoolKeyHash] {
    return [point, issuer];
}
