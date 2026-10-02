/**
 * Epoch-boundary reward accounting (Phase 4c), run when the first block of
 * epoch `e` is about to be applied:
 *
 *   1. pots initialised at the first Shelley boundary (reserves = max supply −
 *      UTxO total; treasury and fee pot 0);
 *   2. rewards queued for `e` are paid into the reward accounts (they were
 *      computed one boundary earlier from epoch e − 2's performance);
 *   3. rewards for the performance of epoch e − 1 are computed from the
 *      snapshot taken at the start of e − 2 ("go"), the blocks made in e − 1,
 *      the fee pot and the parameters of e − 1, and queued to be paid at e + 1.
 *
 * Reports only: the amounts feed the stake snapshots and the withdrawal
 * report; nothing halts on them until they are verified against a reference.
 */
import { sql } from "../sql";
import { ledgerStakeReads } from "../ledger/nodeLedgerStore";
import { logger } from "../utils/logger";
import { readEpochParamsRaw } from "./epochParams";
import { computeEpochRewards, type PoolInput, type RewardParams } from "./rewards";
import {
    blocksMadeInEpoch,
    initRewardPots,
    poolStakeForEpoch,
    readRewardPots,
    recordRewardEpoch,
    registeredPoolParams,
    poolParamsAt,
    registeredStakeKeys,
    stakeSnapshotMembers,
    updateRewardPots,
    creditRewards,
    recordRewardPayouts,
    recordPoolRewards,
    ensurePotSnapshotsTable,
    readPotSnapshot,
    recordPotSnapshot,
    settleDonations,
    readNonMyopic,
    recordNonMyopic,
    snapshotPoolIds,
} from "../db/leaderState";
import { freshLikelihoods, updateLikelihoods, type GoPool } from "./nonMyopic";
import { rationalFromDecimal } from "./rules/overlay";

function ratio(v: unknown, fallback: string): { num: bigint; den: bigint } {
    try {
        return rationalFromDecimal(String(v ?? fallback));
    } catch {
        return rationalFromDecimal(fallback);
    }
}

/**
 * Shelley reward update timing (`NEWEPOCH` / `RUPD`): the update applied at the
 * boundary into epoch e was created during e − 1 from
 *   reserves at the start of e − 1, fees collected during e − 2,
 *   blocks made during e − 2, the stake distribution that led e − 2
 *   (snapshot taken at the start of e − 3), and the parameters of e − 2 (`esPrevPp`);
 * its treasury cut and member/leader rewards land at the boundary into e.
 * Verified against Koios `totals` per boundary (scripts/verify-pots.ts).
 */
