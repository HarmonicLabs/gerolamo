import { initSettings } from "../../config/settings";
import { describe, expect, test } from "bun:test";
import { ChainSelDriver, resolveChainSelection, type ChainSelDriverDeps } from "./ChainSelDriver";
import type { ChainHeader } from "./ChainSel";
import { GENESIS, growChain, incoming, prng } from "./sim";

/** A fake applied chain (the database) the driver reconciles with. */
class FakeDb {
    readonly blocks = new Map<string, ChainHeader>([[GENESIS.hash, { ...GENESIS, prevHash: null, hfcEra: 6 }]]);
    tipHash = GENESIS.hash;
    idle = new Set<string>();
    local = new Set<string>();
    big: string[] = [];
    now = 1_000_000;
    apply(hs: ChainHeader[]) { for (const h of hs) { this.blocks.set(h.hash, h); this.tipHash = h.hash; } }
    rollbackTo(hash: string) { this.tipHash = hash; }
    deps(k: number): ChainSelDriverDeps {
        return {
            k,
            tip: async () => { const t = this.blocks.get(this.tipHash)!; return { hash: t.hash, slot: t.slot, blockNo: t.blockNo, hfcEra: t.hfcEra, raw: null }; },
            block: async (h) => { const b = this.blocks.get(h); return b ? { hash: b.hash, prevHash: b.prevHash, slot: b.slot, hfcEra: b.hfcEra, raw: null, tb: b.tb ?? null } : null; },
            isOurs: async (h) => { for (let c: string | null = this.tipHash; c; c = this.blocks.get(c)?.prevHash ?? null) if (c === h) return true; return false; },
            isIdle: (p) => this.idle.has(p),
            isLocalRoot: (p) => this.local.has(p),
            slotAgeMs: (slot) => this.now - Number(slot) * 1000,
            genesisWindow: () => 600n,
            bigLedger: { bigLedgerPeers: () => this.big },
            now: () => this.now,
        };
    }
}

const vrf = (b: number) => new Uint8Array(64).fill(b);

describe("chain-selection switch (config)", () => {
    test("legacy by default; praos and genesis by config or flag", () => {
        expect(resolveChainSelection({})).toEqual({ chainSelection: "legacy", mode: "praos" });
        expect(resolveChainSelection({ consensus: { chainSelection: "praos" } })).toEqual({ chainSelection: "praos", mode: "praos" });
        expect(resolveChainSelection({ consensus: { mode: "genesis" } })).toEqual({ chainSelection: "praos", mode: "genesis" });
        expect(resolveChainSelection({ consensus: { chainSelection: "shadow", mode: "genesis" } })).toEqual({ chainSelection: "shadow", mode: "genesis" });
        initSettings({ chainSelection: "praos" }, { chainSelection: "flag" }); // --chain-selection praos
        expect(resolveChainSelection({ consensus: { chainSelection: "shadow" } }).chainSelection).toBe("praos");
        initSettings({}, { chainSelection: "default" });
    });
});

