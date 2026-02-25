import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { sql } from "bun";

export async function populateStakeDistribution(
    stakeDistribution: any[],
) {
    await sql`INSERT OR REPLACE INTO stake (stake_credentials, amount) VALUES ${sql(stakeDistribution.map(stake => [stake.stake_address, stake.amount]))}`;
}

export async function populateDelegations(
    stakeDistribution: any[],
) {
    const delegations = stakeDistribution.filter(stake => stake.pool_id.trim() !== "").map(stake => [stake.stake_address, stake.pool_id]);
    await sql`INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash) VALUES ${sql(delegations)}`;
}

export async function fetchStakeDistribution(
    api: BlockFrostAPI,
    epoch: number,
) {
    console.log("Fetching epoch stake distribution...");
    const stakeDistribution = await api.epochsStakesAll(epoch);
    console.log(`Found ${stakeDistribution.length} stake entries`);
    return stakeDistribution;
}
