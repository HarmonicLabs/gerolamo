import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/slot-battle-123773790.json";
import { ChainSel, type ChainHeader } from "./ChainSel";
import { GENESIS, SimNode, growChain, incoming, prng } from "./sim";

const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const vrf = (b: number) => new Uint8Array(64).fill(b);

describe("ChainSel: longest chain within k", () => {
    test("a longer fork within k replaces our chain; a shorter one does not", () => {
        const node = new SimNode(10);
        const base = growChain(GENESIS, 5, { tag: "base", rng: prng(1) });
        node.connect("a"); node.feed("a", base); node.settle();
        expect(node.tip().hash).toBe(base[4]!.hash);
        const forkLong = growChain(base[2]!, 4, { tag: "long", rng: prng(2) }); // height 7 > 5
        const forkShort = growChain(base[2]!, 1, { tag: "short", rng: prng(3) }); // height 4 < 5
        node.connect("b", base[2]); node.feed("b", forkShort);
        node.connect("c", base[2]); node.feed("c", forkLong);
        node.settle();
        expect(node.tip().hash).toBe(forkLong[3]!.hash);
        expect(node.rollbacks).toEqual([2]);
        expect(node.tip().blockNo).toBe(7n);
    });

    test("a fork deeper than k is never selected and its peer is disconnected (ForkTooDeep)", () => {
        const k = 5;
        const node = new SimNode(k);
        const base = growChain(GENESIS, 12, { tag: "base", rng: prng(4) });
        node.connect("a"); node.feed("a", base); node.settle();
        const deep = growChain(base[3]!, 30, { tag: "deep", rng: prng(5) }); // forks 8 blocks back, much longer
        node.connect("evil", base[3]);
        node.feed("evil", deep);
        node.settle();
        expect(node.tip().hash).toBe(base[11]!.hash);
        expect(node.disconnected.get("evil")).toContain("fork too deep");
    });

    test("a fork exactly k deep is still eligible", () => {
        const k = 5;
        const node = new SimNode(k);
        const base = growChain(GENESIS, 12, { tag: "base", rng: prng(6) });
        node.connect("a"); node.feed("a", base); node.settle();
        const fork = growChain(base[6]!, 6, { tag: "kdeep", rng: prng(7) }); // our blocks 7..11 (5 = k) roll back
        node.connect("b", base[6]); node.feed("b", fork); node.settle();
        expect(node.tip().hash).toBe(fork[5]!.hash);
        expect(node.rollbacks).toEqual([5]);
    });
});

