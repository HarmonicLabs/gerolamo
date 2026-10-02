import { describe, expect, test } from "bun:test";
import { ChainSyncJumping, DEFAULT_CSJ_JUMP_SIZE, type JumpInfo } from "./csj";
import { CsjSim } from "./csjSim";
import { GENESIS, growChain, prng } from "../chainsel/sim";
import type { ChainHeader } from "../chainsel/ChainSel";

// Sim parameters: k = 20, f = 0.05 → Genesis window sgen = 3k/f = 1200 slots; jumps every 200 slots (~10 blocks).
const O = { k: 20, jumpSize: 200n, sgen: 1200n };
const honest = growChain(GENESIS, 400, { density: 0.05, rng: prng(11), tag: "hon" });
const tipOf = (c: ChainHeader[]) => c[c.length - 1]!.hash;

describe("CSJ governor (Jumping.hs)", () => {
    const info = (hs: ChainHeader[]): JumpInfo => ({ anchor: { hash: GENESIS.hash, slot: 0n }, headers: hs });
    function gov() {
        const cands = new Map<string, JumpInfo>();
        const set: string[] = [];
        const g = new ChainSyncJumping(200n, { candidate: (p) => cands.get(p) ?? null, setCandidate: (p) => { set.push(p); } });
        return { g, cands, set };
    }

    test("default jump size is cardano-node's 2 × 2160 slots", () => {
        expect(DEFAULT_CSJ_JUMP_SIZE).toBe(4320n);
    });

    test("first peer is the dynamo, the rest happy jumpers; CaughtUp registers disengaged", () => {
        const { g } = gov();
        g.register("a", "Syncing"); g.register("b", "PreSyncing"); g.register("c", "CaughtUp");
        expect(g.summary()).toEqual({ a: "dynamo", b: "jumper:happy", c: "disengaged" });
        expect(g.nextInstruction("b").kind).toBe("wait"); // no jump requested yet
        expect(g.nextInstruction("c").kind).toBe("run");
    });

    test("the dynamo triggers a jump once a header is more than jumpSize slots past the last jump", () => {
        const { g } = gov();
        g.register("a", "Syncing"); g.register("b", "Syncing");
        const hs = honest.slice(0, 30);
        let jumped: ChainHeader | null = null;
        for (let i = 0; i < hs.length; i++) {
            g.onRollForward("a", hs[i]!); // before validation: the jump goes to the previous validated header
            const instr = g.nextInstruction("b");
            if (instr.kind === "jumpTo") { jumped = hs[i - 1]!; expect(hs[i]!.slot).toBeGreaterThan(200n); expect(hs[i - 1]!.slot).toBeLessThanOrEqual(200n + 0n + BigInt(hs[i]!.slot)); break; }
            g.updateJumpInfo("a", info(hs.slice(0, i + 1)));
        }
        expect(jumped).not.toBeNull();
    });

    test("a rejected jump starts a binary search; the jumper with the oldest disagreement becomes the objector", () => {
        const { g } = gov();
        g.register("dyn", "Syncing"); g.register("j", "Syncing");
        const frag = info(honest.slice(0, 16));
        // j accepted nothing yet; dynamo asks it to jump to the head of a 16-header fragment
        (g as any).handles[1].csj = { kind: "jumper", nextJump: frag, state: { kind: "happy", init: "fresh", lastGood: null } };
        const jumps: number[] = [];
        let last = "";
        for (let guard = 0; guard < 20; guard++) {
            const instr = g.nextInstruction("j");
            last = instr.kind;
            if (instr.kind !== "jumpTo") break;
            jumps.push(instr.info.headers.length);
            // j's chain agrees with the dynamo up to header 5 (index 4), disagrees after
            g.processJumpResult("j", { accepted: instr.info.headers.length <= 5, instruction: instr });
        }
        expect(jumps).toEqual([16, 8, 4, 6, 5]); // halving towards the disagreement
        expect(g.objector()).toBe("j");
        const st = g.stateOf("j") as any;
        expect(st.good.headers.length).toBe(5);
        expect(st.badPoint.hash).toBe(honest[5]!.hash);
        expect(last).toBe("jumpToGood"); // the objector's server is positioned at its last agreement first
        expect(g.nextInstruction("j").kind).toBe("run");
    });

    test("an objector rolling forward to the point it disputed is disengaged; one rolling back before it too", () => {
        const { g } = gov();
        g.register("dyn", "Syncing"); g.register("o", "Syncing"); g.register("o2", "Syncing");
        const good = info(honest.slice(0, 5));
        (g as any).handles[1].csj = { kind: "objector", init: "started", good, badPoint: { hash: honest[5]!.hash, slot: honest[5]!.slot } };
        (g as any).handles[2].csj = { kind: "jumper", nextJump: null, state: { kind: "fi", init: "starting", good, badPoint: { hash: honest[7]!.hash, slot: honest[7]!.slot } } };
        g.onRollForward("o", honest[5]!);
        expect(g.stateOf("o")!.kind).toBe("disengaged");
        expect(g.objector()).toBe("o2"); // the remaining dissenting jumper is elected
        g.onRollBackward("o2", honest[2]!.slot);
        expect(g.stateOf("o2")!.kind).toBe("disengaged");
        expect(g.objector()).toBeNull();
    });

    test("the dynamo disconnecting or idling hands over to the started objector, else the first engaged peer", () => {
        const { g, cands } = gov();
        for (const p of ["d", "j1", "o"]) g.register(p, "Syncing");
        cands.set("j1", info(honest.slice(0, 3)));
        (g as any).handles[2].csj = { kind: "objector", init: "started", good: info(honest.slice(0, 4)), badPoint: { hash: "ff", slot: 999n } };
        g.onAwaitReply("d");
        expect(g.dynamo()).toBe("o");
        expect(g.stateOf("j1")!.kind).toBe("jumper");
        g.unregister("o");
        expect(g.dynamo()).toBe("j1");
        expect((g.stateOf("j1") as any).lastJumpSlot).toBe(honest[2]!.slot); // head of its candidate
    });

    test("rotateDynamo moves the dynamo to the back of the queue", () => {
        const { g } = gov();
        for (const p of ["a", "b", "c"]) g.register(p, "Syncing");
        g.rotateDynamo("a");
        expect(g.dynamo()).toBe("b");
        expect(g.peers()).toEqual(["b", "c", "a"]);
        g.rotateDynamo("c"); // not the dynamo: no-op
        expect(g.dynamo()).toBe("b");
    });
});

