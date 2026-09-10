import { describe, expect, test } from "bun:test";
import { CandidateSet } from "./CandidateSet";

const h = (s: string) => s.repeat(64).slice(0, 64);

describe("CandidateSet roles", () => {
    test("first peer becomes primary, others verifiers", () => {
        const cs = new CandidateSet();
        expect(cs.addPeer("a")).toBe("primary");
        expect(cs.addPeer("b")).toBe("verifier");
        expect(cs.primary()).toBe("a");
        cs.removePeer("a");
        expect(cs.primary()).toBeNull();
        expect(cs.addPeer("c")).toBe("primary");
    });

    test("setPrimary re-evaluates verifiers against the new fragment", () => {
        const cs = new CandidateSet();
        cs.addPeer("a");
        cs.addPeer("b");
        cs.observe("a", { slot: 10n, hash: h("1") });
        cs.observe("b", { slot: 10n, hash: h("2") }); // b diverges from a
        expect(cs.agreement("b")!.status).toBe("divergent");
        cs.setPrimary("b");
        expect(cs.roleOf("a")).toBe("verifier");
        // a's hash at slot 10 differs from b's → a now divergent
        expect(cs.agreement("a")!.status).toBe("divergent");
        expect(cs.agreement("b")!.role).toBe("primary");
    });
});