describe("ChainSelDriver (Praos mode)", () => {
    test("equal-length battle: switch when the tie-break prefers the peer's block, keep otherwise", async () => {
        const db = new FakeDb();
        const base = growChain(GENESIS, 4, { tag: "b", rng: prng(1) });
        db.apply(base);
        const ours = growChain(base[3]!, 1, { tag: "o", gap: 20, tb: [{ issuer: "x", vrfOutput: vrf(9) }] });
        db.apply(ours);
        const d = new ChainSelDriver("praos", db.deps(10));
        const better = growChain(base[3]!, 1, { tag: "w", gap: 20, tb: [{ issuer: "y", vrfOutput: vrf(1) }] });
        const worse = growChain(base[3]!, 1, { tag: "l", gap: 20, tb: [{ issuer: "z", vrfOutput: vrf(200) }] });
        await d.observe("p", [...base, ...worse].map(incoming));
        expect((await d.decide("p", ["p"])).decision.kind).toBe("keep");
        await d.observe("q", [...base, ...better].map(incoming));
        const v = await d.decide("p", ["p", "q"]);
        expect(v.decision.kind).toBe("switch");
        if (v.decision.kind === "switch") {
            expect(v.decision.candidate.peer).toBe("q");
            expect(v.decision.candidate.rollback).toBe(1);
            expect(v.decision.candidate.intersection.hash).toBe(base[3]!.hash);
        }
    });

    test("the primary on a worse fork, another peer extends our chain: promote it (no rollback)", async () => {
        const db = new FakeDb();
        const base = growChain(GENESIS, 5, { tag: "b", rng: prng(2) });
        db.apply(base);
        const d = new ChainSelDriver("praos", db.deps(10));
        const deadFork = growChain(base[2]!, 1, { tag: "dead", rng: prng(3) });
        const ext = growChain(base[4]!, 2, { tag: "ext", rng: prng(4) });
        await d.observe("primary", [...base.slice(0, 3), ...deadFork].map(incoming));
        await d.observe("good", [...base, ...ext].map(incoming));
        const v = await d.decide("primary", ["primary", "good"]);
        expect(v.decision).toMatchObject({ kind: "extend", promote: true, candidate: { peer: "good" } });
        // with the primary on our chain, a faster peer is no reason to switch primaries
        await d.observe("primary", [...base, ext[0]!].map(incoming));
        expect((await d.decide("primary", ["primary", "good"])).decision).toMatchObject({ kind: "extend", promote: false });
    });

    test("our chain follows the database: applies and rollbacks are reconciled without hooks", async () => {
        const db = new FakeDb();
        const base = growChain(GENESIS, 6, { tag: "b", rng: prng(5) });
        db.apply(base.slice(0, 3));
        const d = new ChainSelDriver("praos", db.deps(10));
        await d.observe("p", base.map(incoming));
        expect((await d.decide("p", ["p"])).decision.kind).toBe("extend");
        db.apply(base.slice(3));
        expect((await d.decide("p", ["p"])).decision.kind).toBe("keep");
        const fork = growChain(base[1]!, 6, { tag: "f", rng: prng(6) });
        db.rollbackTo(base[1]!.hash); db.apply(fork);
        await d.syncOurs();
        expect(d.cs!.ourTip().hash).toBe(fork[5]!.hash);
        // p still serves the old branch: shorter now (6 < 8), not preferable
        expect((await d.decide("p", ["p"])).decision.kind).toBe("keep");
    });

    test("an invalid block: its peers are punished and it is never selected", async () => {
        const db = new FakeDb();
        const base = growChain(GENESIS, 4, { tag: "b", rng: prng(7) });
        db.apply(base);
        const d = new ChainSelDriver("praos", db.deps(10));
        const bad = growChain(base[1]!, 5, { tag: "bad", rng: prng(8) });
        await d.observe("liar", [...base.slice(0, 2), ...bad].map(incoming));
        expect(d.markInvalid(bad[2]!.hash, "ledger rules")).toEqual(["liar"]);
        const v = await d.decide(null, ["liar"]);
        expect(v.punish).toEqual([expect.objectContaining({ peer: "liar", malicious: true })]);
        expect(v.decision.kind).toBe("keep");
    });

    test("headers whose VRF check is deferred do not count until verified", async () => {
        const db = new FakeDb();
        const base = growChain(GENESIS, 3, { tag: "b", rng: prng(9) });
        db.apply(base);
        const d = new ChainSelDriver("praos", db.deps(10));
        const fork = growChain(base[0]!, 4, { tag: "f", rng: prng(10) });
        await d.observe("p", [...base.slice(0, 1).map(incoming), ...fork.map((h, i) => ({ ...incoming(h), vrfDeferred: i >= 2 }))]);
        expect((await d.decide(null, ["p"])).decision.kind).toBe("keep"); // 1 + 2 verified = 3 = ours, tie-break keeps ours or not; never 5
        for (const h of fork) d.vrfVerified(h.hash);
        const v = await d.decide(null, ["p"]);
        expect(v.decision.kind).toBe("switch");
    });
});

