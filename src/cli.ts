import { program } from "commander";
import { initNewEpochState } from "./consensus/ledger";
import { sql } from "bun";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { defaultShelleyProtocolParameters, ShelleyProtocolParameters } from "@harmoniclabs/cardano-ledger-ts";

export async function getCbor(dbPath: string, snapshotRoot: string) {
    // TODO: Implement Mithril snapshot import
    console.log(
        `Mithril import not implemented yet. Snapshot: ${snapshotRoot}, DB: ${dbPath}`,
    );
}

// Helper functions for fetching data from Blockfrost
async function fetchBlockData(api: BlockFrostAPI, blockHash: string) {
    console.log(`Fetching block ${blockHash}...`);
    const block = await api.blocks(blockHash);
    console.log(`Block slot: ${block.slot}, height: ${block.height}`);

    // Calculate current epoch from slot (preprod epoch length is 432000 slots)
    const currentEpoch = Math.floor((block.slot || 0) / 432000);
    console.log(`Current epoch: ${currentEpoch}`);

    return { block, currentEpoch };
}

async function fetchProtocolParameters(api: BlockFrostAPI, epoch: number) {
    console.log("Fetching protocol parameters...");
    const protocolParams = await api.epochsParameters(epoch);
    console.log("Protocol parameters fetched");
    return protocolParams;
}

async function fetchStakeDistribution(api: BlockFrostAPI, epoch: number) {
    console.log("Fetching epoch stake distribution...");
    const stakeDistribution = await api.epochsStakesAll(epoch);
    console.log(`Found ${stakeDistribution.length} stake entries`);
    return stakeDistribution;
}

async function fetchPools(api: BlockFrostAPI) {
    console.log("Fetching pool distribution...");
    const pools = await api.poolsAll();
    console.log(`Found ${pools.length} pools`);
    return pools;
}

async function fetchAddresses(api: BlockFrostAPI, blockHash: string) {
    console.log("Fetching addresses affected by block...");
    const addresses = await api.blocksAddressesAll(blockHash);
    console.log(`Found ${addresses.length} addresses affected by block`);
    return addresses;
}

// Helper functions for populating database tables
async function populateProtocolParams(protocolParams: any) {
    await sql`
        INSERT OR REPLACE INTO protocol_params (id, params)
        VALUES (1, json(${JSON.stringify(protocolParams)}))
    `;
}

async function populateChainAccountState() {
    await sql`
        INSERT OR REPLACE INTO chain_account_state ${
        sql({
            id: 1,
            treasury: 0,
            reserves: 0,
        })
    }
    `;
}

async function populatePoolDistribution(
    pools: any[],
    totalActiveStake: bigint,
) {
    await sql`
        INSERT OR REPLACE INTO pool_distr (id, pools, total_active_stake)
        VALUES (1, json(${JSON.stringify(pools)}), ${totalActiveStake})
    `;
}

async function populateBlocksMade(api: BlockFrostAPI, currentEpoch: number) {
    console.log("Fetching block production data for epoch...");

    // Get all block hashes for the current epoch
    const epochBlocks = await api.epochsBlocksAll(currentEpoch);
    console.log(`Found ${epochBlocks.length} blocks in epoch ${currentEpoch}`);

    // Fetch all block details and aggregate
    const poolIds = await Promise.all(
        epochBlocks.map(async (blockHash: string) => {
            const block = await api.blocks(blockHash);
            return block.slot_leader;
        })
    );

    // Aggregate and count blocks per pool
    const blocksByPool = poolIds.reduce(
        (bbp: Map<string, number>, pool: string) =>
            bbp.set(pool, (bbp.get(pool) ?? 0) + 1),
        new Map<string, number>(),
    );

    console.log(`Aggregated block production for ${blocksByPool.size} pools`);

    if (blocksByPool.size > 0) {
        await sql`
            INSERT OR REPLACE
            INTO blocks_made ${
                sql([
                    ...blocksByPool.entries().map(([poolId, count]) => {
                        return {
                            pool_key_hash: poolId,
                            epoch: currentEpoch,
                            block_count: count,
                            status: "CURR",
                        };
                    }),
                ])
            }
        `;
        console.log(
            `Inserted ${blocksByPool.size} pool block production records`,
        );
    }

    return blocksByPool.size;
}

