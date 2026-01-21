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
    await populateUTxOs(apiConfig, stakeDistribution);

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
        await importChain(apiConfig, options.fromSlot, options.count);
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
        }) UTxOs`,
    );
    console.log(`📊 Ledger state: ✓`);
    console.log(`📸 Snapshots: ✓`);
    console.log(`🎯 Complete New Epoch State imported from Blockfrost!`);
}

// Import chain blocks from Blockfrost
export async function importChain(
    apiConfig: any,
    fromSlot: number,
    count: number,
) {
    // Use raw fetch calls with the custom backend since BlockFrostAPI doesn't work with it
    const baseUrl = apiConfig.customBackend || "https://blockfrost-preprod.onchainapps.io";

    // Generate array of slots to fetch (from newest to oldest)
    const slots = Array.from({ length: count }, (_, i) => fromSlot - i).filter(
        (slot) => slot >= 0,
    );

    console.log(
        `Fetching ${slots.length} blocks starting from slot ${fromSlot} using ${baseUrl}...`,
    );

    // Fetch all blocks using raw fetch calls
    const blockDataPromises = slots.map(async (slot) => {
        try {
            const response = await fetch(`${baseUrl}/blocks/slot/${slot}`);
            if (!response.ok) {
                // Skip slots that don't have blocks (normal - not every slot has a block)
                return null;
            }
            const blockData = await response.json();
            console.log(`Fetched block at slot ${slot}: ${blockData.hash}`);
            return blockData;
        } catch (error) {
            // Skip slots that don't have blocks
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

    // First ensure current_tip table exists
    await sql`
        CREATE TABLE IF NOT EXISTS current_tip (
            id INTEGER PRIMARY KEY DEFAULT 1,
            hash BLOB,
            slot INTEGER,
            block_no INTEGER DEFAULT 0
        );
    `;

    // Insert initial current_tip if it doesn't exist
    await sql`
        INSERT OR IGNORE INTO current_tip (id, hash, slot, block_no)
        VALUES (1, NULL, 0, 0);
    `;

    // Insert all blocks into database
    // Store the block data as JSON since we don't have full CBOR
    for (const blockData of validBlocks) {
        await sql`
            INSERT OR IGNORE INTO blocks (hash, slot, header_data, block_data)
            VALUES (${Buffer.from(blockData.hash, "hex")}, ${blockData.slot || 0}, ${Buffer.from(JSON.stringify(blockData))}, NULL)
        `;
    }

    // Update current tip to the most recent block (highest slot)
    const latestBlock = validBlocks.reduce((latest, current) =>
        (current.slot || 0) > (latest.slot || 0) ? current : latest
    );

    await sql`
        UPDATE current_tip SET hash = ${
        Buffer.from(latestBlock.hash, "hex")
    }, slot = ${latestBlock.slot || 0}, block_no = ${validBlocks.length} WHERE id = 1;
    `;

    console.log(
        `Imported ${validBlocks.length} blocks, updated tip to slot ${latestBlock.slot}`,
    );
}
