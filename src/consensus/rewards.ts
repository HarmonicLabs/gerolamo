/**
 * Shelley reward calculation (cardano-ledger REWARD / rewardOnePool), pure.
 *
 *   rewardPot = ⌊reserves · ρ · η⌋ + fees            η = performance factor (1 when d ≥ 0.8)
 *   ΔT        = ⌊rewardPot · τ⌋  → treasury;  R = rewardPot − ΔT
 *   per pool with stake σ (relative to total), pledge ratio p, blocks n of N:
 *     maxPool = R / (1 + a0) · ( σ' + p' · a0 · (σ' − p' · (z0 − σ') / z0) / z0 )
 *               with z0 = 1/nOpt, σ' = min(σ, z0), p' = min(p, z0); 0 if pledge unmet
 *     apparent performance = (n / N) / σ_a  (σ_a over the active stake; 1 when d ≥ 0.8)
 *     poolReward = ⌊maxPool · min(1, performance)⌋   (bounded by R)
 *     operator: cost + margin · (poolReward − cost) + owner-share of the rest
 *     members : (1 − margin) · (poolReward − cost) · memberStake / poolStake
 *   Unclaimed amounts (unregistered reward accounts) return to the reserves.
 * All arithmetic is exact rational on bigints; results are floored per the spec.
 */

export interface RewardParams {
    /** Protocol major version of the parameters in force (Babbage = 7 drops the reward prefilter). */
    protocolMajor: number;
    rhoNum: bigint; rhoDen: bigint;
    tauNum: bigint; tauDen: bigint;
    a0Num: bigint; a0Den: bigint;
    nOpt: bigint;
    dNum: bigint; dDen: bigint;
}

export interface PoolInput {
    poolId: string;
    /** Stake delegated to the pool in the snapshot (lovelace). */
    stake: bigint;
    /** Stake of the pool's registered owners that is delegated to the pool. */
    ownerStake: bigint;
    pledge: bigint;
    cost: bigint;
    marginNum: bigint; marginDen: bigint;
    rewardAccount: string;
    /** Registered owners' stake credentials: their stake earns through the operator, not as members. */
    owners: string[];
    /** Blocks the pool made in the performance epoch. */
    blocks: bigint;
    /** Members: stake credential → delegated stake in the snapshot. */
    members: Array<{ credential: string; stake: bigint }>;
}

export interface RewardsInput {
    reserves: bigint;
    fees: bigint;
    totalStake: bigint;
    /** Active stake (delegated to registered pools) for σ_a. */
    activeStake: bigint;
    totalBlocks: bigint;
    /** Expected blocks in the epoch: slotsPerEpoch · f · (1 − d). */
    expectedBlocks: bigint;
    params: RewardParams;
    pools: PoolInput[];
    /** Credentials whose reward accounts are registered (unregistered ones forfeit). */
    registered: ReadonlySet<string>;
}

export interface RewardsOutput {
    rewardPot: bigint;
    treasuryDelta: bigint;
    /** Rewards paid per credential. */
    paid: Map<string, bigint>;
    /** Computed but not distributed (pools below pledge, no blocks, rounding): returns to the reserves. */
    unclaimed: bigint;
    /** Rewards of unregistered reward accounts: the ledger sends them to the treasury (Δt2). */
    forfeited: bigint;
    /** Per-pool breakdown for verification. */
    pools: Array<{ poolId: string; maxPool: bigint; poolReward: bigint; operator: bigint; members: bigint; ownerStake: bigint; stake: bigint; blocks: bigint }>;
    /** Reserves after the epoch: reserves − (rewardPot − fees) + unclaimed... see below */
    reservesDelta: bigint;
    /** `_R` = rewardPot − ⌊rewardPot · τ⌋, what the pools share (the ledger keeps it as `rewardPotNM`). */
    distributable: bigint;
}

function mulDiv(a: bigint, num: bigint, den: bigint): bigint {
    return (a * num) / den;
}

