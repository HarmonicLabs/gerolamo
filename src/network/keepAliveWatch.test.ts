import { describe, expect, test } from "bun:test";
import { DEFAULT_KEEPALIVE_TIMEOUT_MS, keepAliveTimeoutMs, keepAliveVerdict } from "./keepAliveWatch";

describe("keep-alive reply deadline (bug 395)", () => {
    const base = { intervalMs: 10_000, timeoutMs: 60_000 };

    test("a recent reply is ok", () => {
        expect(keepAliveVerdict({ ...base, now: 100_000, lastReplyAt: 95_000, lastTickAt: 90_000 })).toBe("ok");
    });

    test("no reply for longer than the timeout on an on-time tick is overdue", () => {
        expect(keepAliveVerdict({ ...base, now: 200_000, lastReplyAt: 130_000, lastTickAt: 190_000 })).toBe("overdue");
    });

    test("a tick delayed by our own blocked event loop never judges", () => {
        // 90 s since the last reply, but the previous tick was 85 s ago: the loop was blocked, replies may be unread
        expect(keepAliveVerdict({ ...base, now: 200_000, lastReplyAt: 110_000, lastTickAt: 115_000 })).toBe("late-tick");
    });

    test("five hours of silence (the 3037 stall) is overdue", () => {
        const now = 5 * 3600_000;
        expect(keepAliveVerdict({ ...base, now, lastReplyAt: 0, lastTickAt: now - 10_000 })).toBe("overdue");
    });

    test("timeout from --keepalive-timeout-ms; invalid values fall back to 60 s", () => {
        expect(keepAliveTimeoutMs(Number.NaN)).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
        expect(keepAliveTimeoutMs(90_000)).toBe(90_000);
        expect(keepAliveTimeoutMs(-1)).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
    });
});