/** Everything `computeEpochRewards` needs for the update applied at the boundary into `epoch` (null when nothing applies yet). */
export async function buildRewardInputs(epoch: number, genesis: any, shelleyStart: number, slotsPerEpoch: bigint): Promise<{ perfEpoch: number; input: Parameters<typeof computeEpochRewards>[0]; prevReserves: bigint; fees: bigint; totalBlocks: bigint; expectedBlocks: bigint; pools: number; go: { takenAt: number; stake: Map<string, bigint> } | null; blocks: Map<string, number> } | null> {
    const maxSupply = BigInt(String(genesis?.maxLovelaceSupply ?? 45_000_000_000_000_000n));
    const perfEpoch = epoch - 2;
    const prev = await readPotSnapshot(epoch - 1);
    if (!prev) return null;
    const feesSnap = await readPotSnapshot(epoch - 1); // fees collected during e − 2 were recorded at the boundary into e − 1
    const fees = feesSnap?.feesCollected ?? 0n;
    const dist = perfEpoch >= shelleyStart ? await poolStakeForEpoch(perfEpoch) : null; // taken at perfEpoch − 1
    // `createRUpd` reads `esPrevPp`: the parameters in force during e − 2 (during e − 1,
    // when the update is created, those are the previous parameters). Koios: the pot of the
    // boundary into preprod epoch 7 used d = 1 (epoch 5) although epoch 6 already had d = 0.
    const raw = (await readEpochParamsRaw(epoch - 2)) ?? (await readEpochParamsRaw(epoch - 1)) ?? {};
    const params: RewardParams = {
        rhoNum: ratio(raw.rho, "0.003").num, rhoDen: ratio(raw.rho, "0.003").den,
        tauNum: ratio(raw.tau, "0.2").num, tauDen: ratio(raw.tau, "0.2").den,
        a0Num: ratio(raw.a0, "0.3").num, a0Den: ratio(raw.a0, "0.3").den,
        nOpt: BigInt(String(raw.n_opt ?? 150)),
        dNum: ratio(raw.decentralisation_param, "0").num, dDen: ratio(raw.decentralisation_param, "0").den,
        protocolMajor: Number(raw.protocol_major_ver ?? 0),
    };
    const f = rationalFromDecimal(String(genesis?.activeSlotsCoeff ?? 0.05));
    // expected blocks = slotsPerEpoch · f · (1 − d)
    const expectedBlocks = (slotsPerEpoch * f.num * (params.dDen - params.dNum)) / (f.den * params.dDen);
    const blocks = perfEpoch >= shelleyStart ? await blocksMadeInEpoch(perfEpoch) : new Map<string, number>();
    // BlocksMade counts pool blocks only: overlay slots are issued by genesis delegates,
    // which are not pools (mainnet epoch 213: 16 817 of 21 442 blocks), and η compares
    // pool blocks with (1 − d)·f·slotsPerEpoch.
    const poolIdsForBlocks = new Set((await registeredPoolParams()).keys());
    for (const id of (await poolParamsAt(dist?.takenAt ?? epoch - 1)).keys()) poolIdsForBlocks.add(id);
    let totalBlocks = 0n;
    for (const [id, n] of blocks) if (poolIdsForBlocks.has(id)) totalBlocks += BigInt(n);
    const poolParams = dist ? await poolParamsAt(dist.takenAt) : await registeredPoolParams();
    const members = dist ? await stakeSnapshotMembers(dist.takenAt) : new Map<string, Array<{ credential: string; stake: bigint }>>();
    const registered = await registeredStakeKeys();

    const pools: PoolInput[] = [];
    for (const [poolId, stake] of dist?.stake ?? new Map<string, bigint>()) {
        const pp = poolParams.get(poolId)?.params;
        if (!pp) continue;
        const list = members.get(poolId) ?? [];
        const owners = new Set(pp.owners.map((o) => o.toLowerCase()));
        let ownerStake = 0n;
        for (const m of list) if (owners.has(m.credential)) ownerStake += m.stake;
        pools.push({
            poolId,
            stake,
            ownerStake,
            pledge: BigInt(pp.pledge),
            cost: BigInt(pp.cost),
            marginNum: BigInt(pp.marginNum),
            marginDen: BigInt(pp.marginDen || "1"),
            rewardAccount: pp.rewardAccount.toLowerCase(),
            owners: [...owners],
            blocks: BigInt(blocks.get(poolId) ?? 0),
            members: list,
        });
    }
    const input = {
        reserves: prev.reserves,
        fees,
        totalStake: maxSupply - prev.reserves,
        activeStake: dist?.total ?? 0n,
        totalBlocks,
        expectedBlocks,
        params,
        pools,
        registered,
    };
    return { perfEpoch, input, prevReserves: prev.reserves, fees, totalBlocks, expectedBlocks, pools: pools.length, go: dist ? { takenAt: dist.takenAt, stake: dist.stake } : null, blocks };
}

let nonMyopicGapLogged = false;
/**
 * The pool-ranking half of the reward update (`startStep` / `completeRupd` → `updateNonMyopic`):
 * esNonMyopic of `epoch` = every pool of the `go` snapshot with its decayed likelihood history plus
 * the likelihood of its blocks in the performance epoch, and the pools' share `_R` as the reward
 * pot. Needs the previous epoch's state: a store bootstrapped without it (a Mithril import from
 * before bug 262, or before its seeding) records nothing until `scripts/nonmyopic-seed.ts` seeds it.
 */
async function advanceNonMyopic(epoch: number, built: NonNullable<Awaited<ReturnType<typeof buildRewardInputs>>>, distributable: bigint, genesis: any, slotsPerEpoch: bigint): Promise<void> {
    const prev = await readNonMyopic(epoch - 1);
    if (!prev) {
        if (!nonMyopicGapLogged) logger.info(`Epoch ${epoch}: pool-ranking likelihoods of epoch ${epoch - 1} not recorded (store bootstrapped without them); GetNonMyopicMemberRewards / GetRewardInfoPools stay unanswered until scripts/nonmyopic-seed.ts seeds them`);
        nonMyopicGapLogged = true;
        return;
    }
    const go = new Map<string, GoPool>();
    if (built.go) {
        const ids = await snapshotPoolIds(built.go.takenAt);
        if (!ids) { logger.warn(`Epoch ${epoch}: the pools of the snapshot taken at ${built.go.takenAt} were not kept; pool-ranking likelihoods not advanced`); return; }
        for (const id of ids) go.set(id, { stake: built.go.stake.get(id) ?? 0n, blocks: built.blocks.get(id) ?? 0 });
    }
    const f = rationalFromDecimal(String(genesis?.activeSlotsCoeff ?? 0.05));
    const p = built.input.params;
    const fresh = freshLikelihoods(go, built.input.totalStake, [f.num, f.den], [p.dNum, p.dDen], Number(slotsPerEpoch));
    await recordNonMyopic(sql, epoch, { rewardPot: distributable, likelihoods: updateLikelihoods(prev.likelihoods, fresh) });
}

