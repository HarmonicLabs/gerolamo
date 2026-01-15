import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { Database } from "bun:sqlite";

export async function populatePoolDistribution(
    db: Database,
    pools: any[],
    totalActiveStake: bigint,
) {
    db.run(
        `INSERT OR REPLACE INTO pool_distr (id, pools, total_active_stake) VALUES (?, ?, ?)`,
        [1, JSON.stringify(pools), totalActiveStake]
    );
}

export async function fetchPools(api: BlockFrostAPI) {
    console.log("Fetching pool distribution...");
    const pools = await api.poolsAll();
    console.log(`Found ${pools.length} pools`);
    return pools;
}
