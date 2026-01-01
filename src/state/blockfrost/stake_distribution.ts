import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { sql } from "bun";

export async function populateStakeDistribution(stakeDistribution: any[]) {
    if (stakeDistribution.length > 0) {
        await sql`
            INSERT OR REPLACE
            INTO stake ${
            sql(stakeDistribution.map((stake) => {
                return {
                    stake_credentials: stake.stake_address,
                    amount: stake.amount,
                };
            }))
        }
        `;
    }
}

export async function populateDelegations(stakeDistribution: any[]) {
    if (stakeDistribution.length > 0) {
        await sql`
            INSERT OR REPLACE
            INTO delegations ${
            sql(
                stakeDistribution
                    .filter((stake) => stake.pool_id.trim() !== "")
                    .map((stake) => {
                        return {
                            stake_credentials: stake.stake_address,
                            pool_key_hash: stake.pool_id,
                        };
                    }),
            )
        }
        `;
    }
}

export async function fetchStakeDistribution(api: BlockFrostAPI, epoch: number) {
    console.log("Fetching epoch stake distribution...");
    const stakeDistribution = await api.epochsStakesAll(epoch);
    console.log(`Found ${stakeDistribution.length} stake entries`);
    return stakeDistribution;
}