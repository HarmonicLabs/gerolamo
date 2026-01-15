import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { Database } from "bun:sqlite";

export async function populateBlocksMade(
    db: Database,
    api: BlockFrostAPI,
    currentEpoch: number,
) {
    console.log("Fetching block production data for epoch...");

    // Get all block hashes for the current epoch
    const epochBlocks = await api.epochsBlocksAll(currentEpoch);
    console.log(`Found ${epochBlocks.length} blocks in epoch ${currentEpoch}`);

    // Fetch all block details and aggregate
    const poolIds = await Promise.all(
        epochBlocks.map(async (blockHash: string) => {
            const block = await api.blocks(blockHash);
            return block.slot_leader;
        }),
    );

    // Aggregate and count blocks per pool
    const blocksByPool = poolIds.reduce(
        (bbp: Map<string, number>, pool: string) =>
            bbp.set(pool, (bbp.get(pool) ?? 0) + 1),
        new Map<string, number>(),
    );

    console.log(`Aggregated block production for ${blocksByPool.size} pools`);

    if (blocksByPool.size > 0) {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO blocks_made (pool_key_hash, epoch, block_count, status)
            VALUES (?, ?, ?, ?)
        `);
        for (const [poolId, count] of blocksByPool.entries()) {
            stmt.run(poolId, currentEpoch, count, "CURR");
        }
        console.log(
            `Inserted ${blocksByPool.size} pool block production records`,
        );
    }

    return blocksByPool.size;
}