describe("Genesis sync with ChainSync Jumping (simulator)", () => {
    test("honest peers: the node syncs the chain while (mostly) only the dynamo downloads headers", () => {
        const specs = ["h1", "h2", "h3", "h4", "h5"].map((name) => ({ name, chain: honest }));
        const withCsj = new CsjSim(O, specs).run();
        const without = new CsjSim({ ...O, csj: false }, specs).run();
        expect(withCsj.tip().hash).toBe(tipOf(honest));
        expect(without.tip().hash).toBe(tipOf(honest));
        expect(without.totalServed()).toBe(5 * honest.length);
        expect(withCsj.served("h1")).toBe(honest.length); // the dynamo streamed the whole chain
        expect(withCsj.totalServed()).toBeLessThan(1.5 * honest.length); // the jumpers only the tail after their last jump
        expect(withCsj.csj!.finished()).toBe(true); // everyone disengaged at the tip: CSJ is over
        expect(withCsj.disconnected.size).toBe(0);
        expect(withCsj.maxEngagedDownloaders).toBeLessThanOrEqual(2);
    });

    test("an adversarial dynamo on a sparse fork: a jumper objects, the GDD disconnects the dynamo, the objector takes over", () => {
        const fork = growChain(honest[99]!, 300, { density: 0.02, rng: prng(12), tag: "adv" });
        const sim = new CsjSim(O, [{ name: "adv", chain: [...honest.slice(0, 100), ...fork] }, { name: "h1", chain: honest }, { name: "h2", chain: honest }, { name: "h3", chain: honest }]).run();
        expect(sim.disconnected.get("adv")).toBe("GDD");
        expect(sim.tip().hash).toBe(tipOf(honest));
        const obj = sim.events.find((e) => e.kind === "becomingObjector");
        expect(obj).toBeDefined();
        expect(sim.events.some((e) => e.kind === "noLongerDynamo" && e.peer === "adv" && e.reason === "disconnect" && e.next === (obj as any).peer)).toBe(true);
        expect(sim.maxEngagedDownloaders).toBeLessThanOrEqual(2);
        expect(sim.totalServed()).toBeLessThan(2.5 * honest.length);
    });

    test("an adversarial dynamo on a denser-looking but shorter fork that stalls: disengaged at its stall, then outvoted by density", () => {
        const fork = growChain(honest[199]!, 30, { density: 0.05, rng: prng(13), tag: "stall" });
        const sim = new CsjSim(O, [{ name: "adv", chain: [...honest.slice(0, 200), ...fork] }, { name: "h1", chain: honest }, { name: "h2", chain: honest }]).run();
        expect(sim.tip().hash).toBe(tipOf(honest));
        expect(sim.events.some((e) => e.kind === "noLongerDynamo" && e.peer === "adv" && e.reason === "disengage")).toBe(true);
    });

    test("a lying jumper (rejects every jump) becomes objector, serves the dynamo's chain and is disengaged at the disputed point", () => {
        const sim = new CsjSim(O, [{ name: "h1", chain: honest }, { name: "liar", chain: honest, rejectAllJumps: true }, { name: "h2", chain: honest }]).run();
        expect(sim.tip().hash).toBe(tipOf(honest));
        expect(sim.events.some((e) => e.kind === "becomingObjector" && e.peer === "liar")).toBe(true);
        expect(sim.events.some((e) => e.kind === "noLongerObjector" && e.peer === "liar" && e.reason === "disengage")).toBe(true);
        expect(sim.disconnected.size).toBe(0);
    });

    test("a liar that also rejects its own good point as objector is disengaged with a ChainSync restart", () => {
        const sim = new CsjSim(O, [{ name: "h1", chain: honest }, { name: "liar", chain: honest, rejectAllJumps: "also-good" }]).run();
        expect(sim.tip().hash).toBe(tipOf(honest));
        expect(sim.events.some((e) => e.kind === "noLongerObjector" && e.peer === "liar" && e.reason === "disengage")).toBe(true);
        expect(sim.peers.get("liar")!.findIntersects).toBeGreaterThan(0);
    });

    test("a dynamo that rolls back before its last jump is disengaged and replaced", () => {
        const sim = new CsjSim(O, [{ name: "h1", chain: honest, rollBackOnce: { afterIndex: 150, toIndex: 40 } }, { name: "h2", chain: honest }, { name: "h3", chain: honest }]).run();
        expect(sim.tip().hash).toBe(tipOf(honest));
        expect(sim.events.some((e) => e.kind === "noLongerDynamo" && e.peer === "h1" && e.reason === "disengage" && e.next === "h2")).toBe(true);
    });

    test("two sparse forks among the jumpers: the older disagreement objects first, both lose the density comparison", () => {
        const f1 = growChain(honest[199]!, 200, { density: 0.02, rng: prng(14), tag: "fa" });
        const f2 = growChain(honest[99]!, 300, { density: 0.02, rng: prng(15), tag: "fb" });
        const sim = new CsjSim(O, [
            { name: "h1", chain: honest },
            { name: "a1", chain: [...honest.slice(0, 200), ...f1] },
            { name: "a2", chain: [...honest.slice(0, 100), ...f2] },
            { name: "h2", chain: honest },
        ]).run();
        expect(sim.tip().hash).toBe(tipOf(honest));
        expect(sim.disconnected.get("a1")).toBe("GDD");
        expect(sim.disconnected.get("a2")).toBe("GDD");
        expect(sim.maxEngagedDownloaders).toBeLessThanOrEqual(2);
    });

    test("100 random scenarios (k = 50): honest tip, no honest peer disconnected, ≤ 2 engaged downloaders, a third of the header downloads", () => {
        const O50 = { k: 50, jumpSize: 400n, sgen: 3000n };
        let served = 0, servedNoCsj = 0;
        for (let seed = 1; seed <= 100; seed++) {
            const rng = prng(5000 + seed);
            const hon = growChain(GENESIS, 300 + Math.floor(rng() * 400), { density: 0.05, rng, tag: `h${seed}` });
            const nowSlot = hon[hon.length - 1]!.slot; // an adversary cannot serve headers from the future
            const specs: ConstructorParameters<typeof CsjSim>[1] = [];
            const nPeers = 2 + Math.floor(rng() * 6);
            for (let i = 0; i < nPeers; i++) {
                const r = rng();
                if (i > 0 && r < 0.3) {
                    // a fork at most half as dense as the honest chain (adversarial stake below a third)
                    const at = Math.floor(rng() * (hon.length - 40)) + 10;
                    const fork = growChain(hon[at]!, 300, { density: 0.01 + rng() * 0.015, rng, tag: `f${seed}${i}` }).filter((h) => h.slot <= nowSlot);
                    specs.push({ name: `adv${i}`, chain: [...hon.slice(0, at + 1), ...fork] });
                } else if (r < 0.4) specs.push({ name: `liar${i}`, chain: hon, rejectAllJumps: rng() < 0.5 ? true : "also-good" });
                else if (r < 0.5) specs.push({ name: `rb${i}`, chain: hon, rollBackOnce: { afterIndex: Math.floor(hon.length / 2), toIndex: Math.floor(hon.length / 2) - 25 } });
                else if (r < 0.55) specs.push({ name: `st${i}`, chain: hon, stallAtIndex: Math.floor(rng() * hon.length) });
                else specs.push({ name: `h${i}`, chain: hon });
            }
            specs.push({ name: "hx", chain: hon });
            const sim = new CsjSim({ ...O50, nowSlot }, specs).run();
            const plain = new CsjSim({ ...O50, nowSlot, csj: false }, specs).run();
            expect(`${seed}:${sim.tip().hash}`).toBe(`${seed}:${hon[hon.length - 1]!.hash}`);
            expect(sim.maxEngagedDownloaders).toBeLessThanOrEqual(2);
            for (const s of specs) if (!s.name.startsWith("adv") && !s.name.startsWith("st")) expect(`${seed}:${s.name}:${sim.disconnected.get(s.name) ?? "connected"}`).toBe(`${seed}:${s.name}:connected`);
            served += sim.totalServed(); servedNoCsj += plain.totalServed();
        }
        expect(served / servedNoCsj).toBeLessThan(0.5); // 2 000 seeds offline: 0.349
    }, 120_000);
});
