import { Database } from "bun:sqlite";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import {
    fetchProtocolParameters,
    populateProtocolParams,
} from "./protocol_params";
import {
    fetchStakeDistribution,
    populateStakeDistribution,
    populateDelegations,
} from "./stake_distribution";
import { fetchPools, populatePoolDistribution } from "./pool_distribution";
import { populateBlocksMade } from "./blocks_made";
import { populateChainAccountState } from "./chain_account_state";
import { populateRewards } from "./rewards";
import { populateNonMyopic } from "./non_myopic";
import { populateLedgerState } from "./ledger_state";
import { populateSnapshots } from "./snapshots";
import { populateEpochState as populateEpochStateNES } from "./epoch_state";
import { populatePulsingRewUpdate } from "./pulsing_rew_update";
import { populateStashedAvvmAddresses } from "./stashed_avvm_addresses";
import { populateNewEpochState } from "./new_epoch_state";
import { GerolamoConfig } from "../../network/peerManagerWorkers/peerManagerWorker";

export async function populateEpochState(
    db: Database,
    epoch: number,
    options: {
        projectId?: string;
        customBackend?: string;
        config?: GerolamoConfig;
    } = {}
) {
    const apiConfig: any = { rateLimiter: false };

    if (options.projectId) {
        apiConfig.projectId = options.projectId;
    } else {
        apiConfig.customBackend = options.customBackend || options.config?.blockfrostUrl;
        if (!apiConfig.customBackend) {
            throw new Error("Blockfrost customBackend or config.blockfrostUrl required (no projectId provided)");
        }
    }

    const api = new BlockFrostAPI(apiConfig);

    console.log(`Populating epoch ${epoch} state...`);

    // Protocol params for epoch
    const protocolParams = await fetchProtocolParameters(api, epoch);
    await populateProtocolParams(db, protocolParams);

    // Stake distribution & delegations for epoch
    const stakeDistribution = await fetchStakeDistribution(api, epoch);
    await populateStakeDistribution(db, stakeDistribution);
    await populateDelegations(db, stakeDistribution);

    // Pools
    const pools = await fetchPools(api);
    await populatePoolDistribution(db, pools, stakeDistribution.reduce((sum, s) => sum + BigInt(s.amount || 0), 0n));

    // Blocks made
    await populateBlocksMade(db, api, epoch);

    // Rewards (approximate)
    await populateRewards(db, stakeDistribution, protocolParams);

    // NES components
    await populateEpochStateNES(db);
    await populatePulsingRewUpdate(db);
    await populateStashedAvvmAddresses(db);
    await populateNewEpochState(db, epoch);

    // Ledger & snapshots
    await populateChainAccountState(db);
    await populateNonMyopic(db);
    await populateLedgerState(db);
    await populateSnapshots(db);

    console.log(`Epoch ${epoch} state populated.`);
}