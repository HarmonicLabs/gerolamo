// Blockfrost-related state management functions
// This module provides main import functions for ledger state from Blockfrost API
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
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
import { populateEpochStateTable } from "./epoch_state";
import { populatePulsingRewUpdate } from "./pulsing_rew_update";
import { populateStashedAvvmAddresses } from "./stashed_avvm_addresses";
import { populateNewEpochState } from "./new_epoch_state";
import { fetchBlockData } from "./block_data";
import { GerolamoConfig } from "../../network/peerManager";

// Main import function for ledger state from Blockfrost
export async function importFromBlockfrost(
    blockHash: string,
    options?: {
        projectId?: string;
        customBackend?: string;
        fromSlot?: number;
        count?: number;
        config?: GerolamoConfig;
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
            options?.config?.blockfrostUrl;
        if (!apiConfig.customBackend) {
            throw new Error(
                "Blockfrost customBackend or config.blockfrostUrl required (no projectId provided)",
            );
        }
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
    await populateRewards(
        stakeDistribution,
        defaultShelleyProtocolParameters,
    );

    // 8. Non-myopic data
    await populateNonMyopic();

    // 9. UTxO set
    await populateUTxOs(api, stakeDistribution);

    // 10. Ledger state
    await populateLedgerState();

    // 11. Snapshots
    await populateSnapshots();

    // 12. Epoch state
    await populateEpochStateTable();

    // 13. Pulsing reward update
    await populatePulsingRewUpdate();

    // 14. Stashed AVVM addresses
    await populateStashedAvvmAddresses();

    // 15. New epoch state
    await populateNewEpochState(currentEpoch);

    console.log(`\n=== COMPLETE NES IMPORTED FOR EPOCH ${currentEpoch} ===`);
    console.log(`📦 Protocol parameters: ✓`);
    console.log(`🏦 Chain accounts: ✓ (defaults)`);
    console.log(
        `🏊 Pool distribution: ✓ (${pools.length} pools, ${totalActiveStake} total stake)`,
    );
    console.log(
        `🏗️  Blocks made: ✓ (${blocksMadePoolCount} pools produced blocks)`,
    );
    console.log(`💰 Stake distribution: ✓`);
    console.log(`🔗 Delegations: ✓`);
    console.log(`💸 Rewards: ✓`);
    console.log(`👁️  Non-myopic: ✓ (defaults)`);
    console.log(`💳 UTxO set: ✓`);
    console.log(`📜 Ledger state: ✓ (defaults)`);
    console.log(`📸 Snapshots: ✓ (defaults)`);
    console.log(`🌅 Epoch state: ✓`);
    console.log(`⚡ Pulsing reward update: ✓ (defaults)`);
    console.log(`🏷️  Stashed AVVM addresses: ✓ (defaults)`);
    console.log(`🆕 New epoch state: ✓`);
    console.log(`\n🎉 Blockfrost NES import completed successfully!\n`);
}

// Blockfrost-related functionality (all populate functions and import)
export {
    fetchProtocolParameters,
    populateProtocolParams,
} from "./protocol_params";
export {
    fetchStakeDistribution,
    populateDelegations,
    populateStakeDistribution,
} from "./stake_distribution";
export {
    fetchPools,
    populatePoolDistribution,
} from "./pool_distribution";
export { populateBlocksMade } from "./blocks_made";
export { populateChainAccountState } from "./chain_account_state";
export { populateRewards } from "./rewards";
export { populateUTxOs } from "./utxos";
export { populateNonMyopic } from "./non_myopic";
export { populateLedgerState } from "./ledger_state";
export { populateSnapshots } from "./snapshots";
export { populateEpochState, populateEpochStateTable } from "./epoch_state";
export { populatePulsingRewUpdate } from "./pulsing_rew_update";
export { populateStashedAvvmAddresses } from "./stashed_avvm_addresses";
export { populateNewEpochState } from "./new_epoch_state";
export { fetchAddresses, fetchBlockData } from "./block_data";
