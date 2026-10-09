// Bug 385: a range handed over from a promoted verifier's fragment skipped 1565 blocks; every honest peer
// that served the whole span was convicted as malicious. The handover now follows parent hashes, and a
// range whose points are a subsequence of what the peer served fails without convicting anyone.
import { describe, expect, test } from "bun:test";
import { CandidateSet } from "./CandidateSet";
import { RangeHole, RangeMismatch, RangeScheduler } from "./RangeScheduler";

const h = (n: number) => `h${n.toString(16).padStart(4, "0")}`;
const pt = (n: number) => ({ slot: BigInt(n * 2), hash: h(n), prevHash: h(n - 1) });

describe("CandidateSet.chainAfter (bug 385)", () => {
    test("follows parent hashes through an arrival-ordered fragment with a replay and stops at a hole", () => {
        const cs = new CandidateSet({ depth: 2160 });
        cs.addPeer("p", "primary");
        cs.addPeer("v", "verifier");
        // The verifier streamed ahead (20..29), was re-anchored on our tip and replayed 11..15, then
        // continued at 18..19 (16 and 17 never arrived: a hole).
        for (let n = 20; n < 30; n++) cs.observe("v", pt(n));
        for (let n = 11; n <= 15; n++) cs.observe("v", pt(n));
        for (let n = 18; n <= 19; n++) cs.observe("v", pt(n));
        // Slicing by slot (the old handover) keeps arrival order: 20..29, then 11..15, 18, 19 — ranges cut
        // from it jump back and skip 16 and 17.
        const bySlot = cs.fragmentOf("v").filter((p) => p.slot > 20n).map((p) => p.hash);
        expect(bySlot.slice(9, 11)).toEqual([h(29), h(11)]);
        const chain = cs.chainAfter("v", h(10)).map((p) => p.hash);
        expect(chain).toEqual([11, 12, 13, 14, 15].map(h));
        expect(cs.chainAfter("v", h(17)).map((p) => p.hash)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map(h));
        expect(cs.chainAfter("v", h(99))).toEqual([]);
    });

    test("prefers the later arrival where the fragment holds two children of one block", () => {
        const cs = new CandidateSet({ depth: 2160 });
        cs.addPeer("p", "primary");
        cs.addPeer("v", "verifier");
        cs.observe("v", { slot: 2n, hash: "a1", prevHash: "a0" });
        cs.observe("v", { slot: 4n, hash: "old2", prevHash: "a1" });
        cs.observe("v", { slot: 6n, hash: "new2", prevHash: "a1" }); // the stream rolled back and took another branch
        cs.observe("v", { slot: 8n, hash: "new3", prevHash: "new2" });
        expect(cs.chainAfter("v", "A0").map((p) => p.hash)).toEqual(["a1", "new2", "new3"]);
    });
});

describe("RangeScheduler RangeHole (bug 385)", () => {
    type Pt = { slot: bigint; hash: string };
    type Blk = { hash: string };
    test("a peer serving the whole span of a holed range is not convicted and the pipeline fails once", async () => {
        const chain = Array.from({ length: 10 }, (_, i) => ({ slot: BigInt(i), hash: `b${i}` }));
        const points: Pt[] = [chain[0]!, chain[1]!, chain[7]!, chain[8]!]; // 2..6 missing from our list
        const failures: string[] = [];
        let fatal: unknown = null;
        let fetches = 0;
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            retryLimit: 4,
            pickPeers: () => ["a", "b", "c"],
            fetch: async (_peer, pts) => { fetches++; const lo = Number(pts[0]!.slot), hi = Number(pts[pts.length - 1]!.slot); return chain.slice(lo, hi + 1).map((c) => ({ hash: c.hash })); },
            verify: () => { throw new RangeMismatch("unreachable"); },
            pointsAreSubsequence: (pts, blocks) => { let i = 0; for (const b of blocks) if (i < pts.length && b.hash === pts[i]!.hash) i++; return i === pts.length; },
            onRange: async () => {},
            onPeerFailure: (peer, _e, info) => failures.push(`${peer}:${info.malicious}`),
            onFatal: (err) => { fatal = err; },
        });
        await expect(s.submit(points).applied).rejects.toBeInstanceOf(RangeHole);
        expect(fatal).toBeInstanceOf(RangeHole);
        expect(failures).toEqual([]);
        expect(fetches).toBe(1);
    });

    test("a peer returning extra blocks that do not contain our points is still convicted", async () => {
        const points: Pt[] = [{ slot: 0n, hash: "b0" }, { slot: 1n, hash: "b1" }];
        const failures: string[] = [];
        const s = new RangeScheduler<Pt, Blk>({
            maxInFlight: 1,
            retryLimit: 1,
            pickPeers: () => ["liar"],
            fetch: async () => [{ hash: "x0" }, { hash: "x1" }, { hash: "x2" }],
            verify: () => {},
            pointsAreSubsequence: (pts, blocks) => { let i = 0; for (const b of blocks) if (i < pts.length && b.hash === pts[i]!.hash) i++; return i === pts.length; },
            onRange: async () => {},
            onPeerFailure: (peer, _e, info) => failures.push(`${peer}:${info.malicious}`),
            onFatal: () => {},
        });
        await expect(s.submit(points).applied).rejects.toBeInstanceOf(RangeMismatch);
        expect(failures).toEqual(["liar:true"]);
    });
});