describe("CandidateSet agreement", () => {
    test("verifier agrees when hashes match at the same slot", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v");
        expect(cs.observe("p", { slot: 1n, hash: h("a") }).kind).toBe("primary-advance");
        expect(cs.observe("v", { slot: 1n, hash: h("a") }).kind).toBe("agree");
        expect(cs.agreement("v")!.agreedAtSlot).toBe(1n);
        expect(cs.agreesThrough("v", 1n)).toBe(true);
        expect(cs.agreesThrough("v", 2n)).toBe(false);
        expect(cs.agreeingPeers()).toEqual(["v"]);
    });

    test("verifier ahead of the primary is resolved when the primary catches up", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v");
        cs.observe("p", { slot: 1n, hash: h("a") });
        expect(cs.observe("v", { slot: 1n, hash: h("a") }).kind).toBe("agree");
        expect(cs.observe("v", { slot: 5n, hash: h("b") }).kind).toBe("ahead");
        expect(cs.agreement("v")!.status).toBe("agrees");
        cs.observe("p", { slot: 5n, hash: h("b") });
        expect(cs.agreement("v")!.agreedAtSlot).toBe(5n);
        // and a lying verifier ahead is caught on catch-up
        cs.addPeer("liar");
        cs.observe("liar", { slot: 9n, hash: h("f") });
        cs.observe("p", { slot: 9n, hash: h("9") });
        expect(cs.agreement("liar")!.status).toBe("divergent");
        expect(cs.divergentPeers()).toEqual(["liar"]);
    });

    test("verifier reporting the second block of a shared slot before the primary is not divergent", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        cs.observe("p", { slot: 0n, hash: h("ebb"), ebb: true }); // primary has only the EBB so far
        const early = cs.observe("v", { slot: 0n, hash: h("ebb"), ebb: true });
        expect(early.kind).toBe("agree");
        const second = cs.observe("v", { slot: 0n, hash: h("main0") }); // main block 1, same slot, primary not there yet
        expect(second.kind).toBe("ahead");
        expect(cs.agreement("v")!.status).not.toBe("divergent");
        cs.observe("p", { slot: 0n, hash: h("main0") }); // primary catches up
        expect(cs.agreement("v")!.status).toBe("agrees");
        expect(cs.agreesThrough("v", 0n)).toBe(true);
    });

    test("primary observing the EBB while a verifier is pending on the same slot's main block terminates and keeps the entry", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        // verifier first: EBB then main block of slot 0, both ahead of a primary with no fragment yet
        expect(cs.observe("v", { slot: 0n, hash: h("ebb"), ebb: true }).kind).toBe("ahead");
        expect(cs.observe("v", { slot: 0n, hash: h("main0") }).kind).toBe("ahead");
        // primary now delivers the EBB: the main-block entry must be deferred, not spin forever
        expect(cs.observe("p", { slot: 0n, hash: h("ebb"), ebb: true }).kind).toBe("primary-advance");
        expect(cs.pendingCount("v")).toBe(1);
        expect(cs.agreement("v")!.status).not.toBe("divergent");
        cs.observe("p", { slot: 0n, hash: h("main0") });
        expect(cs.pendingCount("v")).toBe(0);
        expect(cs.agreement("v")!.status).toBe("agrees");
    });

    test("a genuinely different block at a shared slot is a fork once the primary moves past it", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        cs.observe("p", { slot: 0n, hash: h("ebb"), ebb: true });
        expect(cs.observe("v", { slot: 0n, hash: h("other") }).kind).toBe("ahead");
        cs.observe("p", { slot: 20n, hash: h("b20") }); // primary advanced; slot 0 never got "other"
        expect(cs.agreement("v")!.status).toBe("divergent");
        expect(cs.divergentPeers()).toEqual(["v"]);
    });

    test("a different hash at the primary's tip slot is an immediate fork when that block is not an EBB", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        cs.observe("p", { slot: 100n, hash: h("p100") });
        expect(cs.observe("v", { slot: 100n, hash: h("x100") }).kind).toBe("divergent");
    });

    test("EBB and first main block sharing a slot both count as agreement", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v");
        cs.observe("p", { slot: 21600n, hash: h("e") }); // EBB
        cs.observe("p", { slot: 21600n, hash: h("m") }); // main block, same slot
        expect(cs.observe("v", { slot: 21600n, hash: h("e") }).kind).toBe("agree");
        expect(cs.observe("v", { slot: 21600n, hash: h("m") }).kind).toBe("agree");
    });

    test("a block at a slot the primary has no header for inside its window is no verdict", () => {
        // The window is kept in arrival order and a re-anchored primary replays older slots,
        // so a missing slot is ours to explain, not the verifier's (preview 2026-09-06 held
        // honest relays cold over canonical blocks). The fork shows at the next shared slot.
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v");
        cs.observe("p", { slot: 1n, hash: h("a") });
        cs.observe("p", { slot: 3n, hash: h("c") });
        const verdict = cs.observe("v", { slot: 2n, hash: h("b") });
        expect(verdict.kind).toBe("unmatched");
        expect(cs.agreement("v")!.divergence).toBeNull();
        expect(cs.observe("v", { slot: 3n, hash: h("not-c") }).kind).toBe("divergent");
    });

    test("duplicate observations are ignored", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.observe("p", { slot: 1n, hash: h("a") });
        expect(cs.observe("p", { slot: 1n, hash: h("a") }).kind).toBe("duplicate");
        expect(cs.fragmentOf("p").length).toBe(1);
    });

    test("fragment depth is bounded", () => {
        const cs = new CandidateSet({ depth: 16 });
        cs.addPeer("p");
        for (let i = 0; i < 40; i++) cs.observe("p", { slot: BigInt(i), hash: h(String(i % 10)) });
        expect(cs.fragmentOf("p").length).toBe(16);
        cs.addPeer("v");
        expect(cs.observe("v", { slot: 3n, hash: h("3") }).kind).toBe("behind");
    });
});

describe("CandidateSet quorum", () => {
    test("primary is outvoted when two verifiers agree on a different hash", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v1");
        cs.addPeer("v2");
        cs.addPeer("v3");
        cs.observe("p", { slot: 7n, hash: h("p") });
        cs.observe("v1", { slot: 7n, hash: h("x") });
        cs.observe("v2", { slot: 7n, hash: h("x") });
        cs.observe("v3", { slot: 7n, hash: h("p") });
        const r = cs.primaryOutvoted(2);
        expect(r.outvoted).toBe(true);
        expect(r.slot).toBe(7n);
        expect(r.hash).toBe(h("x"));
        expect(r.by!.sort()).toEqual(["v1", "v2"]);
        expect(cs.bestSuccessor()).toBe("v3"); // the only agreeing verifier
    });

    test("two verifiers diverging in different directions do not outvote the primary", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v1");
        cs.addPeer("v2");
        cs.observe("p", { slot: 7n, hash: h("p") });
        cs.observe("v1", { slot: 7n, hash: h("x") });
        cs.observe("v2", { slot: 7n, hash: h("y") });
        expect(cs.primaryOutvoted(2).outvoted).toBe(false);
    });

    test("bestSuccessor prefers the highest agreed slot", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v1");
        cs.addPeer("v2");
        cs.observe("p", { slot: 1n, hash: h("a") });
        cs.observe("p", { slot: 2n, hash: h("b") });
        cs.observe("v1", { slot: 1n, hash: h("a") });
        cs.observe("v2", { slot: 1n, hash: h("a") });
        cs.observe("v2", { slot: 2n, hash: h("b") });
        expect(cs.bestSuccessor()).toBe("v2");
        cs.reset();
        expect(cs.agreement("v2")!.agreedAtSlot).toBeNull();
    });
});

