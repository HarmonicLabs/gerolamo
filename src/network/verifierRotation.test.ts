import { describe, expect, test } from "bun:test";
import { pickLaggingVerifiers } from "./verifierRotation";

const opts = { maxLagSlots: 1000n, minHotAgeMs: 60_000, now: 1_000_000 };

describe("pickLaggingVerifiers", () => {
    test("verifiers past the lag limit, most behind first; primary and fresh promotions excluded", () => {
        const picks = pickLaggingVerifiers([
            { key: "primary", role: "primary", lagSlots: 0n, promotedAt: 0 },
            { key: "far", role: "verifier", lagSlots: 50_000n, promotedAt: 0 },
            { key: "mid", role: "verifier", lagSlots: 5_000n, promotedAt: 0 },
            { key: "fresh", role: "verifier", lagSlots: 90_000n, promotedAt: 990_000 },
            { key: "ok", role: "verifier", lagSlots: 999n, promotedAt: 0 },
            { key: "unknown", role: "verifier", lagSlots: null, promotedAt: 0 },
        ], opts);
        expect(picks.map((p) => p.key)).toEqual(["far", "mid"]);
    });
    test("a lag exactly at the limit is kept", () => {
        expect(pickLaggingVerifiers([{ key: "v", role: "verifier", lagSlots: 1000n, promotedAt: 0 }], opts)).toEqual([]);
    });
});
