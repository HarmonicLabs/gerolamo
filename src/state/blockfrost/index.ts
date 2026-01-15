// Blockfrost-related state management functions
// This module provides main import functions for ledger state from Blockfrost API

import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { sql } from "bun";
import { Buffer } from "node:buffer";
import {
    fetchProtocolParameters,
    populateProtocolParams,
} from "./protocol_params";
import {
    fetchStakeDistribution,
    populateDelegations,
    populateStakeDistribution,
} from "./stake_distribution";
import { fetchPools, populatePoolDistribution } from "./pool_distribution";
import { populateBlocksMade } from "./blocks_made";
import { populateChainAccountState } from "./chain_account_state";
import { populateRewards } from "./rewards";
import { populateUTxOs } from "./utxos";
import { populateNonMyopic } from "./non_myopic";
import { populateLedgerState } from "./ledger_state";
import { populateSnapshots } from "./snapshots";
import { populateEpochState } from "./epoch_state";
import { populatePulsingRewUpdate } from "./pulsing_rew_update";
import { populateStashedAvvmAddresses } from "./stashed_avvm_addresses";
import { populateNewEpochState } from "./new_epoch_state";
import { fetchBlockData } from "./block_data";

// Main import function for ledger state from Blockfrost
export async function importFromBlockfrost(
    blockHash: string,
    options?: {
        projectId?: string;
        customBackend?: string;
        importChain?: boolean;
        fromSlot?: number;
        count?: number;
    },
) {
    const apiConfig: any = {
        rateLimiter: false,
    };

    if (options?.projectId) {
        // Use project ID for official Blockfrost API
        apiConfig.projectId = options.projectId;
    } else {
        // Use custom backend (default)
        apiConfig.customBackend = options?.customBackend ||
            "https://blockfrost-preprod.onchainapps.io/";
    }

    const api = new BlockFrostAPI(apiConfig);

    // Fetch all required data from Blockfrost
    const { currentEpoch } = await fetchBlockData(api, blockHash);
    const protocolParams = await fetchProtocolParameters(api, currentEpoch);
    const stakeDistribution = await fetchStakeDistribution(api, currentEpoch);
    const pools = await fetchPools(api);

    // Calculate derived data
    const totalActiveStake = stakeDistribution.filter((stake) => stake.amount)
        .reduce((sum, stake) => sum + BigInt(stake.amount), 0n);

    // === POPULATE ALL NES COMPONENTS ===

    // 1. Protocol parameters
    await populateProtocolParams(protocolParams);

    // 2. Chain account state
    await populateChainAccountState();

    // 3. Pool distribution
    await populatePoolDistribution(pools, totalActiveStake);

    // 4. Blocks made data
    const blocksMadePoolCount = await populateBlocksMade(api, currentEpoch);

    // 5. Stake distribution
    await populateStakeDistribution(stakeDistribution);

    // 6. Delegations
    await populateDelegations(stakeDistribution);

    // 7. Rewards
    const { defaultShelleyProtocolParameters } = await import(
        "@harmoniclabs/cardano-ledger-ts"
    );
    await populateRewards(stakeDistribution, defaultShelleyProtocolParameters);

    // 8. Non-myopic data
    await populateNonMyopic();

    // 9. UTxO set
    await populateUTxOs(api, stakeDistribution);

    // 10. Ledger state
    await populateLedgerState();

    // 11. Snapshots
    await populateSnapshots();

    // 12. Epoch state
    await populateEpochState();

    // 13. Pulsing reward update
    await populatePulsingRewUpdate();

    // 14. Stashed AVVM addresses
    await populateStashedAvvmAddresses();

    // Import chain if requested
    if (options?.importChain && options.fromSlot && options.count) {
        console.log(
            `Importing chain from slot ${options.fromSlot} for ${options.count} blocks...`,
        );
        await importChain(api, options.fromSlot, options.count);
        console.log("Chain import completed.");
    }

    console.log(`\n=== COMPLETE NES IMPORTED FOR EPOCH ${currentEpoch} ===`);
    console.log(`📦 Protocol parameters: ✓`);
    console.log(`🏦 Chain accounts: ✓ (defaults)`);
    console.log(
        `🏊 Pool distribution: ✓ (${pools.length} pools, ${totalActiveStake} total stake)`,
    );
    console.log(
        `⛏️  Blocks made: ✓ (${blocksMadePoolCount} pools)`,
    );
    console.log(
        `🪙 Stake distribution: ✓ (${stakeDistribution.length} entries)`,
    );
    console.log(
        `🔗 Delegations: ✓ (${
            stakeDistribution.filter((s) => s.pool_id).length
        } entries)`,
    );
    console.log(
        `💰 Rewards: ✓ (${
            stakeDistribution.filter((s) => BigInt(s.amount || 0) > 0n).length
        } entries)`,
    );
    const { sql } = await import("bun");
    console.log(
        `💰 UTxO set: ✓ (${
            (await sql`SELECT COUNT(*) from utxo`)[0]["COUNT(*)"]
        } UTxOs`,
    );
    console.log(`📊 Ledger state: ✓`);
    console.log(`📸 Snapshots: ✓`);
    console.log(`🎯 Complete New Epoch State imported from Blockfrost!`);
}

// Import chain blocks from Blockfrost
export async function importChain(
    api: BlockFrostAPI,
    fromSlot: number,
    count: number,
) {
    // Generate array of slots to fetch (from newest to oldest)
    const slots = Array.from({ length: count }, (_, i) => fromSlot - i).filter(
        (slot) => slot >= 0,
    );

    console.log(
        `Fetching ${slots.length} blocks starting from slot ${fromSlot}...`,
    );

    // Fetch all blocks in parallel
    const blockDataPromises = slots.map(async (slot) => {
        try {
            const blockData = await api.blocks(slot);
            console.log(`Fetched block at slot ${slot}: ${blockData.hash}`);
            return blockData;
        } catch (error) {
            console.warn(`Failed to fetch block at slot ${slot}:`, error);
            return null;
        }
    });

    const blockDataArray = await Promise.all(blockDataPromises);
    const validBlocks = blockDataArray.filter((block) => block !== null);

    console.log(
        `Successfully fetched ${validBlocks.length} blocks out of ${slots.length} requested`,
    );

    if (validBlocks.length === 0) {
        console.log("No blocks to import");
        return;
    }

    // Insert all blocks into database
    await sql`
        INSERT OR IGNORE INTO blocks (hash, slot, prev_hash, header_cbor, body_cbor, issuer_hash, size)
        VALUES ${
        sql(
            validBlocks.map((blockData) => [
                Buffer.from(blockData.hash, "hex"),
                blockData.slot || 0,
                blockData.previous_block
                    ? Buffer.from(blockData.previous_block, "hex")
                    : null,
                null, // CBOR header not available from Blockfrost (BLOB field, nullable)
                null, // CBOR body not available from Blockfrost
                blockData.slot_leader
                    ? Buffer.from(blockData.slot_leader, "hex")
                    : null,
                blockData.size,
            ]),
        )
    }
    `;

    // Update current tip to the most recent block (highest slot)
    const latestBlock = validBlocks.reduce((latest, current) =>
        (current.slot || 0) > (latest.slot || 0) ? current : latest
    );

    await sql`
        UPDATE current_tip SET hash = ${
        Buffer.from(latestBlock.hash, "hex")
    }, slot = ${latestBlock.slot || 0} WHERE id = 1;
    `;

    console.log(
        `Imported ${validBlocks.length} blocks, updated tip to slot ${latestBlock.slot}`,
    );
}
