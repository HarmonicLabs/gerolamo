import { describe, expect, test } from "bun:test";

import { restartDelayMs, waitForPidExit } from "./nodeService";

describe("waitForPidExit", () => {
  test("resolves true as soon as the pid is gone, without sleeping past that", async () => {
    let polls = 0;
    const alive = () => ++polls < 3;
    const slept: number[] = [];
    const ok = await waitForPidExit(123, 10_000, alive, async (ms) => { slept.push(ms); });
    expect(ok).toBe(true);
    expect(slept.length).toBe(2);
  });

  test("resolves false at the deadline while the pid is still alive", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const ok = await waitForPidExit(123, 1000, () => true, async (ms) => { now += ms; });
      expect(ok).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("restartDelayMs (crash supervision)", () => {
  const opts = { windowMs: 600_000, max: 5, baseMs: 5_000, maxMs: 60_000 };
  test("backs off 5 s, 10 s, 20 s, 40 s, 60 s, then gives up within the window", () => {
    const now = 1_000_000;
    const crashes: number[] = [];
    const delays: Array<number | null> = [];
    for (let i = 0; i < 6; i++) {
      crashes.push(now + i);
      delays.push(restartDelayMs(crashes, now + i, opts));
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, null]);
  });
  test("crashes older than the window do not count", () => {
    const now = 10_000_000;
    const old = [now - 700_000, now - 650_000, now - 620_000, now - 610_000, now - 605_000];
    expect(restartDelayMs([...old, now], now, opts)).toBe(5_000);
  });
});
