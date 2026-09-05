import { describe, expect, test } from "bun:test";
import { decideForge, slotAt, slotStartMs, SlotTicker } from "./slotClock";

const PREVIEW_START = 1666656000; // 2022-10-25T00:00:00Z, 1 s slots from slot 0

describe("slot clock", () => {
    test("preview slots are seconds since system start; mainnet Byron slots are 20 s", () => {
        expect(slotAt(PREVIEW_START * 1000, "preview")).toBe(0n);
        expect(slotAt((PREVIEW_START + 28771200) * 1000 + 999, "preview")).toBe(28771200n);
        expect(slotStartMs(28771200n, "preview")).toBe((PREVIEW_START + 28771200) * 1000);
        // mainnet: Shelley starts at slot 4 492 800 = 2020-07-29T21:44:51Z
        expect(slotAt(Date.UTC(2020, 6, 29, 21, 44, 51), "mainnet")).toBe(4492800n);
        expect(slotAt(Date.UTC(2020, 6, 29, 21, 44, 51) + 5000, "mainnet")).toBe(4492805n);
        expect(slotAt(Date.UTC(2020, 6, 29, 21, 44, 51) - 20000, "mainnet")).toBe(4492799n);
    });

    test("decideForge: leader, in-slot, not forged, tip known and synced → forge; each failure has a reason", () => {
        const slot = 28771342n;
        const start = slotStartMs(slot, "preview");
        const tip = { slot: slot - 17n, blockNumber: 1_252_900n, hash: new Uint8Array(32).fill(9) };
        const state = { leaderSlots: new Set([slot.toString()]), tip, lastForgedSlot: slot - 5000n };
        const opts = { network: "preview" as const };
        const ok = decideForge(slot, start + 120, state, opts);
        expect(ok).toEqual({ forge: true, slot, epoch: 333, blockNumber: 1_252_901n, prevHash: tip.hash });
        expect(decideForge(slot, start - 2000, state, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("starts in") });
        expect(decideForge(slot, start + 1000 + 600, state, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("ended") });
        expect(decideForge(slot, start + 1000 + 400, state, opts).forge).toBe(true); // within the 500 ms skew
        expect(decideForge(slot + 1n, start + 1100, state, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("not leader") });
        expect(decideForge(slot, start + 100, { ...state, lastForgedSlot: slot }, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("already forged") });
        expect(decideForge(slot, start + 100, { ...state, tip: null }, opts)).toMatchObject({ forge: false, reason: "no chain tip" });
        expect(decideForge(slot, start + 100, { ...state, tip: { ...tip, slot } }, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("not before") });
        expect(decideForge(slot, start + 100, { ...state, tip: { ...tip, slot: slot - 5000n } }, opts)).toMatchObject({ forge: false, reason: expect.stringContaining("not synced") });
    });

    test("ticker fires once per slot boundary with an injected clock", async () => {
        let now = slotStartMs(100n, "preview") + 700; // 300 ms before slot 101
        const fired: bigint[] = [];
        const t = new SlotTicker({ network: "preview", now: () => now }, (s) => fired.push(s));
        t.start();
        // advance the fake clock past the boundary before the timer fires
        now += 320;
        await new Promise((r) => setTimeout(r, 340));
        expect(fired).toEqual([101n]);
        // jump two slots at once: only the current one is delivered (the missed slot is gone)
        now = slotStartMs(104n, "preview") + 10;
        await new Promise((r) => setTimeout(r, 1100));
        expect(fired[fired.length - 1]).toBe(104n);
        expect(fired).not.toContain(102n);
        t.stop();
    });
});
