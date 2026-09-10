import { describe, expect, test } from "bun:test";
import { computeEpochRewards, leaderShare, memberShare, type RewardsInput } from "./rewards";

const params = { rhoNum: 3n, rhoDen: 1000n, tauNum: 1n, tauDen: 5n, a0Num: 3n, a0Den: 10n, nOpt: 150n, dNum: 0n, dDen: 1n, protocolMajor: 7 };

describe("computeEpochRewards", () => {
    test("pot arithmetic: reserves·ρ·η + fees, τ to the treasury", () => {
        const out = computeEpochRewards({
            reserves: 1_000_000_000_000n, fees: 1_000n, totalStake: 1_000_000n, activeStake: 1_000_000n,
            totalBlocks: 10n, expectedBlocks: 10n, params, pools: [], registered: new Set(),
        });
        expect(out.rewardPot).toBe(3_000_000_000n + 1_000n);
        expect(out.treasuryDelta).toBe((3_000_001_000n) / 5n);
        expect(out.unclaimed).toBe(out.rewardPot - out.treasuryDelta);
    });
    test("η·ρ·reserves is floored once, as a single rational (preview epoch 1391: two nested floors lose 1 lovelace)", () => {
        // reserves at the start of epoch 1392, 2989 pool blocks of 4320 expected, ρ = 0.003
        const out = computeEpochRewards({
            reserves: 7_695_253_745_555_323n, fees: 0n, totalStake: 1n, activeStake: 1n,
            totalBlocks: 2989n, expectedBlocks: 4320n, params, pools: [], registered: new Set(),
        });
        expect(out.rewardPot).toBe((7_695_253_745_555_323n * 3n * 2989n) / (1000n * 4320n));
        expect(out.rewardPot).toBe(15_972_995_448_239n);
        expect(out.reservesDelta).toBe(-out.rewardPot + out.unclaimed);
    });
    test("one pool with all the stake and full performance earns the pot minus treasury; cost and margin go to the operator", () => {
        const stake = 100_000_000n;
        const input: RewardsInput = {
            reserves: 10_000_000_000n, fees: 0n, totalStake: stake, activeStake: stake, totalBlocks: 21600n, expectedBlocks: 21600n, params,
            pools: [{ poolId: "p", stake, ownerStake: 10_000_000n, pledge: 10_000_000n, cost: 340n, marginNum: 1n, marginDen: 10n, rewardAccount: "op", owners: ["op"], blocks: 21600n,
                members: [{ credential: "op", stake: 10_000_000n }, { credential: "m", stake: 90_000_000n }] }],
            registered: new Set(["op", "m"]),
        };
        const out = computeEpochRewards(input);
        const R = out.rewardPot - out.treasuryDelta;
        // σ capped at z0 = 1/150 with a0 = 0.3: maxPool = R/(1.3)·(z0 + p'·0.3·(z0 − p'·0)/z0) with p' = z0 → R/1.3 · (z0 + 0.3·z0) = R·z0 → pool earns R/150
        const expectedPool = R / 150n;
        const total = [...out.paid.values()].reduce((a, b) => a + b, 0n);
        expect(total <= expectedPool && total >= expectedPool - 2n).toBe(true);
        expect(out.paid.get("op")! > out.paid.get("m")! / 9n).toBe(true); // operator gets cost + margin + owner share
    });
    test("a pool that misses its pledge earns nothing; unregistered accounts forfeit to the reserves", () => {
        const stake = 100_000_000n;
        const base: RewardsInput = {
            reserves: 10_000_000_000n, fees: 0n, totalStake: stake, activeStake: stake, totalBlocks: 1n, expectedBlocks: 1n, params,
            pools: [{ poolId: "p", stake, ownerStake: 1n, pledge: 10_000_000n, cost: 340n, marginNum: 0n, marginDen: 1n, rewardAccount: "op", owners: ["op"], blocks: 1n, members: [{ credential: "m", stake }] }],
            registered: new Set(["op", "m"]),
        };
        expect(computeEpochRewards(base).paid.size).toBe(0);
        const ok = { ...base, pools: [{ ...base.pools[0]!, ownerStake: 10_000_000n }], registered: new Set(["op"]) };
        const out = computeEpochRewards(ok);
        expect(out.paid.has("m")).toBe(false);
        expect(out.unclaimed > 0n).toBe(true);
    });
});

