import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { sql } from "bun";

export async function populatePoolDistribution(
    pools: any[],
    totalActiveStake: bigint,
) {
    await sql`
        INSERT OR REPLACE INTO pool_distr (id, pools, total_active_stake)
        VALUES (1, json(${JSON.stringify(pools)}), ${totalActiveStake})
    `;
}

export async function fetchPools(api: BlockFrostAPI) {
    console.log("Fetching pool distribution...");
    const pools = await api.poolsAll();
    console.log(`Found ${pools.length} pools`);
    return pools;
}