async function populateStakeDistribution(stakeDistribution: any[]) {
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

async function populateDelegations(stakeDistribution: any[]) {
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

async function populateRewards(stakeDistribution: any[], protocolParams: ShelleyProtocolParameters) {
    console.log("Calculating rewards data...");

    // Calculate total active stake
    const totalStake = stakeDistribution
        .filter((stake) => stake.amount !== 0)
        .reduce((sum, stake) => sum + BigInt(stake.amount), 0n);

    // Calculate total rewards for this epoch using Cardano monetary policy
    // Formula: total_rewards = (reserve * ρ) + transaction_fees
    // Where ρ is the monetary expansion rate and transaction_fees are from previous epoch

    // Get monetary expansion parameters from protocol params
    const rho = protocolParams.monetaryExpansion.valueOf();
    const tau = protocolParams.treasuryCut.valueOf();

    // Estimate current reserve (simplified - in reality this would be tracked)
    // Cardano started with ~45B ADA reserve, decreases over time
    const estimatedReserve = 45000000000000000n; // ~45B ADA in lovelace

    // Calculate monetary expansion
    const monetaryExpansion = BigInt(Math.floor(Number(estimatedReserve) * rho));

    // Transaction fees from previous epoch (simplified - set to 0 for now)
    const transactionFees = 0n;

    // Total rewards available
    const totalRewards = monetaryExpansion + transactionFees;

    // Staking rewards = total_rewards * (1 - τ)
    // τ goes to treasury, (1-τ) goes to staking rewards
    const stakingRewards = BigInt(Math.floor(Number(totalRewards) * (1 - tau)));

    console.log(`Monetary expansion: ${monetaryExpansion} lovelace`);
    console.log(`Transaction fees: ${transactionFees} lovelace`);
    console.log(`Total rewards: ${totalRewards} lovelace`);
    console.log(`Staking rewards: ${stakingRewards} lovelace`);

    // Calculate rewards for each stake address
    const rewards = stakeDistribution
        .filter((stake) => stake.amount && stake.amount > 0)
        .map((stake) => {
            // Proportional reward based on stake share
            const stakeShare = Number(BigInt(stake.amount) * 1000000n / totalStake) / 1000000;
            const rewardAmount = BigInt(Math.floor(Number(stakingRewards) * stakeShare));

            return {
                stake_credentials: stake.stake_address,
                amount: rewardAmount,
            };
        });

    console.log(`Calculated rewards for ${rewards.length} stake addresses`);

    if (rewards.length > 0) {
        await sql`
            INSERT OR REPLACE
            INTO rewards ${sql(rewards)}
        `;
        console.log(`Inserted ${rewards.length} reward entries`);
    }
}

async function populateNonMyopic() {
    await sql`
        INSERT OR REPLACE INTO non_myopic ${
        sql({
            id: 1,
            reward_pot: 0,
            likelihoods_id: null,
        })
    }
    `;
}

async function populateUTxOs(
    api: BlockFrostAPI,
    stakeDistribution: { stake_address: string }[],
) {
    console.log("Fetching complete UTxO set...");

    const utxos = await Promise.all(
        [...new Set(stakeDistribution.map(stake => stake.stake_address))]
            .map(
                (v) =>
                    api
                        .accountsAddressesAll(v)
                        .then(addrs => Promise.all(
                            addrs.map(({ address }) => api
                                .addressesUtxosAll(address)
                                .then(async (utxos) => {
                                    await sql`INSERT OR IGNORE INTO utxo ${
                                        sql(
                                            utxos.map((utxo) => {
                                                return {
                                                    utxo_ref: `${utxo.tx_hash}:${utxo.output_index}`,
                                                    tx_out: JSON.stringify({
                                                        address: utxo.address,
                                                        amount: utxo.amount.find((a) =>
                                                            a.unit === "lovelace"
                                                        )?.quantity || "0",
                                                    }),
                                                };
                                            })
                                        )
                                    }`;
                                })
                            )
                        ))
            )
    );
}

async function populateLedgerState() {
    await sql`
        INSERT OR REPLACE INTO ledger_state ${
        sql({
            id: 1,
            utxo_deposited: 0,
            utxo_fees: 0,
            utxo_donation: 0,
            cert_state_id: null,
        })
    }
    `;
}

async function populateSnapshots() {
    await sql`
        INSERT OR REPLACE INTO snapshots ${
        sql({
            id: 1,
            stake_id: null,
            rewards_id: null,
            delegations_id: null,
        })
    }
    `;
}

async function populateEpochState() {
    await sql`
        INSERT OR REPLACE INTO epoch_state ${
        sql({
            id: 1,
            chain_account_state_id: 1,
            ledger_state_id: 1,
            snapshots_id: 1,
            non_myopic_id: 1,
            pparams_id: 1,
        })
    }
    `;
}

async function populatePulsingRewUpdate() {
    await sql`
        INSERT OR REPLACE INTO pulsing_rew_update (id, data)
        VALUES (1, json(${JSON.stringify({})}))
    `;
}

async function populateStashedAvvmAddresses() {
    await sql`
        INSERT OR REPLACE INTO stashed_avvm_addresses (id, addresses)
        VALUES (1, json(${JSON.stringify([])}))
    `;
}

async function populateNewEpochState(currentEpoch: number) {
    await sql`
        INSERT OR REPLACE INTO new_epoch_state ${
        sql({
            id: 1,
            last_epoch_modified: currentEpoch,
            epoch_state_id: 1,
            pulsing_rew_update_id: 1,
            pool_distr_id: 1,
            stashed_avvm_addresses_id: 1,
        })
    }
    `;
}

export async function importFromBlockfrost(
    blockHash: string,
) {
    const api = new BlockFrostAPI({
        customBackend: "https://blockfrost-preprod.onchainapps.io/",
        rateLimiter: false,
        // requestTimeout: 900,
    });

    await initNewEpochState();

    // Fetch all required data from Blockfrost
    const { currentEpoch } = await fetchBlockData(api, blockHash);
    // const protocolParams = await fetchProtocolParameters(api, currentEpoch);
    const stakeDistribution = await fetchStakeDistribution(api, currentEpoch);
    // const pools = await fetchPools(api);
    // const addresses = await fetchAddresses(api, blockHash);

    // Calculate derived data
    // const totalActiveStake = stakeDistribution.filter((stake) => stake.amount)
    //     .reduce((sum, stake) => sum + BigInt(stake.amount), 0n);

    // // === POPULATE ALL NES COMPONENTS ===

    // // 1. Protocol parameters
    // await populateProtocolParams(protocolParams);

    // // 2. Chain account state
    // await populateChainAccountState();

    // // 3. Pool distribution
    // await populatePoolDistribution(pools, totalActiveStake);

    // // 4. Blocks made data
    // const blocksMadePoolCount = await populateBlocksMade(api, currentEpoch);

    // // 5. Stake distribution
    // await populateStakeDistribution(stakeDistribution);

    // // 6. Delegations
    // await populateDelegations(stakeDistribution);

    // // 7. Rewards
    // await populateRewards(stakeDistribution, defaultShelleyProtocolParameters);

    // // 8. Non-myopic data
    // await populateNonMyopic();

    // 8. UTxO set
    await populateUTxOs(api, stakeDistribution);
    console.log("Done");
    process.exit(0);

    // 9. Ledger state
    await populateLedgerState();

    // 10. Snapshots
    await populateSnapshots();

    // 11. Epoch state
    await populateEpochState();

    // 12. Pulsing reward update
    await populatePulsingRewUpdate();

    // 13. Stashed AVVM addresses
    await populateStashedAvvmAddresses();

    // 14. New epoch state (the root)
    // await populateNewEpochState(currentEpoch);

    // console.log(`\n=== COMPLETE NES IMPORTED FOR EPOCH ${currentEpoch} ===`);
    // console.log(`📦 Protocol parameters: ✓`);
    // console.log(`🏦 Chain accounts: ✓ (defaults)`);
    // console.log(
    //     `🏊 Pool distribution: ✓ (${pools.length} pools, ${totalActiveStake} total stake)`,
    // );
    // console.log(
    //     `⛏️  Blocks made: ✓ (${blocksMadePoolCount} pools)`,
    // );
    // console.log(
    //     `🪙 Stake distribution: ✓ (${stakeDistribution.length} entries)`,
    // );
    // console.log(
    //     `🔗 Delegations: ✓ (${
    //         stakeDistribution.filter((s) => s.pool_id).length
    //     } entries)`,
    // );
    // console.log(
    //     `💰 Rewards: ✓ (${stakeDistribution.filter((s) => BigInt(s.amount || 0) > 0n).length} entries)`,
    // );
    // console.log(
    //     `💰 UTxO set: ✓ (${
    //         (await sql`SELECT COUNT(*) from utxo`)[0]["COUNT(*)"]
    //     } UTxOs from ${addresses.length} addresses)`,
    // );
    // console.log(`📊 Ledger state: ✓`);
    // console.log(`📸 Snapshots: ✓`);
    // console.log(`🎯 Complete New Epoch State imported from Blockfrost!`);
}

program.name("gerolamo");

export function Main() {
    program
        .command("import-ledger-state")
        .description(
            "Import ledger state from Blockfrost for a specific block",
        )
        .argument(
            "<blockHash>",
            "block hash to import ledger state for",
        )
        .option(
            "--project-id <id>",
            "Blockfrost project ID",
            "preprodsW0Hlv1JrniHGB2PuWkajzFb6KmAEN3j",
        )
        .action(async (
            blockHash: string,
            // options: { projectId: string },
        ) => {
            await importFromBlockfrost(blockHash);
        });

    program
        .command("start-node")
        .description(
            "Start the node with a pre-loaded ledger state DB and sync to tip",
        )
        .argument("<dbPath>", "path to the SQLite database file")
        .action(async () => {});

    program.parse(process.argv);
}