describe("unregistered reward accounts across the Babbage prefilter fork", () => {
    const pool = { poolId: "p".repeat(56), stake: 1_000_000_000_000n, ownerStake: 0n, pledge: 0n, cost: 340_000_000n, marginNum: 1n, marginDen: 1n, rewardAccount: "r".repeat(56), owners: [], blocks: 100n, members: [] };
    const base = { reserves: 10_000_000_000_000_000n, fees: 0n, totalStake: 30_000_000_000_000_000n, activeStake: 1_000_000_000_000n, totalBlocks: 100n, expectedBlocks: 100n, pools: [pool], registered: new Set<string>() };
    test("before Babbage the reward is not computed: it stays in R and returns to the reserves", () => {
        const out = computeEpochRewards({ ...base, params: { ...params, protocolMajor: 6 } });
        expect(out.forfeited).toBe(0n);
        expect(out.paid.size).toBe(0);
        expect(out.unclaimed).toBe(out.rewardPot - out.treasuryDelta);
    });
    test("from Babbage on it is computed and forfeited to the treasury", () => {
        const out = computeEpochRewards({ ...base, params: { ...params, protocolMajor: 7 } });
        expect(out.forfeited).toBeGreaterThan(0n);
        expect(out.paid.size).toBe(0);
        expect(out.treasuryDelta).toBe(out.rewardPot / 5n + out.forfeited);
        expect(out.unclaimed + out.forfeited).toBe(out.rewardPot - out.rewardPot / 5n);
    });
    test("a pool that produced no block earns nothing even while d ≥ 0.8 (mainnet epochs 208–210 paid no rewards)", () => {
        const stake = 100_000_000n;
        const dHigh = { ...params, dNum: 1n, dDen: 1n };
        const pool = { poolId: "p", stake, ownerStake: 10_000_000n, pledge: 10_000_000n, cost: 340n, marginNum: 0n, marginDen: 1n, rewardAccount: "op", owners: ["op"], blocks: 0n,
            members: [{ credential: "op", stake: 10_000_000n }, { credential: "m", stake: 90_000_000n }] };
        const out = computeEpochRewards({ reserves: 10_000_000_000n, fees: 0n, totalStake: stake, activeStake: stake, totalBlocks: 0n, expectedBlocks: 0n, params: dHigh, pools: [pool], registered: new Set(["op", "m"]) });
        expect(out.paid.size).toBe(0);
        expect(out.unclaimed).toBe(out.rewardPot - out.treasuryDelta);
        const withBlocks = computeEpochRewards({ reserves: 10_000_000_000n, fees: 0n, totalStake: stake, activeStake: stake, totalBlocks: 5n, expectedBlocks: 0n, params: dHigh, pools: [{ ...pool, blocks: 5n }], registered: new Set(["op", "m"]) });
        expect(withBlocks.paid.size).toBe(2);
    });
});

describe("pool reward split (bug 97)", () => {
    test("the leader share is one floor over the exact rational, not a floored margin plus a floored owner share", () => {
        // f − c = 1000, m = 2/3, owner/stake = 7/10: exact 1000·(2/3 + 1/3·7/10) = 900; floor(666.67) + floor(334·0.7) = 899
        expect(leaderShare(1500n, 500n, 2n, 3n, 700n, 1000n)).toBe(500n + 900n);
        expect(leaderShare(400n, 500n, 2n, 3n, 700n, 1000n)).toBe(400n); // below cost: everything to the operator
    });
    test("a member share is one floor too: ⌊(f − c)(1 − m)·t/σ⌋", () => {
        // 1000·(1/3)·(1/2) = 166.67 → 166; the old remainder split gave ⌊334/2⌋ = 167
        expect(memberShare(1500n, 500n, 2n, 3n, 500n, 1000n)).toBe(166n);
        expect(memberShare(400n, 500n, 2n, 3n, 500n, 1000n)).toBe(0n);
    });
});