describe("ChainSelDriver (Genesis mode)", () => {
    test("PreSyncing holds the selection within k of the immutable tip; HAA → Syncing; GDD drops a sparse peer; CaughtUp lifts the LoE", async () => {
        const db = new FakeDb();
        const k = 5;
        const d = new ChainSelDriver("genesis", db.deps(k), {});
        const honest = growChain(GENESIS, 40, { tag: "h", gap: 20 });
        const sparse = growChain(GENESIS, 10, { tag: "s", gap: 60 });
        const peers = ["h1", "h2", "h3", "h4", "h5"];
        for (const p of peers) await d.observe(p, honest.map(incoming));
        await d.observe("adv", sparse.map(incoming));
        db.idle.add("adv");
        let v = await d.decide("h1", [...peers, "adv"]);
        expect(d.gsmState).toBe("PreSyncing");
        expect(d.loeSlotLimit("h1")).toBe(honest[k - 1]!.slot); // at most k blocks past the immutable tip
        db.big = peers; // five active big ledger peers: the Honest Availability Assumption holds
        v = await d.decide("h1", [...peers, "adv"]);
        expect(d.gsmState).toBe("Syncing");
        expect(v.punish.map((p) => p.peer)).toContain("adv");
        expect(v.punish.find((p) => p.peer === "adv")!.malicious).toBe(false);
        d.removePeer("adv");
        // the LoE is now the honest peers' common prefix: everything they agree on may be selected
        db.now += 2000;
        await d.decide("h1", peers);
        expect(d.loeSlotLimit("h1")).toBeNull();
        // caught up: all idle, nothing better than our selection
        db.apply(honest);
        for (const p of peers) db.idle.add(p);
        db.now = Number(honest[39]!.slot) * 1000 + 10_000;
        await d.decide("h1", peers);
        expect(d.gsmState).toBe("CaughtUp");
        expect(d.loeSlotLimit("h1")).toBeNull();
    });

    test("HAA lost while Syncing → PreSyncing", async () => {
        const db = new FakeDb();
        const d = new ChainSelDriver("genesis", db.deps(5), {});
        const chain = growChain(GENESIS, 3, { tag: "c", gap: 20 });
        db.big = ["a", "b", "c", "d", "e"];
        for (const p of db.big) await d.observe(p, chain.map(incoming));
        await d.decide("a", db.big);
        expect(d.gsmState).toBe("Syncing");
        await d.decide("a", ["a", "b", "c", "d"]);
        expect(d.gsmState).toBe("PreSyncing");
    });
});

describe("ChainSelDriver (Genesis mode): ChainSync Jumping", () => {
    test("one dynamo streams; jumpers jump to its validated head; an accepted jump becomes the jumper's candidate", async () => {
        const db = new FakeDb();
        const chain = growChain(GENESIS, 60, { tag: "c", gap: 20 });
        const d = new ChainSelDriver("genesis", db.deps(10), { consensus: { csjJumpSize: 200 } });
        await d.syncOurs();
        expect(d.csjRegister("dyn")).toBe(true);
        expect(d.csjRegister("j1")).toBe(true);
        expect(d.csj!.dynamo()).toBe("dyn");
        expect(d.isJumper("j1")).toBe(true);
        expect(d.csjNextInstruction("j1").kind).toBe("wait");
        await d.observe("dyn", chain.slice(0, 15).map(incoming)); // slots 20 … 300: past the 200-slot boundary
        const instr = d.csjNextInstruction("j1");
        expect(instr.kind).toBe("jumpTo");
        if (instr.kind !== "jumpTo") return;
        const to = instr.info.headers[instr.info.headers.length - 1]!;
        expect(to.slot).toBeLessThanOrEqual(300n);
        d.csjJumpResult("j1", { accepted: true, instruction: instr });
        expect(d.cs!.fragmentOf("j1")!.headers.at(-1)!.hash).toBe(to.hash);
        expect(d.cs!.fragmentOf("j1")!.latestSlot).toBe(to.slot);
        expect(d.snapshot().csjJumps).toBe(1);
        // the dynamo has no more headers: disengaged, the jumper takes over (positioned at its last jump first)
        d.awaitReply("dyn");
        expect(d.csj!.dynamo()).toBe("j1");
        expect(d.csjNextInstruction("j1").kind).toBe("jumpToGood");
    });

    test("caught up: new peers are not managed by CSJ (normal ChainSync); CSJ off by config", async () => {
        const db = new FakeDb();
        const tip = growChain(GENESIS, 3, { tag: "t", gap: 20 });
        db.apply(tip);
        db.now = Number(tip[2]!.slot) * 1000 + 1000;
        const d = new ChainSelDriver("genesis", db.deps(5), {});
        await d.syncOurs();
        (d as any).gsm.st = "CaughtUp";
        expect(d.csjRegister("p")).toBe(false);
        expect(new ChainSelDriver("genesis", db.deps(5), { consensus: { csj: false } }).csj).toBeNull();
        expect(new ChainSelDriver("praos", db.deps(5), {}).csj).toBeNull();
    });
});
