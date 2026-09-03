import { describe, expect, test } from "bun:test";
import { ApplyProfile } from "./applyProfile";

describe("ApplyProfile", () => {
    test("accumulates per-phase time and per-block averages", async () => {
        const p = new ApplyProfile();
        p.add("parse", 10);
        p.add("parse", 30);
        await p.timeAsync("sqlite", async () => {});
        expect(p.time("sync", () => 42)).toBe(42);
        p.noteBlock(4);
        const s = p.snapshot();
        expect(s.blocks).toBe(4);
        expect(s.phases.parse).toEqual({ ms: 40, count: 2 });
        expect(s.perBlockMs.parse).toBe(10);
        expect(s.phases.sqlite!.count).toBe(1);
        expect(p.summary()).toContain("parse=10ms");
        p.reset();
        expect(p.snapshot().blocks).toBe(0);
        expect(Object.keys(p.snapshot().phases)).toHaveLength(0);
    });

    test("time() records even when the section throws", () => {
        const p = new ApplyProfile();
        expect(() => p.time("boom", () => { throw new Error("x"); })).toThrow("x");
        expect(p.snapshot().phases.boom!.count).toBe(1);
    });
});