import { distinctHosts, hostOfPeerKey } from "./CandidateSet";

describe("distinct-host quorum", () => {
    test("hostOfPeerKey strips the port and IPv6 brackets", () => {
        expect(hostOfPeerKey("3.1.2.3:3001")).toBe("3.1.2.3");
        expect(hostOfPeerKey("relay.example:30000")).toBe("relay.example");
        expect(hostOfPeerKey("[2a05::1]:3001")).toBe("2a05::1");
        expect(distinctHosts(["3.1.2.3:3001", "3.1.2.3:30000", "3.9.9.9:3001"])).toBe(2);
    });

    test("two connections to the same host cannot outvote the primary alone", () => {
        const c = new CandidateSet({ depth: 64 });
        c.addPeer("p:3001", "primary");
        c.addPeer("v:3001", "verifier");
        c.addPeer("v:3002", "verifier");
        c.observe("p:3001", { slot: 10n, hash: "aa" });
        c.observe("v:3001", { slot: 10n, hash: "bb" });
        c.observe("v:3002", { slot: 10n, hash: "bb" });
        expect(c.primaryOutvoted(2).outvoted).toBe(false);
        c.addPeer("w:3001", "verifier");
        c.observe("w:3001", { slot: 10n, hash: "bb" });
        const r = c.primaryOutvoted(2);
        expect(r.outvoted).toBe(true);
        expect(r.hash).toBe("bb");
    });
});

describe("fasterAgreeingVerifier", () => {
    test("picks the agreeing verifier with the longest validated lead over the primary", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("slow", "verifier");
        cs.addPeer("fast", "verifier");
        cs.addPeer("liar", "verifier");
        for (let s = 1; s <= 10; s++) cs.observe("p", { slot: BigInt(s), hash: h(String(s)) });
        for (let s = 1; s <= 12; s++) cs.observe("slow", { slot: BigInt(s), hash: h(String(s)) });
        for (let s = 1; s <= 40; s++) cs.observe("fast", { slot: BigInt(s), hash: h(String(s)) });
        for (let s = 1; s <= 9; s++) cs.observe("liar", { slot: BigInt(s), hash: h(String(s)) });
        cs.observe("liar", { slot: 10n, hash: h("x") }); // forks at the primary's tip
        for (let s = 11; s <= 100; s++) cs.observe("liar", { slot: BigInt(s), hash: h("x" + s) });
        expect(cs.agreement("liar")!.status).toBe("divergent");
        const pick = cs.fasterAgreeingVerifier(20);
        expect(pick).toEqual({ key: "fast", lead: 30, primaryTipSlot: 10n });
        expect(cs.fasterAgreeingVerifier(31)).toBeNull();
    });

    test("a verifier that has not confirmed the primary's tip is not a candidate", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        for (let s = 1; s <= 10; s++) cs.observe("p", { slot: BigInt(s), hash: h(String(s)) });
        for (let s = 1; s <= 5; s++) cs.observe("v", { slot: BigInt(s), hash: h(String(s)) }); // agrees only through 5
        for (let s = 11; s <= 50; s++) cs.observe("v", { slot: BigInt(s), hash: h(String(s)) }); // ahead, but slots 6-10 unseen
        expect(cs.fasterAgreeingVerifier(10)).toBeNull();
    });

    test("no primary or empty primary fragment yields null", () => {
        const cs = new CandidateSet();
        expect(cs.fasterAgreeingVerifier(1)).toBeNull();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        cs.observe("v", { slot: 5n, hash: h("5") });
        expect(cs.fasterAgreeingVerifier(1)).toBeNull();
    });
});

