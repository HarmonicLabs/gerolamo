import { describe, expect, test } from "bun:test";
import { densityDisconnect, genesisWindowFor, sharedCandidatePrefix, type GddPeerState } from "./gdd";
import { GenesisStateMachine, honestAvailability } from "./gsm";
import { GENESIS, SimNode, growChain, prng } from "../chainsel/sim";
import type { ChainHeader } from "../chainsel/ChainSel";

function gdd(node: SimNode, sgen: bigint, k: number, idle: Record<string, boolean>, latest?: Record<string, bigint>) {
    const cands = new Map<string, ChainHeader[] | null>();
    for (const p of node.cs.peerKeys()) cands.set(p, node.cs.candidateFromImmutable(p));
    const { loe, suffixes } = sharedCandidatePrefix(cands);
    const imm = node.cs.immutableTip();
    const loeTip = loe.length ? { hash: loe[loe.length - 1]!.hash, slot: loe[loe.length - 1]!.slot } : { hash: imm.hash, slot: imm.slot };
    const states = new Map<string, GddPeerState>();
    for (const p of node.cs.peerKeys()) states.set(p, { latestSlot: latest?.[p] ?? node.cs.fragmentOf(p)?.latestSlot ?? null, idling: idle[p] ?? false });
    return { loe, loeTip, ...densityDisconnect(sgen, k, states, suffixes, loeTip) };
}

describe("Genesis Density Disconnector", () => {
    test("the LoE fragment is the common prefix of all candidates", () => {
        const node = new SimNode(50);
        const trunk = growChain(GENESIS, 10, { tag: "t", rng: prng(1) });
        const a = growChain(trunk[9]!, 5, { tag: "a", rng: prng(2) });
        const b = growChain(trunk[6]!, 5, { tag: "b", rng: prng(3) });
        node.connect("a"); node.feed("a", [...trunk, ...a]);
        node.connect("b"); node.feed("b", [...trunk.slice(0, 7), ...b]);
        const r = gdd(node, 1000n, 50, {});
        expect(r.loe.map((h) => h.hash)).toEqual(trunk.slice(0, 7).map((h) => h.hash));
    });

    test("an adversarial chain sparser than the honest one in the Genesis window is disconnected", () => {
        const k = 10, sgen = 600n;
        const node = new SimNode(k);
        const honest = growChain(GENESIS, 60, { tag: "h", gap: 20 }); // one block per 20 slots
        const sparse = growChain(GENESIS, 15, { tag: "s", gap: 50 }); // one per 50 slots, all sent
        node.connect("honest"); node.feed("honest", honest);
        node.connect("adv"); node.feed("adv", sparse);
        const r = gdd(node, sgen, k, { adv: true });
        expect(r.losing).toEqual(["adv"]);
        expect(r.bounds.get("honest")!.offersMoreThanK).toBe(true);
        expect(r.bounds.get("adv")!.lowerBound).toBe(12n); // slots 50..600 inside the window
        expect(r.bounds.get("honest")!.lowerBound).toBe(30n);
    });

    test("an adversary that stalls (idle, few headers) loses even with a longer total chain promised", () => {
        const k = 10, sgen = 600n;
        const node = new SimNode(k);
        const honest = growChain(GENESIS, 40, { tag: "h", gap: 20 });
        const stall = growChain(GENESIS, 3, { tag: "st", gap: 20 });
        node.connect("honest"); node.feed("honest", honest);
        node.connect("staller"); node.feed("staller", stall);
        const r = gdd(node, sgen, k, { staller: true });
        expect(r.losing).toEqual(["staller"]);
    });

    test("a peer that has not sent a header after the intersection and is not idle is kept (Note [Chain disagreement])", () => {
        const k = 10, sgen = 600n;
        const node = new SimNode(k);
        const honest = growChain(GENESIS, 40, { tag: "h", gap: 20 });
        node.connect("honest"); node.feed("honest", honest);
        node.connect("quiet"); // nothing yet, latestSlot set by a header still being validated
        const r = gdd(node, sgen, k, {}, { quiet: 5n });
        expect(r.losing).toEqual([]);
    });

    test("the honest (densest) peer is never disconnected, whatever the adversaries do (random)", () => {
        for (let seed = 1; seed <= 100; seed++) {
            const rng = prng(seed);
            const k = 5 + Math.floor(rng() * 10), sgen = BigInt(20 * k * 3);
            const node = new SimNode(k);
            const honest = growChain(GENESIS, 3 * k + 5, { tag: `h${seed}`, gap: 20 });
            node.connect("honest"); node.feed("honest", honest);
            const idle: Record<string, boolean> = { honest: rng() < 0.5 };
            for (let a = 0; a < 4; a++) {
                const forkAt = honest[Math.floor(rng() * 3)]!;
                const adv = growChain(forkAt, Math.floor(rng() * 3 * k), { tag: `a${seed}${a}`, gap: 21 + Math.floor(rng() * 40) });
                node.connect(`adv${a}`, forkAt); node.feed(`adv${a}`, adv);
                idle[`adv${a}`] = rng() < 0.5;
            }
            const r = gdd(node, sgen, k, idle);
            expect(r.losing).not.toContain("honest");
        }
    });

    test("genesis window: 3k/f in Shelley-based eras, 2k in Byron", () => {
        expect(genesisWindowFor(false, 2160, 0.05)).toBe(129600n);
        expect(genesisWindowFor(false, 432, 0.05)).toBe(25920n);
        expect(genesisWindowFor(true, 2160, 0.05)).toBe(4320n);
    });
});

