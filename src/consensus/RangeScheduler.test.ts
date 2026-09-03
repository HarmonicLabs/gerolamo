import { describe, expect, test } from "bun:test";
import { RangeMismatch, RangeScheduler } from "./RangeScheduler";

type Pt = { slot: bigint; hash: string };
type Blk = { slot: bigint; hash: string; from: string };

const pts = (from: number, n: number): Pt[] =>
    Array.from({ length: n }, (_, i) => ({ slot: BigInt(from + i), hash: `h${from + i}` }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function honestFetch(delayFor: Record<string, number> = {}) {
    return async (peer: string, points: Pt[]): Promise<Blk[]> => {
        await sleep(delayFor[peer] ?? 1);
        return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer }));
    };
}

const verify = (points: Pt[], blocks: Blk[], peer: string) => {
    for (let i = 0; i < points.length; i++) {
        if (blocks[i]!.hash !== points[i]!.hash) throw new RangeMismatch(`peer ${peer} lied at ${points[i]!.slot}`);
    }
};

describe("RangeScheduler", () => {
    test("applies ranges strictly in order even when downloads finish out of order", async () => {
        const applied: number[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 3,
            pickPeers: () => ["slow", "fast", "mid"],
            fetch: honestFetch({ slow: 40, fast: 1, mid: 15 }),
            verify,
            onRange: async (points) => {
                applied.push(Number(points[0]!.slot));
            },
        });
        const a = s.submit(pts(0, 4));
        const b = s.submit(pts(4, 4));
        const c = s.submit(pts(8, 4));
        await Promise.all([a.applied, b.applied, c.applied]);
        expect(applied).toEqual([0, 4, 8]);
        expect(s.stats().applied).toBe(3);
    });

    test("back-pressure: scheduled resolves only when a download slot is free", async () => {
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            pickPeers: () => ["p"],
            fetch: honestFetch({ p: 30 }),
            verify,
            onRange: async () => {},
        });
        const first = s.submit(pts(0, 2));
        const second = s.submit(pts(2, 2));
        let secondScheduled = false;
        void second.scheduled.then(() => {
            secondScheduled = true;
        });
        await first.scheduled;
        await sleep(5);
        expect(secondScheduled).toBe(false);
        await first.applied;
        await second.scheduled;
        expect(secondScheduled).toBe(true);
        await second.applied;
    });

    test("a lying peer is reported as malicious and the range is refetched elsewhere", async () => {
        const failures: Array<{ peer: string; malicious: boolean }> = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 2,
            pickPeers: () => ["liar", "honest"],
            fetch: async (peer, points) =>
                points.map((p) => ({ slot: p.slot, hash: peer === "liar" ? "bogus" : p.hash, from: peer })),
            verify,
            onRange: async (_points, blocks) => {
                expect(blocks.every((b) => b.from === "honest")).toBe(true);
            },
            onPeerFailure: (peer, _err, info) => failures.push({ peer, malicious: info.malicious }),
        });
        await s.submit(pts(0, 3)).applied;
        expect(failures).toEqual([{ peer: "liar", malicious: true }]);
        expect(s.stats().retries).toBe(1);
    });

    test("network failure is not malicious and is retried", async () => {
        let calls = 0;
        const failures: boolean[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            pickPeers: () => ["flaky", "ok"],
            fetch: async (peer, points) => {
                calls++;
                if (peer === "flaky") throw new Error("ECONNRESET");
                return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer }));
            },
            verify,
            onRange: async () => {},
            onPeerFailure: (_p, _e, info) => failures.push(info.malicious),
        });
        await s.submit(pts(0, 2)).applied;
        expect(calls).toBe(2);
        expect(failures).toEqual([false]);
    });

    test("exhausting retries poisons the queue and rejects later ranges", async () => {
        let fatal: unknown = null;
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 2,
            retryLimit: 2,
            pickPeers: () => ["bad"],
            fetch: async () => {
                throw new Error("down");
            },
            verify,
            onRange: async () => {},
            onFatal: (e) => {
                fatal = e;
            },
        });
        const a = s.submit(pts(0, 2));
        const b = s.submit(pts(2, 2));
        await expect(a.applied).rejects.toThrow("down");
        await expect(b.applied).rejects.toThrow();
        expect(fatal).toBeInstanceOf(Error);
        expect(() => s.submit(pts(4, 1))).not.toThrow();
        await expect(s.submit(pts(4, 1)).applied).rejects.toThrow();
    });

    test("apply failure poisons and drain() rethrows", async () => {
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 2,
            pickPeers: () => ["p"],
            fetch: honestFetch(),
            verify,
            onRange: async (points) => {
                if (points[0]!.slot === 2n) throw new Error("ledger says no");
            },
        });
        s.submit(pts(0, 2));
        s.submit(pts(2, 2));
        await expect(s.drain()).rejects.toThrow("ledger says no");
    });

    test("reset() drops pending work and allows fresh submissions", async () => {
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            pickPeers: () => ["p"],
            fetch: honestFetch({ p: 50 }),
            verify,
            onRange: async () => {},
        });
        const a = s.submit(pts(0, 2));
        s.reset("rollback");
        await expect(a.applied).rejects.toThrow("rollback");
        await s.submit(pts(10, 1)).applied;
        expect(s.stats().applied).toBe(1);
    });

    test("never runs two ranges on the same peer concurrently", async () => {
        const active = new Map<string, number>();
        let maxPerPeer = 0;
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 4,
            pickPeers: () => ["only"],
            fetch: async (peer, points) => {
                active.set(peer, (active.get(peer) ?? 0) + 1);
                maxPerPeer = Math.max(maxPerPeer, active.get(peer)!);
                await sleep(10);
                active.set(peer, active.get(peer)! - 1);
                return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer }));
            },
            verify,
            onRange: async () => {},
        });
        const jobs = [0, 2, 4, 6].map((f) => s.submit(pts(f, 2)));
        await Promise.all(jobs.map((j) => j.applied));
        expect(maxPerPeer).toBe(1);
        expect(s.stats().applied).toBe(4);
        expect(s.stats().inFlight).toBe(0);
    });

    test("two peers download two ranges in parallel", async () => {
        let concurrent = 0;
        let peak = 0;
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 4,
            pickPeers: () => ["a", "b"],
            fetch: async (peer, points) => {
                concurrent++;
                peak = Math.max(peak, concurrent);
                await sleep(15);
                concurrent--;
                return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer }));
            },
            verify,
            onRange: async () => {},
        });
        const jobs = [0, 2, 4, 6].map((f) => s.submit(pts(f, 2)));
        await Promise.all(jobs.map((j) => j.applied));
        expect(peak).toBe(2);
    });

    test("inFlight never goes negative across a reset", async () => {
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 2,
            pickPeers: () => ["a", "b"],
            fetch: honestFetch({ a: 30, b: 30 }),
            verify,
            onRange: async () => {},
        });
        s.submit(pts(0, 1));
        s.submit(pts(1, 1));
        await sleep(5);
        s.reset("switch");
        await sleep(60);
        expect(s.stats().inFlight).toBe(0);
        await s.submit(pts(5, 1)).applied;
        expect(s.stats().inFlight).toBe(0);
    });
});