describe("ChainSel: equal length, Praos tie-break (consensus 3.0 comparePraos)", () => {
    function battle(era: number, oursTb: object, candTb: object, oursGap: number, candGap: number) {
        const node = new SimNode(20);
        const base = growChain(GENESIS, 3, { tag: "base", rng: prng(8), era });
        node.connect("a"); node.feed("a", base);
        const ours = growChain(base[2]!, 1, { tag: "ours", era, gap: oursGap, tb: [oursTb] });
        node.feed("a", ours); node.settle();
        expect(node.tip().hash).toBe(ours[0]!.hash);
        const cand = growChain(base[2]!, 1, { tag: "cand", era, gap: candGap, tb: [candTb] });
        node.connect("b", base[2]); node.feed("b", cand); node.settle();
        return node.tip().hash === cand[0]!.hash ? "switched" : "kept";
    }

    test("same slot, different pools: the lower VRF output wins", () => {
        expect(battle(6, { issuer: "x", vrfOutput: vrf(9) }, { issuer: "y", vrfOutput: vrf(3) }, 10, 10)).toBe("switched");
        expect(battle(6, { issuer: "x", vrfOutput: vrf(3) }, { issuer: "y", vrfOutput: vrf(9) }, 10, 10)).toBe("kept");
    });

    test("identical tie-break values: keep our chain", () => {
        expect(battle(6, { issuer: "x", vrfOutput: vrf(3) }, { issuer: "y", vrfOutput: vrf(3) }, 10, 10)).toBe("kept");
    });

    test("Conway restricted VRF: tips more than 5 slots apart are not compared (keep ours)", () => {
        expect(battle(6, { issuer: "x", vrfOutput: vrf(9) }, { issuer: "y", vrfOutput: vrf(3) }, 10, 16)).toBe("kept"); // 6 slots apart
        expect(battle(6, { issuer: "x", vrfOutput: vrf(9) }, { issuer: "y", vrfOutput: vrf(3) }, 10, 15)).toBe("switched"); // 5 slots apart
        expect(battle(6, { issuer: "x", vrfOutput: vrf(9) }, { issuer: "y", vrfOutput: vrf(3) }, 16, 10)).toBe("kept"); // earlier candidate, 6 apart
    });

    test("Babbage (unrestricted): the VRF decides at any slot distance", () => {
        expect(battle(5, { issuer: "x", vrfOutput: vrf(9) }, { issuer: "y", vrfOutput: vrf(3) }, 10, 500)).toBe("switched");
    });

    test("same issuer, same slot: the higher opcert issue number wins over the VRF", () => {
        expect(battle(6, { issuer: "p", opcertCounter: 4n, vrfOutput: vrf(1) }, { issuer: "p", opcertCounter: 5n, vrfOutput: vrf(200) }, 10, 10)).toBe("switched");
        expect(battle(6, { issuer: "p", opcertCounter: 5n, vrfOutput: vrf(200) }, { issuer: "p", opcertCounter: 4n, vrfOutput: vrf(1) }, 10, 10)).toBe("kept");
    });

    test("same issuer, different slots: the opcert rule is not armed, the VRF decides (if armed)", () => {
        expect(battle(6, { issuer: "p", opcertCounter: 9n, vrfOutput: vrf(200) }, { issuer: "p", opcertCounter: 4n, vrfOutput: vrf(1) }, 10, 12)).toBe("switched");
    });

    test("real preview slot battle 123 773 790: the network's block wins in either arrival order", () => {
        const w = bytes(fixture.winner.header), l = bytes(fixture.loser.header);
        for (const order of [["w", "l"], ["l", "w"]] as const) {
            const cs = new ChainSel({ k: 432, anchor: { hash: "11".repeat(32), slot: 123773700n, blockNo: 100n } });
            const mk = (raw: Uint8Array, hash: string): ChainHeader => ({ hash, prevHash: "11".repeat(32), slot: 123773790n, blockNo: 101n, hfcEra: 6, raw });
            const hw = mk(w, fixture.winner.hash), hl = mk(l, fixture.loser.hash);
            const first = order[0] === "w" ? hw : hl, second = order[0] === "w" ? hl : hw;
            cs.extendOurs(incoming(first));
            cs.addPeer("p", { hash: "11".repeat(32), slot: 123773700n, blockNo: 100n });
            cs.rollForward("p", incoming(second));
            const r = cs.select();
            if (first === hw) expect(r.best).toBeNull();
            else { expect(r.best?.tip.hash).toBe(fixture.winner.hash); expect(r.best?.reason.kind).toBe("tiebreak"); }
        }
    });
});

describe("ChainSel: invalid blocks", () => {
    test("an invalid block on the longer fork is remembered, its peers dropped, and we return to the valid chain", () => {
        const node = new SimNode(20);
        const base = growChain(GENESIS, 6, { tag: "base", rng: prng(10) });
        node.connect("honest"); node.feed("honest", base); node.settle();
        const bad = growChain(base[3]!, 5, { tag: "bad", rng: prng(11) }); // height 9
        node.invalidBlocks.add(bad[1]!.hash);
        node.connect("liar", base[3]); node.feed("liar", bad);
        node.connect("parrot", base[3]); node.feed("parrot", bad.slice(0, 3)); // relays the invalid block too
        node.settle();
        expect(node.disconnected.has("liar")).toBe(true);
        expect(node.disconnected.has("parrot")).toBe(true);
        expect(node.cs.isInvalid(bad[1]!.hash)).toBe("ledger rules");
        // the first bad-fork block was valid and is as long as nothing better: we still must end on the longest *valid* chain
        expect(node.tip().blockNo).toBe(6n);
        expect(node.tip().hash).toBe(base[5]!.hash);
        // a newcomer offering the same invalid chain is punished on sight
        node.connect("late", base[3]); node.feed("late", bad);
        const r = node.cs.select();
        expect(r.punish.map((p) => p.peer)).toContain("late");
    });
});

