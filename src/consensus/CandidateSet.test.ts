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

    test("a block at a slot the primary skipped inside its window is a fork", () => {
        const cs = new CandidateSet();
        cs.addPeer("p");
        cs.addPeer("v");
        cs.observe("p", { slot: 1n, hash: h("a") });
        cs.observe("p", { slot: 3n, hash: h("c") });
        const verdict = cs.observe("v", { slot: 2n, hash: h("b") });
        expect(verdict.kind).toBe("divergent");
        expect(cs.agreement("v")!.divergence!.primaryHashes).toEqual([]);
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
