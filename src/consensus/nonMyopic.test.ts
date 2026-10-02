import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeNonMyopic, encodeNonMyopic, freshLikelihoods, likelihood, maxPool, performanceEstimate, rationalToDouble, updateLikelihoods, type Likelihood } from "./nonMyopic";

// Preview, boundary into epoch 1437: the relay's on-disk ledger state of 1436 (prev) and its
// DebugNewEpochState of 1437 (next), with the go snapshot (taken at 1434) and the blocks of 1435
// from node 3036's store; perf = the relay's GetRewardInfoPools performance estimate at 1437.
const fx = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "nonmyopic-preview-1437.json"), "utf8")) as {
    circulation: string; slotsPerEpoch: number;
    pools: Array<{ id: string; stake: string; blocks: number; prev: number[] | null; next: number[]; perf: number | null }>;
};

describe("rationalToDouble (GHC fromRational)", () => {
    test("exact and simple values", () => {
        expect(rationalToDouble(1n, 20n)).toBe(0.05);
        expect(rationalToDouble(3n, 10n)).toBe(0.3);
        expect(rationalToDouble(1n, 3n)).toBe(1 / 3);
        expect(rationalToDouble(0n, 7n)).toBe(0);
        expect(rationalToDouble(-1n, 4n)).toBe(-0.25);
        expect(rationalToDouble(45_000_000_000_000_000n, 1n)).toBe(45_000_000_000_000_000);
    });
    test("ties round to even beyond 2^53", () => {
        expect(rationalToDouble(2n ** 53n + 1n, 1n)).toBe(2 ** 53); // halfway, even below
        expect(rationalToDouble(2n ** 53n + 3n, 1n)).toBe(2 ** 53 + 4); // halfway, even above
    });
    test("large ratios: the nearest double", () => {
        // a double as an exact rational (positive, normal)
        const exact = (v: number): [bigint, bigint] => { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); const bits = dv.getBigUint64(0); const e = Number((bits >> 52n) & 0x7ffn) - 1075; const m = (bits & ((1n << 52n) - 1n)) | (1n << 52n); return e >= 0 ? [m << BigInt(e), 1n] : [m, 1n << BigInt(-e)]; };
        const step = (v: number, up: boolean) => { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); dv.setBigUint64(0, dv.getBigUint64(0) + (up ? 1n : -1n)); return dv.getFloat64(0); };
        const dist = ([a, b]: [bigint, bigint], n: bigint, d: bigint) => { const x = a * d - n * b; return [x < 0n ? -x : x, b * d] as [bigint, bigint]; };
        const le = (x: [bigint, bigint], y: [bigint, bigint]) => x[0] * y[1] <= y[0] * x[1];
        for (const [n, d] of [[11_896_576_265_743n * 1_000_003n, 37_461_773_463_650_468n * 999_983n], [13_492_420_330n, 37_465_462_539_281_778n], [2n ** 70n + 12345n, 3n ** 41n]] as Array<[bigint, bigint]>) {
            const v = rationalToDouble(n, d);
            expect(le(dist(exact(v), n, d), dist(exact(step(v, true)), n, d))).toBe(true);
            expect(le(dist(exact(v), n, d), dist(exact(step(v, false)), n, d))).toBe(true);
        }
    });
});

describe("likelihood update (updateNonMyopic) against the relay", () => {
    const go = new Map(fx.pools.map((p) => [p.id, { stake: BigInt(p.stake), blocks: p.blocks }]));
    const prev = new Map<string, Likelihood>(fx.pools.filter((p) => p.prev).map((p) => [p.id, Float32Array.from(p.prev!)]));
    const fresh = freshLikelihoods(go, BigInt(fx.circulation), [1n, 20n], [0n, 1n], fx.slotsPerEpoch);
    const next = updateLikelihoods(prev, fresh);
    for (const p of fx.pools) {
        test(`pool ${p.id.slice(0, 10)} (${p.blocks} blocks, stake ${p.stake}) bit-identical`, () => {
            const got = next.get(p.id)!;
            for (let i = 0; i < 100; i++) expect(Object.is(got[i], Math.fround(p.next[i]!))).toBe(true);
        });
        if (p.perf != null) test(`pool ${p.id.slice(0, 10)} performance estimate ${p.perf}`, () => expect(performanceEstimate(next.get(p.id)!)).toBe(p.perf!));
    }
    test("a pool absent from the go snapshot is dropped; a new pool starts from mempty", () => {
        const only = updateLikelihoods(prev, new Map([["ff".repeat(28), likelihood(0, 0, 86_400)]]));
        expect([...only.keys()]).toEqual(["ff".repeat(28)]);
        expect([...only.get("ff".repeat(28))!].every((x) => x === 0)).toBe(true);
    });
    test("no history: the prior alone", () => expect(performanceEstimate(null)).toBe(performanceEstimate(new Float32Array(100))));
    test("storage round trip", () => {
        const back = decodeNonMyopic(1437, encodeNonMyopic({ rewardPot: 13_130_493_748_437n, likelihoods: next }));
        expect(back.rewardPot).toBe(13_130_493_748_437n);
        for (const [id, l] of next) expect([...back.likelihoods.get(id)!]).toEqual([...l]);
    });
});

describe("maxPool'", () => {
    test("matches the closed form (a0 = 0.3, nOpt = 500)", () => {
        // σ = p = z0 / 2: R/(1+a0) · (σ + p·a0·(σ − p·(z0 − σ)/z0)/z0)
        const R = 13_130_493_748_437n, z = 500n;
        const f = maxPool([3n, 10n], 500, R, [1n, 2n * z], [1n, 2n * z]);
        // σ' = p' = 1/1000, z0 = 1/500: factor4 = 1/2, factor3 = (1/1000 − 1/2000)·500 = 1/4, factor2 = 1/1000 + 1/1000·0.3·1/4 = 43/40000
        expect(f).toBe((R * 10n * 43n) / (13n * 40_000n));
    });
});