describe("ChainSel: peers across our rollbacks", () => {
    test("a peer on the chain we left keeps its candidate (re-anchored at our new tip)", () => {
        const cs = new ChainSel({ k: 10, anchor: GENESIS });
        const base = growChain(GENESIS, 6, { tag: "base", rng: prng(12) });
        cs.addPeer("a");
        for (const h of base) { cs.rollForward("a", incoming(h)); cs.extendOurs(incoming(h)); }
        expect(cs.select().best).toBeNull();
        cs.rollbackOursTo(base[2]!.hash);
        const r = cs.select();
        expect(r.best?.peer).toBe("a");
        expect(r.best?.suffix.map((h) => h.hash)).toEqual(base.slice(3).map((h) => h.hash));
        expect(r.best?.rollback).toBe(0);
    });

    test("the immutable tip follows k blocks behind and fragments are normalised onto it", () => {
        const cs = new ChainSel({ k: 3, anchor: GENESIS });
        const base = growChain(GENESIS, 8, { tag: "base", rng: prng(13) });
        cs.addPeer("a");
        for (const h of base) cs.rollForward("a", incoming(h));
        for (const h of base.slice(0, 7)) cs.extendOurs(incoming(h));
        expect(cs.immutableTip().hash).toBe(base[3]!.hash);
        expect(cs.ourChain().length).toBe(3);
        expect(cs.fragmentOf("a")!.headers.map((h) => h.hash)).toEqual([base[7]!.hash]);
    });

    test("block numbers are derived from the chain, not taken from the peer", () => {
        const cs = new ChainSel({ k: 10, anchor: { hash: "aa".repeat(32), slot: 100n, blockNo: 50n } });
        cs.addPeer("p");
        cs.rollForward("p", { hash: "bb".repeat(32), prevHash: "aa".repeat(32), slot: 101n, hfcEra: 6, tb: null });
        cs.rollForward("p", { hash: "cc".repeat(32), prevHash: "bb".repeat(32), slot: 102n, hfcEra: 6, tb: null });
        expect(cs.select().best?.tip.blockNo).toBe(52n);
    });

    test("RollBackward truncates the candidate", () => {
        const cs = new ChainSel({ k: 10, anchor: GENESIS });
        const base = growChain(GENESIS, 5, { tag: "base", rng: prng(14) });
        cs.addPeer("p");
        for (const h of base) cs.rollForward("p", incoming(h));
        cs.rollBackward("p", { hash: base[1]!.hash, slot: base[1]!.slot });
        expect(cs.select().best?.tip.hash).toBe(base[1]!.hash);
    });
});

describe("ChainSel: Limit on Eagerness", () => {
    test("with the LoE at our immutable tip the selection extends it by at most k blocks", () => {
        const k = 4;
        const node = new SimNode(k);
        const chain = growChain(GENESIS, 20, { tag: "c", rng: prng(15) });
        node.connect("p"); node.feed("p", chain);
        node.settle({ loe: GENESIS });
        expect(node.tip().blockNo).toBe(4n);
        // LoE advances with the candidates' common prefix
        node.settle({ loe: chain[9]! });
        expect(node.tip().blockNo).toBe(14n);
    });

    test("a candidate that diverges before the LoE tip is cut at the divergence", () => {
        const k = 4;
        const cs = new ChainSel({ k, anchor: GENESIS });
        const a = growChain(GENESIS, 3, { tag: "a", rng: prng(16) });
        for (const h of a) cs.extendOurs(incoming(h));
        const fork = growChain(a[0]!, 6, { tag: "f", rng: prng(17) });
        cs.addPeer("p", a[0]); for (const h of fork) cs.rollForward("p", incoming(h));
        expect(cs.select({ loe: a[2]! }).best).toBeNull(); // LoE tip is on our branch beyond the fork point
        expect(cs.select({ loe: null }).best?.peer).toBe("p");
    });
});

