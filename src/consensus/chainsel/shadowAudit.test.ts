import { describe, expect, test } from "bun:test";
import { ShadowAudit } from "./shadowAudit";

describe("ShadowAudit (chainSelection shadow)", () => {
    test("a switch legacy later makes is 'legacy-followed' with its latency; one it never makes is 'legacy-kept'", async () => {
        const a = new ShadowAudit();
        const applied = new Set<string>();
        a.record({ kind: "switch", peer: "p", tip: { hash: "aa", slot: 1000n }, at: 0, detail: "switch to p" });
        a.record({ kind: "switch", peer: "q", tip: { hash: "bb", slot: 1000n }, at: 0, detail: "switch to q" });
        expect(a.record({ kind: "switch", peer: "p", tip: { hash: "aa", slot: 1000n }, at: 5, detail: "again" })).toBe(false); // the same decision repeated
        const deps = (ourTipSlot: bigint) => ({ isApplied: async (h: string) => applied.has(h), ourTipSlot, peerConnected: () => true });
        expect(await a.resolve(1000, deps(1000n))).toEqual([]);
        applied.add("aa");
        const r1 = await a.resolve(30_000, deps(1010n));
        expect(r1.map((r) => [r.peer, r.verdict])).toEqual([["p", "legacy-followed"]]);
        expect(await a.resolve(100_000, deps(2000n))).toEqual([]); // not RESOLVE_MS yet
        const r2 = await a.resolve(200_000, deps(2000n));
        expect(r2.map((r) => [r.peer, r.verdict])).toEqual([["q", "legacy-kept"]]);
        expect(a.snapshot()).toMatchObject({ recorded: 2, legacyFollowed: 1, legacyKept: 1, pending: 0, followLatencyMsMax: 30_000 });
    });

    test("a disconnect: dropped by legacy too, or kept", async () => {
        const a = new ShadowAudit();
        const connected = new Set(["x", "y"]);
        a.record({ kind: "disconnect", peer: "x", at: 0, detail: "disconnect x" });
        a.record({ kind: "disconnect", peer: "y", at: 0, detail: "disconnect y" });
        connected.delete("x");
        const deps = { isApplied: async () => false, ourTipSlot: 0n, peerConnected: (p: string) => connected.has(p) };
        expect((await a.resolve(10, deps)).map((r) => r.verdict)).toEqual(["peer-dropped"]);
        expect((await a.resolve(ShadowAudit.RESOLVE_MS, deps)).map((r) => r.verdict)).toEqual(["peer-kept"]);
    });
});
