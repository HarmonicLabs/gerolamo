import { describe, expect, test } from "bun:test";
import { BoundedMap } from "./boundedMap";

describe("BoundedMap", () => {
    test("evicts the oldest inserted key once the bound is exceeded", () => {
        const m = new BoundedMap<string, number>(3);
        m.set("a", 1).set("b", 2).set("c", 3);
        expect(m.size).toBe(3);
        m.set("d", 4);
        expect(m.size).toBe(3);
        expect(m.has("a")).toBe(false);
        expect(m.get("d")).toBe(4);
    });
    test("updating an existing key does not count as an insertion", () => {
        const m = new BoundedMap<string, number>(2);
        m.set("a", 1).set("b", 2).set("a", 3);
        expect(m.size).toBe(2);
        expect(m.get("a")).toBe(3);
        m.set("c", 4);
        expect(m.has("a")).toBe(false); // a was inserted first, its update did not refresh it
        expect(m.has("b")).toBe(true);
    });
    test("external deletes and clear keep the queue consistent", () => {
        const m = new BoundedMap<number, number>(1000);
        for (let i = 0; i < 100_000; i++) m.set(i, i);
        expect(m.size).toBe(1000);
        expect(m.has(99_000)).toBe(true);
        m.delete(99_999);
        m.set(200_000, 1);
        expect(m.size).toBe(1000);
        m.clear();
        expect(m.size).toBe(0);
        m.set(1, 1);
        expect(m.get(1)).toBe(1);
    });
    test("steady-state eviction stays cheap", () => {
        const m = new BoundedMap<string, number>(60_000);
        for (let i = 0; i < 60_000; i++) m.set("k" + i, i);
        const t = performance.now();
        for (let i = 60_000; i < 160_000; i++) m.set("k" + i, i);
        const perOp = ((performance.now() - t) / 100_000) * 1000;
        expect(perOp).toBeLessThan(10); // µs; the keys().next() pattern measured 37 µs
    });
});
