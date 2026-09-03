import { describe, expect, test } from "bun:test";
import { pushSample, series, spanLabel, type ResourceSample } from "./history";

const s = (t: number, cores: number | null): ResourceSample => ({ t, nodeCores: cores, nodeRss: null, nodeHeap: null, sysCpu: null, sysMem: null, bps: null });

describe("history", () => {
  test("pushSample keeps at most max samples, oldest dropped, returns a new array", () => {
    let h: ResourceSample[] = [];
    for (let i = 0; i < 5; i++) h = pushSample(h, s(i * 1000, i), 3);
    expect(h.map((x) => x.t)).toEqual([2000, 3000, 4000]);
    const before = h;
    h = pushSample(h, s(5000, 5), 3);
    expect(h).not.toBe(before);
    expect(h.map((x) => x.t)).toEqual([3000, 4000, 5000]);
  });
  test("series maps nulls to NaN gaps", () => {
    const h = [s(0, 1), s(2000, null), s(4000, 2.5)];
    const v = series(h, "nodeCores");
    expect(v[0]).toBe(1);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(2.5);
  });
  test("spanLabel", () => {
    expect(spanLabel([])).toBe("—");
    expect(spanLabel([s(0, 0), s(30_000, 0)])).toBe("30 s");
    expect(spanLabel([s(0, 0), s(12 * 60_000, 0)])).toBe("12 min");
  });
});