/** Operator's share of a pool reward `f`: cost + ⌊(f − c)·(m + (1 − m)·owner/stake)⌋, one floor (Shelley `leaderRew`). */
export function leaderShare(f: bigint, cost: bigint, marginNum: bigint, marginDen: bigint, ownerStake: bigint, poolStake: bigint): bigint {
    if (f <= cost) return f;
    if (poolStake <= 0n) return cost + ((f - cost) * marginNum) / marginDen;
    return cost + ((f - cost) * (marginNum * poolStake + (marginDen - marginNum) * ownerStake)) / (marginDen * poolStake);
}

/** A member's share of a pool reward: ⌊(f − c)·(1 − m)·stake/poolStake⌋, one floor (Shelley `memberRew`). */
export function memberShare(f: bigint, cost: bigint, marginNum: bigint, marginDen: bigint, memberStake: bigint, poolStake: bigint): bigint {
    if (f <= cost || poolStake <= 0n) return 0n;
    return ((f - cost) * (marginDen - marginNum) * memberStake) / (marginDen * poolStake);
}

export function computeEpochRewards(input: RewardsInput): RewardsOutput {
    const { params: p } = input;
    const dHigh = p.dNum * 5n >= p.dDen * 4n; // d ≥ 0.8
    // η: blocks made vs expected (1 while d ≥ 0.8)
    let etaNum = 1n, etaDen = 1n;
    if (!dHigh && input.expectedBlocks > 0n) {
        etaNum = input.totalBlocks;
        etaDen = input.expectedBlocks;
        if (etaNum > etaDen) { etaNum = 1n; etaDen = 1n; }
    }
    // `createRUpd`: deltaR1 = floor(min 1 η · ρ · reserves) — one floor over the exact rational
    // (two nested floors come out 1 lovelace short on some inputs, e.g. preview epoch 1391).
    const fromReserves = (input.reserves * p.rhoNum * etaNum) / (p.rhoDen * etaDen);
    const rewardPot = fromReserves + input.fees;
    const treasuryDelta = mulDiv(rewardPot, p.tauNum, p.tauDen);
    const R = rewardPot - treasuryDelta;

    const paid = new Map<string, bigint>();
    let distributed = 0n;
    let forfeited = 0n;
    const perPool: RewardsOutput["pools"] = [];
    // Before Babbage (`hardforkBabbageForgoRewardPrefilter`, protocol 7) rewards for
    // unregistered accounts are not computed at all (their share stays in R and returns to
    // the reserves); from Babbage on they are computed and land in the treasury.
    const forgoPrefilter = p.protocolMajor >= 7;
    const add = (cred: string, amount: bigint) => {
        if (amount <= 0n) return;
        if (!input.registered.has(cred)) {
            if (forgoPrefilter) forfeited += amount; // paid out of R, but to the treasury
            return;
        }
        paid.set(cred, (paid.get(cred) ?? 0n) + amount);
        distributed += amount;
    };

    if (input.totalStake > 0n && p.nOpt > 0n) {
        for (const pool of input.pools) {
            if (pool.stake <= 0n) continue;
            // σ and p as rationals over totalStake, capped at z0 = 1/nOpt
            const z0Num = 1n, z0Den = p.nOpt;
            const sigmaNum = pool.stake, sigmaDen = input.totalStake;
            const pledgeMet = pool.ownerStake >= pool.pledge;
            if (!pledgeMet) continue;
            // `reward` iterates `Map.lookup hk blocksMade`: a pool that produced no block in the
            // performance epoch gets nothing, whatever d is (mainnet paid no rewards for
            // epochs 208–210, when d = 1 and only genesis delegates issued blocks).
            if (pool.blocks <= 0n) continue;
            const capNum = (a: bigint, b: bigint) => (a * z0Den < z0Num * b ? [a, b] : [z0Num, z0Den]) as [bigint, bigint];
            const [sN, sD] = capNum(sigmaNum, sigmaDen);
            const [pN, pD] = capNum(pool.pledge, input.totalStake);
            // maxPool = R/(1+a0) · ( s + p·a0·(s − p·(z0 − s)/z0)/z0 )
            //  = R · a0Den/(a0Den + a0Num) · [ s + p·(a0Num/a0Den)·(s − p·(z0 − s)·nOpt)·nOpt ]
            // compute the bracket as a rational (num/den) exactly
            // t1 = z0 − s = (1/nOpt − sN/sD) = (sD − sN·nOpt) / (sD·nOpt)
            const t1N = sD - sN * p.nOpt, t1D = sD * p.nOpt;
            // t2 = p · t1 / z0 = pN/pD · t1N/t1D · nOpt
            const t2N = pN * t1N * p.nOpt, t2D = pD * t1D;
            // t3 = s − t2
            const t3N = sN * t2D - t2N * sD, t3D = sD * t2D;
            // t4 = p · a0 · t3 / z0 = pN/pD · a0N/a0D · t3N/t3D · nOpt
            const t4N = pN * p.a0Num * t3N * p.nOpt, t4D = pD * p.a0Den * t3D;
            // bracket = s + t4
            const brN = sN * t4D + t4N * sD, brD = sD * t4D;
            let maxPool = (R * p.a0Den * brN) / ((p.a0Den + p.a0Num) * brD);
            if (maxPool < 0n) maxPool = 0n;
            if (maxPool > R) maxPool = R;
            // apparent performance
            let poolReward = maxPool;
            if (!dHigh) {
                if (input.totalBlocks <= 0n || input.activeStake <= 0n) poolReward = 0n;
                else {
                    // apparent performance = (n/N) / (stake/activeStake) = n·activeStake / (N·stake).
                    // Not capped: `mkApparentPerformance` returns β/σ as is, so a pool that made
                    // more blocks than its stake share earns above maxPool (preprod epoch 45:
                    // pool baba8f… at 1.0247 × maxPool, matching Koios).
                    const perfN = pool.blocks * input.activeStake, perfD = input.totalBlocks * pool.stake;
                    poolReward = (maxPool * perfN) / perfD;
                }
            }
            if (poolReward <= 0n) continue;
            // Bug 97: leader and member shares are each ONE floor over the exact rational
            // (Shelley rewardOnePool: leader = c + ⌊(f̂−c)(m + (1−m)·s/σ)⌋, member = ⌊(f̂−c)(1−m)·t/σ⌋).
            // Flooring the margin first and redistributing the remainder paid the operator 1
            // lovelace short and a member 1 long on some inputs (preview pool cb8ccb08…: 217 of
            // 640 pre-Conway epochs −1 on its leader reward vs Koios).
            const operator = leaderShare(poolReward, pool.cost, pool.marginNum, pool.marginDen, pool.ownerStake, pool.stake);
            const operatorCred = pool.rewardAccount;
            add(operatorCred, operator);
            const owners = new Set(pool.owners);
            let membersTotal = 0n;
            for (const m of pool.members) {
                if (owners.has(m.credential)) continue; // paid through the operator's owner share
                const share = memberShare(poolReward, pool.cost, pool.marginNum, pool.marginDen, m.stake, pool.stake);
                if (share > 0n) {
                    add(m.credential, share);
                    membersTotal += share;
                }
            }
            perPool.push({ poolId: pool.poolId, maxPool, poolReward, operator, members: membersTotal, ownerStake: pool.ownerStake, stake: pool.stake, blocks: pool.blocks });
        }
    }
    const unclaimed = R - distributed - forfeited;
    return {
        rewardPot,
        treasuryDelta: treasuryDelta + forfeited,
        paid,
        unclaimed,
        forfeited,
        pools: perPool,
        // reserves lose what came from them; undistributed rewards flow back
        reservesDelta: -fromReserves + unclaimed,
        distributable: R,
    };
}
