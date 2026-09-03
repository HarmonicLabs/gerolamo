import { describe, expect, test } from "bun:test";
import { deriveEpochProgress, deriveGerolamoSyncStatus, epochBoundsAtSlot } from "./syncStatus";

describe("deriveGerolamoSyncStatus", () => {
  test("preprod clock uses Shelley offset 86400", () => {
    const start = 1_655_769_600_000;
    const now = start + 1_000_000 * 1000;
    const s = deriveGerolamoSyncStatus({ tipSlot: "86400", utxoCount: 1 }, "preprod", now);
    expect(s.networkTipSlot).toBe((86400n + 1_000_000n).toString());
    expect(s.lagSlots).toBe("1000000");
    expect(s.syncPercent).toBeGreaterThan(0);
    expect(s.syncPercent).toBeLessThan(20);
  });

  test("preview clock has zero slot offset", () => {
    const start = 1_666_656_000_000;
    const now = start + 1000;
    const s = deriveGerolamoSyncStatus({ tipSlot: "0", utxoCount: 0 }, "preview", now);
    expect(s.networkTipSlot).toBe("1");
    expect(s.emptyLedger).toBe(true);
    expect(s.syncPercent).toBe(0);
  });

  test("era travels as number + display name", () => {
    const s = deriveGerolamoSyncStatus(
      { tipSlot: "84242", epoch: 3, era: 1, eraName: "Byron", utxoCount: 0 },
      "preprod",
    );
    expect(s.era).toBe(1);
    expect(s.eraName).toBe("Byron");
    const none = deriveGerolamoSyncStatus({ tipSlot: "0", utxoCount: 0 }, "preprod");
    expect(none.era).toBeNull();
    expect(none.eraName).toBeNull();
  });

  test("multi-peer sync block is parsed and summarised", () => {
    const s = deriveGerolamoSyncStatus(
      {
        tipSlot: "100",
        utxoCount: 3,
        governor: { maliciousPeers: [{ key: "1.2.3.4:3001", reason: "malicious: body hash mismatch", until: 5 }] },
        sync: {
          mode: "genesis",
          bodyValidation: "strict",
          primary: "a:3001",
          quorum: 2,
          peers: [
            { key: "a:3001", role: "primary", status: "unknown", agreedAtSlot: null, tipSlot: "100", headersSeen: 10, divergence: null },
            { key: "b:3001", role: "verifier", status: "agrees", agreedAtSlot: "99", tipSlot: "101", headersSeen: 9, divergence: null },
            { key: "c:3001", role: "verifier", status: "divergent", agreedAtSlot: "50", tipSlot: "60", headersSeen: 4, divergence: { slot: "55", peerHash: "x", primaryHashes: ["y"] } },
          ],
          scheduler: { inFlight: 2, queued: 1, awaitingApply: 0, applied: 40, retries: 1, nextApplySeq: 40 },
          validationWorkers: 8,
          pendingHeaders: 64,
          blocksApplied: 40,
          blocksPerSec: 12.5,
        },
      },
      "preprod",
    );
    const mp = s.multiPeer!;
    expect(mp.mode).toBe("genesis");
    expect(mp.bodyValidation).toBe("strict");
    expect(mp.primary).toBe("a:3001");
    expect(mp.agreeing).toBe(1);
    expect(mp.divergent).toBe(1);
    expect(mp.peers[2]!.divergenceSlot).toBe("55");
    expect(mp.rangesInFlight).toBe(2);
    expect(mp.rangeRetries).toBe(1);
    expect(mp.blocksPerSec).toBe(12.5);
    expect(mp.validationWorkers).toBe(8);
    expect(s.peers.maliciousPeers[0]!.key).toBe("1.2.3.4:3001");
    const none = deriveGerolamoSyncStatus({ tipSlot: "0", utxoCount: 0 }, "preprod");
    expect(none.multiPeer).toBeNull();
    expect(none.peers.maliciousPeers).toEqual([]);
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
    expect(s.emptyLedger).toBe(false);
    expect(s.syncPercent).toBe(s.followPercent);
  });

  test("empty ledger at tip is 0% density, not 100% synced", () => {
    const start = 1_655_769_600_000;
    const now = start + 1_000_000 * 1000;
    const s = deriveGerolamoSyncStatus(
      { tipSlot: String(86400n + 1_000_000n), utxoCount: 0 },
      "preprod",
      now,
    );
    expect(s.emptyLedger).toBe(true);
    expect(s.syncPercent).toBe(0);
    expect(s.followPercent).toBeGreaterThan(99);
    expect(s.syncLabel).toContain("ledger empty");
  });
});

describe("epoch progress", () => {
  test("preprod: Byron epochs are 21600 slots, Shelley starts at slot 86400 = epoch 4", () => {
    expect(epochBoundsAtSlot(0n, "preprod")).toEqual({ epoch: 0n, startSlot: 0n, lengthSlots: 21_600n });
    expect(epochBoundsAtSlot(86_399n, "preprod").epoch).toBe(3n);
    expect(epochBoundsAtSlot(86_400n, "preprod")).toEqual({ epoch: 4n, startSlot: 86_400n, lengthSlots: 432_000n });
    expect(epochBoundsAtSlot(518_400n, "preprod").epoch).toBe(5n);
  });

  test("mainnet: 208 Byron epochs then 432000-slot epochs", () => {
    expect(epochBoundsAtSlot(4_492_799n, "mainnet").epoch).toBe(207n);
    expect(epochBoundsAtSlot(4_492_800n, "mainnet").epoch).toBe(208n);
    expect(epochBoundsAtSlot(0n, "preview")).toEqual({ epoch: 0n, startSlot: 0n, lengthSlots: 86_400n });
  });

  test("slots done / left inside a past epoch, and epochs behind the clock", () => {
    // tip at preprod slot 242860 (epoch 4), clock far ahead in epoch 6
    const p = deriveEpochProgress(242_860n, 86_400n + 2n * 432_000n + 10n, "preprod");
    expect(p.epoch).toBe(4);
    expect(p.clockEpoch).toBe(6);
    expect(p.epochsBehind).toBe(2);
    expect(p.slotsDone).toBe(242_860 - 86_400);
    expect(p.slotsLeft).toBe(518_400 - 242_860);
    expect(p.percent).toBeCloseTo(((242_860 - 86_400) / 432_000) * 100, 1);
    expect(p.live).toBe(false);
  });

  test("in the live epoch the clock is the finish line", () => {
    const p = deriveEpochProgress(600_000n, 600_100n, "preprod");
    expect(p.live).toBe(true);
    expect(p.epochsBehind).toBe(0);
    expect(p.slotsLeft).toBe(100);
  });

  test("status carries epochProgress and hides it on an empty chain", () => {
    const s = deriveGerolamoSyncStatus({ tipSlot: "242860", utxoCount: 4 }, "preprod");
    expect(s.epochProgress?.epoch).toBe(4);
    expect(deriveGerolamoSyncStatus({ tipSlot: "0", utxoCount: 0 }, "preprod").epochProgress).toBeNull();
  });
});
