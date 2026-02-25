import { sql } from "bun";

export async function populateRewards(
    stakeDistribution: any[],
    protocolParams: any,
) {
    console.log("Calculating rewards data...");

    // Calculate total active stake
    const totalStake = stakeDistribution
        .filter((stake) => stake.amount !== 0)
        .reduce((sum, stake) => sum + BigInt(stake.amount), 0n);

    // Calculate total rewards for this epoch using Cardano monetary policy
    // Formula: total_rewards = (reserve * ρ) + transaction_fees
    // Where ρ is the monetary expansion rate and transaction_fees are from previous epoch

    // Get monetary expansion parameters from protocol params
    const rho = protocolParams.monetaryExpansion?.valueOf() ||
        protocolParams.rho?.valueOf() || 0.003;
    const tau = protocolParams.treasuryCut?.valueOf() ||
        protocolParams.tau?.valueOf() || 0.2;

    // Estimate current reserve (simplified - in reality this would be tracked)
    // Cardano started with ~45B ADA reserve, decreases over time
    const estimatedReserve = 45000000000000000n; // ~45B ADA in lovelace

    // Calculate monetary expansion
    const monetaryExpansion = BigInt(
        Math.floor(Number(estimatedReserve) * rho),
    );

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
            const stakeShare =
                Number(BigInt(stake.amount) * 1000000n / totalStake) / 1000000;
            const rewardAmount = BigInt(
                Math.floor(Number(stakingRewards) * stakeShare),
            );

            return {
                stake_credentials: stake.stake_address,
                amount: rewardAmount,
            };
        });

    await sql`INSERT OR REPLACE INTO rewards (stake_credentials, amount) VALUES ${sql(rewards.map(reward => [reward.stake_credentials, reward.amount]))}`;
}
