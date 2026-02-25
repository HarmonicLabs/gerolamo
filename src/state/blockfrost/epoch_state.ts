import { sql } from "bun";
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
import { populateNonMyopic } from "./non_myopic";
import { populateLedgerState } from "./ledger_state";
import { populateSnapshots } from "./snapshots";
import { populatePulsingRewUpdate } from "./pulsing_rew_update";
import { populateStashedAvvmAddresses } from "./stashed_avvm_addresses";
import { populateNewEpochState } from "./new_epoch_state";
import { GerolamoConfig } from "../../network/peerManager";

export async function populateEpochStateTable() {
    await sql`INSERT OR REPLACE INTO epoch_state (id, chain_account_state_id, ledger_state_id, snapshots_id, non_myopic_id, pparams_id) VALUES (${1}, ${1}, ${1}, ${1}, ${1}, ${1})`;
}

export async function populateEpochState(
    epoch: number,
    options: {
        projectId?: string;
        customBackend?: string;
        config?: GerolamoConfig;
    } = {},
) {
    const apiConfig: any = { rateLimiter: false };

    if (options.projectId) {
        apiConfig.projectId = options.projectId;
    } else {
        apiConfig.customBackend = options.customBackend ||
            options.config?.blockfrostUrl;
        if (!apiConfig.customBackend) {
            throw new Error(
                "Blockfrost customBackend or config.blockfrostUrl required (no projectId provided)",
            );
        }
    }

    const api = new BlockFrostAPI(apiConfig);

    console.log(`Populating epoch ${epoch} state...`);

    // Protocol params for epoch
    const protocolParams = await fetchProtocolParameters(api, epoch);
    await populateProtocolParams(protocolParams);

    // Stake distribution & delegations for epoch
    const stakeDistribution = await fetchStakeDistribution(api, epoch);
    await populateStakeDistribution(stakeDistribution);
    await populateDelegations(stakeDistribution);

    // Pools
    const pools = await fetchPools(api);
    await populatePoolDistribution(
        pools,
        stakeDistribution.reduce((sum, s) => sum + BigInt(s.amount || 0), 0n),
    );

    // Blocks made
    await populateBlocksMade(api, epoch);

    // Rewards (approximate)
    await populateRewards(stakeDistribution, protocolParams);

    // NES components
    await populateEpochStateTable();
    await populatePulsingRewUpdate();
    await populateStashedAvvmAddresses();
    await populateNewEpochState(epoch);

    // Ledger & snapshots
    await populateChainAccountState();
    await populateNonMyopic();
    await populateLedgerState();
    await populateSnapshots();

    console.log(`Epoch ${epoch} state populated.`);
}
