import { describe, expect, test } from "bun:test";
import { mithrilReplayStatus, type MithrilProgress } from "./progress";

const done: MithrilProgress = { phase: "done", network: "preview", lastSlot: 122_000_000, lastEpoch: 1412, startedAt: "", updatedAt: "" };

describe("mithrilReplayStatus", () => {
    test("nothing while the bootstrap itself is still running", () => {
        expect(mithrilReplayStatus({ ...done, phase: "apply" }, 10)).toBeNull();
        expect(mithrilReplayStatus(null, 10)).toBeNull();
    });
    test("replay percent against the certified chain's last slot", () => {
        const r = mithrilReplayStatus(done, 61_000_000n)!;
        expect(r.phase).toBe("replay");
        expect(r.percent).toBeCloseTo(50, 5);
        expect(r.certifiedEpoch).toBe(1412);
        expect(r.label).toContain("50.0 %");
    });
    test("live once the tip passes the certified chain", () => {
        expect(mithrilReplayStatus(done, 122_000_000)!.phase).toBe("live");
        expect(mithrilReplayStatus(done, 122_500_000)!.percent).toBe(100);
    });
});