export async function runEpochRewards(epoch: number, genesis: any, shelleyStart: number, slotsPerEpoch: bigint): Promise<void> {
    const maxSupply = BigInt(String(genesis?.maxLovelaceSupply ?? 45_000_000_000_000_000n));
    if (epoch < shelleyStart) return;
    await ensurePotSnapshotsTable(sql);
    const pots = await initRewardPots(sql, epoch, maxSupply);
    if (epoch === shelleyStart || !(await readPotSnapshot(epoch - 1))) {
        // First Shelley boundary (or a DB from before pot snapshots): nothing to apply yet.
        const cur = (await readRewardPots()) ?? pots;
        await recordPotSnapshot(sql, epoch, { reserves: cur.reserves, treasury: cur.treasury, feesCollected: cur.feePot });
        await updateRewardPots(sql, { reserves: 0n, treasury: 0n, resetFees: true });
        await settleDonations(sql);
        if (epoch === shelleyStart) await recordNonMyopic(sql, epoch, { rewardPot: 0n, likelihoods: new Map() }); // the ledger's initial `NonMyopic` (def)
        return;
    }
    const perfEpoch = epoch - 2;
    // Idempotent across restarts: a boundary re-run must not move the pots twice.
    const lr = ledgerStakeReads();
    const done = lr ? (lr.rewardEpochDone(perfEpoch) ? [[1]] : []) : (await sql`SELECT 1 FROM reward_epochs WHERE performance_epoch = ${perfEpoch}`.values()) as unknown[][];
    if (done.length) return;
    const tBuild = performance.now();
    const built = await buildRewardInputs(epoch, genesis, shelleyStart, slotsPerEpoch);
    const msBuild = Math.round(performance.now() - tBuild);
    if (!built) return;
    const { input, prevReserves: prevReservesUsed, fees, totalBlocks, expectedBlocks } = built;
    const out = computeEpochRewards(input);
    try { await advanceNonMyopic(epoch, built, out.distributable, genesis, slotsPerEpoch); }
    catch (err) { logger.warn(`Epoch ${epoch}: pool-ranking likelihoods not advanced:`, err); }
    const pools = input.pools;
    let paidTotal = 0n;
    for (const v of out.paid.values()) paidTotal += v;
    // Rewards land now (boundary into `epoch`), as do the treasury cut and the reserves movement.
    const tWrite = performance.now();
    await creditRewards(sql, out.paid);
    await recordRewardPayouts(sql, perfEpoch, out.paid);
    await recordPoolRewards(sql, perfEpoch, out.pools);
    const msWrite = Math.round(performance.now() - tWrite);
    await updateRewardPots(sql, { reserves: out.reservesDelta, treasury: out.treasuryDelta, resetFees: false });
    const donated = await settleDonations(sql); // bug 92: the epoch's treasury donations
    if (donated > 0n) logger.info(`Epoch ${epoch}: ${donated} lovelace of treasury donations added to the treasury`);
    await recordRewardEpoch(sql, perfEpoch, { rewardPot: out.rewardPot, treasuryDelta: out.treasuryDelta, paid: paidTotal, unclaimed: out.unclaimed, pools: pools.length, accounts: out.paid.size });
    const cur = (await readRewardPots()) ?? pots;
    await recordPotSnapshot(sql, epoch, { reserves: cur.reserves, treasury: cur.treasury, feesCollected: cur.feePot });
    await updateRewardPots(sql, { reserves: 0n, treasury: 0n, resetFees: true });
    logger.info(`Epoch ${epoch}: reward update for epoch ${perfEpoch} applied — pot ${out.rewardPot} (reserves ${prevReservesUsed}, fees ${fees}), treasury +${out.treasuryDelta} (forfeited ${out.forfeited}), ${paidTotal} to ${out.paid.size} account(s) across ${pools.length} pool(s) (${totalBlocks}/${expectedBlocks} blocks), ${out.unclaimed} unclaimed; inputs ${msBuild} ms, writes ${msWrite} ms`);
}
