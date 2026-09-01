import { describe, expect, test } from "bun:test";
import { deriveGerolamoSyncStatus } from "./syncStatus";

describe("deriveGerolamoSyncStatus", () => {
  test("preprod clock uses Shelley offset 86400", () => {
    const start = 1_655_769_600_000;
    const now = start + 1_000_000 * 1000; // 1e6 seconds after Shelley start
    const s = deriveGerolamoSyncStatus({ tipSlot: "86400" }, "preprod", now);
    expect(s.networkTipSlot).toBe((86400n + 1_000_000n).toString());
    expect(s.lagSlots).toBe("1000000");
    expect(s.syncPercent).toBeGreaterThan(0);
    expect(s.syncPercent).toBeLessThan(20);
  });

  test("preview clock has zero slot offset", () => {
    const start = 1_666_656_000_000;
    const now = start + 1000;
    const s = deriveGerolamoSyncStatus({ tipSlot: "0" }, "preview", now);
    expect(s.networkTipSlot).toBe("1");
  });

  test("slots travel as decimal strings", () => {
    const s = deriveGerolamoSyncStatus(
      { tipSlot: 130420798, epoch: 301, utxoCount: 12, peers: { hot: 2 } },
      "preprod",
    );
    expect(typeof s.tipSlot).toBe("string");
    expect(s.tipSlot).toBe("130420798");
    expect(s.epoch).toBe(301);
    expect(s.utxoCount).toBe(12);
    expect(s.hotPeers).toBe(2);
  });
});
