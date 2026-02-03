import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { Database } from "bun:sqlite";

export async function populateStakeDistribution(
    db: Database,
    stakeDistribution: any[],
) {
    if (stakeDistribution.length > 0) {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO stake (stake_credentials, amount)
            VALUES (?, ?)
        `);
        for (const stake of stakeDistribution) {
            stmt.run(stake.stake_address, stake.amount);
        }
    }
}

export async function populateDelegations(
    db: Database,
    stakeDistribution: any[],
) {
    if (stakeDistribution.length > 0) {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash)
            VALUES (?, ?)
        `);
        for (const stake of stakeDistribution) {
            if (stake.pool_id.trim() !== "") {
                stmt.run(stake.stake_address, stake.pool_id);
            }
        }
    }
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