describe("ChainSel simulator: randomized forks settle on the best eligible chain", () => {
    test("200 random scenarios", () => {
        for (let seed = 1; seed <= 200; seed++) {
            const rng = prng(seed);
            const k = 3 + Math.floor(rng() * 8);
            const node = new SimNode(k);
            const trunk = growChain(GENESIS, 20 + Math.floor(rng() * 20), { tag: `t${seed}`, rng });
            node.connect("trunk"); node.feed("trunk", trunk); node.settle();
            const ourTipNo = node.tip().blockNo;
            const offers: Array<{ peer: string; forkDepth: number; tip: ChainHeader }> = [];
            const peers = 1 + Math.floor(rng() * 5);
            for (let p = 0; p < peers; p++) {
                const depth = Math.floor(rng() * (2 * k));
                const forkAt = trunk[trunk.length - 1 - depth]!;
                const len = Math.floor(rng() * (depth + 4));
                const fork = growChain(forkAt, len, { tag: `f${seed}p${p}`, rng, era: 6, gap: 1 + Math.floor(rng() * 3) });
                if (!fork.length) continue;
                node.connect(`p${p}`, forkAt); node.feed(`p${p}`, fork);
                offers.push({ peer: `p${p}`, forkDepth: depth, tip: fork[fork.length - 1]! });
            }
            node.settle();
            const eligible = offers.filter((o) => o.forkDepth <= k);
            const bestLen = eligible.reduce((m, o) => (o.tip.blockNo > m ? o.tip.blockNo : m), ourTipNo);
            expect(node.tip().blockNo).toBe(bestLen);
            for (const o of offers) if (o.forkDepth > k && o.tip.blockNo > ourTipNo) expect(node.disconnected.has(o.peer)).toBe(true);
            // never rolled back more than k
            for (const r of node.rollbacks) expect(r).toBeLessThanOrEqual(k);
        }
    });
});

describe("ChainSel: the origin (bug 401)", () => {
    // A Shelley-based chain's first block has no parent hash; ChainSync rolls a fresh client back to
    // the origin point (no hash). Both used to leave the peer's fragment detached, so nothing could
    // be selected from an empty chain.
    const origin = { hash: "00".repeat(32), slot: 0n, blockNo: 0n };
    const hdr = (n: number, prev: string | null) => ({ hash: n.toString(16).padStart(64, "0"), prevHash: prev, slot: BigInt(n * 3), hfcEra: 6 });

    test("headers from genesis (prev hash null) form a candidate anchored at the origin", () => {
        const cs = new ChainSel({ k: 5, anchor: origin });
        cs.addPeer("a");
        cs.rollBackward("a", { hash: null, slot: 0n });
        cs.rollForward("a", hdr(1, null));
        cs.rollForward("a", hdr(2, hdr(1, null).hash));
        const r = cs.select();
        expect(r.status.get("a")?.kind).toBe("preferable");
        expect(r.best?.intersection.hash).toBe(origin.hash);
        expect(r.best?.suffix.map((h) => h.hash)).toEqual([hdr(1, null).hash, hdr(2, null).hash]);
    });

    test("a RollBackward to the origin re-anchors a peer that had headers; a hashless rollback elsewhere still detaches", () => {
        const cs = new ChainSel({ k: 5, anchor: origin });
        cs.rollForward("a", hdr(1, null));
        cs.rollBackward("a", { hash: null, slot: 0n });
        expect(cs.fragmentOf("a")).toEqual({ anchor: origin, headers: [], latestSlot: 3n });
        cs.rollForward("a", hdr(1, null));
        cs.rollBackward("a", { hash: null, slot: 3n });
        expect(cs.fragmentOf("a")!.anchor).toBeNull();
    });
});