describe("CandidateSet lagging verifiers", () => {
    test("a verifier below the window reads behind with its lag; a late match makes it agree", () => {
        const cs = new CandidateSet({ depth: 3 });
        cs.addPeer("p");
        cs.addPeer("v");
        for (let i = 10; i <= 14; i++) cs.observe("p", { slot: BigInt(i), hash: h(String(i % 10)) });
        // window is slots 12..14; the verifier is at slot 5
        expect(cs.observe("v", { slot: 5n, hash: h("5") })).toEqual({ kind: "behind", slot: 5n });
        expect(cs.agreement("v")).toMatchObject({ status: "behind", lagSlots: 9n });
        expect(cs.noteAgreedBehind("v", 5n)).toBe(true);
        expect(cs.agreement("v")).toMatchObject({ status: "agrees", agreedAtSlot: 5n, lagSlots: 9n });
        expect(cs.agreement("p")!.lagSlots).toBeNull();
    });

    test("a slot the primary has no header for inside its window is not a fork", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v", "verifier");
        // primary window built out of order (verifier-era points, then a re-anchor replay)
        cs.observe("p", { slot: 100n, hash: h("p100") });
        cs.observe("p", { slot: 80n, hash: h("p80") }); // replayed older slot
        cs.observe("p", { slot: 120n, hash: h("p120") });
        expect(cs.observe("v", { slot: 110n, hash: h("v110") }).kind).toBe("unmatched");
        expect(cs.agreement("v")!.status).not.toBe("divergent");
        expect(cs.divergentPeers()).toEqual([]);
        // a differing hash at a shared slot is still a fork
        expect(cs.observe("v", { slot: 120n, hash: h("other120") }).kind).toBe("divergent");
        expect(cs.divergentPeers()).toEqual(["v"]);
    });
});

describe("fork point and outvote (bug 88)", () => {
    test("two verifiers diverging at the same fork point at different times outvote the primary; later mismatches keep the fork point; adoption clears it", () => {
        const cs = new CandidateSet();
        cs.addPeer("P"); cs.addPeer("A"); cs.addPeer("B");
        const H = (n: number) => n.toString(16).padStart(64, "0");
        for (let i = 1; i <= 5; i++) cs.observe("P", { slot: BigInt(i), hash: H(i) });
        // A forks at slot 3 and continues on its branch
        cs.observe("A", { slot: 1n, hash: H(1) }); cs.observe("A", { slot: 2n, hash: H(2) });
        expect(cs.observe("A", { slot: 3n, hash: H(103) }).kind).toBe("divergent");
        const later = cs.observe("A", { slot: 4n, hash: H(104) });
        expect(later.kind).toBe("divergent"); expect((later as any).slot).toBe(3n); // fork point kept
        expect(cs.primaryOutvoted(2).outvoted).toBe(false);
        // B, on the same branch, arrives later at a different point
        cs.observe("B", { slot: 3n, hash: H(103) }); cs.observe("B", { slot: 4n, hash: H(104) }); cs.observe("B", { slot: 5n, hash: H(105) });
        const o = cs.primaryOutvoted(2);
        expect(o.outvoted).toBe(true); expect(o.slot).toBe(3n); expect(o.hash).toBe(H(103));
        // the primary reorganises onto the verifiers' branch: divergence clears on agreement
        cs.setPrimary("A");
        expect(cs.primaryOutvoted(2).outvoted).toBe(false);
    });
});

describe("slot battles", () => {
    test("a competing block announced by any peer at a slot is known", () => {
        const c = new CandidateSet();
        c.addPeer("p"); c.addPeer("v");
        c.observe("p", { slot: 10n, hash: "aa".repeat(32) });
        c.observe("v", { slot: 10n, hash: "bb".repeat(32) });
        expect(c.knownAtSlot(10n, "AA".repeat(32))).toBe(true);
        expect(c.knownAtSlot(10n, "bb".repeat(32))).toBe(true);
        expect(c.knownAtSlot(10n, "cc".repeat(32))).toBe(false);
        expect(c.knownAtSlot(11n, "aa".repeat(32))).toBe(false);
    });
});