describe("Genesis State Machine", () => {
    const view = (o: Partial<Parameters<GenesisStateMachine["step"]>[0]> = {}) => ({ haa: false, peers: 3, allIdle: false, anyCandidateBetter: true, tipAgeMs: 1e9, ...o });

    test("PreSyncing → Syncing on HAA, back on HAA loss, CaughtUp when idle with no better candidate", () => {
        const seen: string[] = [];
        const g = new GenesisStateMachine("PreSyncing", { maxBonusMs: 0, onTransition: (a, b) => seen.push(`${a}>${b}`) }, 0);
        expect(g.step(view(), 1)).toBe("PreSyncing");
        expect(g.step(view({ haa: true }), 2)).toBe("Syncing");
        expect(g.step(view({ haa: false }), 3)).toBe("PreSyncing");
        g.step(view({ haa: true }), 4);
        expect(g.step(view({ haa: true, allIdle: true, anyCandidateBetter: true }), 5)).toBe("Syncing");
        expect(g.step(view({ haa: true, allIdle: true, anyCandidateBetter: false, peers: 0 }), 6)).toBe("Syncing");
        expect(g.step(view({ haa: true, allIdle: true, anyCandidateBetter: false }), 7)).toBe("CaughtUp");
        expect(seen).toEqual(["PreSyncing>Syncing", "Syncing>PreSyncing", "PreSyncing>Syncing", "Syncing>CaughtUp"]);
    });

    test("CaughtUp stays at least minCaughtUpDuration, then leaves when the tip is too old", () => {
        const g = new GenesisStateMachine("Syncing", { maxCaughtUpAgeMs: 1000, maxBonusMs: 0 }, 0);
        g.step(view({ haa: true, allIdle: true, anyCandidateBetter: false }), 0);
        expect(g.state).toBe("CaughtUp");
        expect(g.step(view({ tipAgeMs: 5000 }), 500)).toBe("CaughtUp"); // within the minimum stay
        expect(g.step(view({ tipAgeMs: 999 }), 1500)).toBe("CaughtUp");
        expect(g.step(view({ tipAgeMs: 1000 }), 1600)).toBe("PreSyncing");
    });

    test("anti-thundering-herd bonus delays leaving CaughtUp by up to 300 s", () => {
        const g = new GenesisStateMachine("CaughtUp", { maxCaughtUpAgeMs: 1200_000, rng: () => 0.999 }, 0);
        expect(g.step(view({ tipAgeMs: 1200_000 + 299_000 }), 10)).toBe("CaughtUp");
        expect(g.step(view({ tipAgeMs: 1200_000 + 300_000 }), 11)).toBe("PreSyncing");
    });

    test("initial state from the marker file", () => {
        expect(GenesisStateMachine.initialState(true, 60_000)).toBe("CaughtUp");
        expect(GenesisStateMachine.initialState(true, 21 * 60_000)).toBe("PreSyncing");
        expect(GenesisStateMachine.initialState(false, 0)).toBe("PreSyncing");
    });

    test("HAA: five active big ledger peers, or only trusted local roots", () => {
        expect(honestAvailability({ activeBigLedgerPeers: 4, onlyTrustedLocalRoots: false })).toBe(false);
        expect(honestAvailability({ activeBigLedgerPeers: 5, onlyTrustedLocalRoots: false })).toBe(true);
        expect(honestAvailability({ activeBigLedgerPeers: 0, onlyTrustedLocalRoots: true })).toBe(true);
    });
});
