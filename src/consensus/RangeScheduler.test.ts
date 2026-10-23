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
    test("a range is not abandoned while an untried peer remains, even past retryLimit", async () => {
        const applied: string[] = [];
        const failures: string[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            // retryLimit 1: the very first failure is already at the cap, so the range
            // survives only because an untried peer remains.
            retryLimit: 1,
            // Two peers are behind (MsgNoBlocks-style plain errors); the third has the range.
            pickPeers: () => ["behindA", "behindB", "primary"],
            fetch: async (peer, points) => {
                if (peer !== "primary") throw new Error(`peer ${peer} returned MsgNoBlocks`);
                return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer }));
            },
            verify,
            onRange: async (_points, blocks) => {
                applied.push(blocks[0]!.from);
            },
            onPeerFailure: (peer, _err, info) => {
                failures.push(`${peer}:${info.malicious ? "malicious" : "network"}`);
            },
        });
        await s.submit(pts(0, 4)).applied;
        expect(applied).toEqual(["primary"]);
        expect(failures.every((f) => f.endsWith(":network"))).toBe(true);
        expect(failures.length).toBeGreaterThanOrEqual(1);
        expect(s.stats().retries).toBeGreaterThanOrEqual(1);
    });

    test("a range is abandoned once every eligible peer has failed it and retryLimit is hit", async () => {
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            retryLimit: 2,
            pickPeers: () => ["a", "b"],
            fetch: async (peer) => {
                throw new Error(`peer ${peer} returned MsgNoBlocks`);
            },
            verify,
            onRange: async () => {},
            onFatal: () => {},
        });
        await expect(s.submit(pts(0, 2)).applied).rejects.toThrow(/MsgNoBlocks/);
    });

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

    test("a reset while a range is applying does not skip the first range submitted afterwards", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const applied: string[] = [];
        let first = true;
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            pickPeers: () => ["p"],
            fetch: honestFetch(),
            verify,
            onRange: async (points) => {
                applied.push(points[0]!.hash);
                if (first) {
                    first = false;
                    await gate;
                }
            },
        });
        const a = s.submit(pts(0, 2));
        a.applied.catch(() => {});
        await sleep(30); // A is inside onRange
        s.reset("primary switch");
        const b = s.submit(pts(10, 1));
        release();
        await Promise.race([b.applied, sleep(1000).then(() => { throw new Error("range B was never applied"); })]);
        expect(applied).toEqual(["h0", "h10"]);
        await expect(a.applied).rejects.toThrow("primary switch");
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

describe("RangeScheduler: no silent stall, superseded ranges (bugs 284, 285)", () => {
    test("a range nobody may serve is asked for again instead of sleeping forever", async () => {
        const saved = RangeScheduler.RETRY_NO_PEER_MS;
        RangeScheduler.RETRY_NO_PEER_MS = 20;
        try {
            let eligible: string[] = [];
            const applied: bigint[] = [];
            const s = new RangeScheduler<Pt, Blk>({
                maxInFlight: 2,
                pickPeers: () => eligible,
                fetch: honestFetch(),
                verify,
                onRange: async (points) => { applied.push(points[0]!.slot); },
            });
            const r = s.submit(pts(0, 2));
            await sleep(50);
            expect(applied).toEqual([]);
            expect(s.stats().noPeerWaits).toBeGreaterThanOrEqual(1);
            eligible = ["primary"]; // e.g. the primary's stale divergence was cleared
            await r.applied;
            expect(applied).toEqual([0n]);
        } finally {
            RangeScheduler.RETRY_NO_PEER_MS = saved;
        }
    });

    test("stillCurrent turns false for the range being applied when reset() drops it", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const seen: boolean[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            pickPeers: () => ["p"],
            fetch: honestFetch(),
            verify,
            onRange: async (_points, _blocks, _peer, stillCurrent) => { seen.push(stillCurrent()); await gate; seen.push(stillCurrent()); },
        });
        void s.submit(pts(0, 1)).applied.catch(() => undefined);
        while (seen.length === 0) await sleep(2);
        s.reset("primary outvoted");
        release();
        while (seen.length < 2) await sleep(2);
        expect(seen).toEqual([true, false]);
    });
});

describe("preferred fetch peer (bug 393)", () => {
    test("a range submitted with preferPeer is asked from that peer first, then from the others on failure", async () => {
        const asked: string[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            retryLimit: 4,
            pickPeers: () => ["a", "b", "producer"],
            fetch: async (peer, points) => { asked.push(peer); if (peer !== "producer") throw new Error(`peer ${peer} returned MsgNoBlocks`); return points.map((p) => ({ slot: p.slot, hash: p.hash, from: peer })); },
            verify,
            onRange: async () => {},
        });
        await s.submit(pts(0, 2), { preferPeer: "producer" }).applied;
        expect(asked[0]).toBe("producer");
        expect(asked.length).toBe(1);
        // without a preference the round-robin order applies; the preferred peer is only a first choice
        asked.length = 0;
        await s.submit(pts(2, 2)).applied;
        expect(asked[asked.length - 1]).toBe("producer");
        expect(asked.length).toBeGreaterThanOrEqual(1);
    });
});
