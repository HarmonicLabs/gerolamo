import { describe, it, expect, test } from "bun:test";
import {
  mockBlocks,
  mockTxs,
  getMockBlockByHash,
  getMockTxByHash,
} from "@/mocks/index";
import type {
  BlockInfo,
  BlockDetail,
  TxDetail,
  TxInput,
  TxOutput,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Block data structure integrity for component consumption
// ---------------------------------------------------------------------------

describe("Block data shape (for BlockCard/BlockDetail)", () => {
  it("mockBlocks entries satisfy BlockInfo fields", () => {
    const requiredKeys: (keyof BlockInfo)[] = [
      "slot",
      "hash",
      "prevHash",
      "era",
      "epoch",
      "txCount",
      "size",
    ];

    for (const block of mockBlocks) {
      for (const key of requiredKeys) {
        expect(block).toHaveProperty(key);
      }
    }
  });

  it("mockBlocks entries have BlockDetail-specific fields", () => {
    const detailKeys: (keyof BlockDetail)[] = [
      "vrf",
      "kesSignature",
      "timestamp",
      "status",
      "totalFees",
      "withdrawals",
    ];

    for (const block of mockBlocks) {
      for (const key of detailKeys) {
        expect(block).toHaveProperty(key);
      }
    }
  });

  it("block status is either finalized or volatile", () => {
    for (const block of mockBlocks) {
      expect(["finalized", "volatile"]).toContain(block.status);
    }
  });

  it("block era is between 0 and 6", () => {
    for (const block of mockBlocks) {
      expect(block.era).toBeGreaterThanOrEqual(0);
      expect(block.era).toBeLessThanOrEqual(6);
    }
  });

  it("block sizes are positive", () => {
    for (const block of mockBlocks) {
      expect(block.size).toBeGreaterThan(0);
    }
  });

  it("block txCount is non-negative", () => {
    for (const block of mockBlocks) {
      expect(block.txCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("totalFees is non-negative", () => {
    for (const block of mockBlocks) {
      expect(block.totalFees).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Transaction data shape (for TxRow/TxDetail)
// ---------------------------------------------------------------------------

describe("Transaction data shape (for TxRow/TxDetail)", () => {
  it("mockTxs entries satisfy TxDetail fields", () => {
    const requiredKeys: (keyof TxDetail)[] = [
      "hash",
      "blockHash",
      "fee",
      "inputs",
      "outputs",
      "scripts",
      "collateral",
      "mint",
      "size",
      "validContract",
    ];

    for (const tx of mockTxs) {
      for (const key of requiredKeys) {
        expect(tx).toHaveProperty(key);
      }
    }
  });

  it("tx fees are positive", () => {
    for (const tx of mockTxs) {
      expect(tx.fee).toBeGreaterThan(0);
    }
  });

  it("tx sizes are positive", () => {
    for (const tx of mockTxs) {
      expect(tx.size).toBeGreaterThan(0);
    }
  });

  it("each tx has at least one input and one output", () => {
    for (const tx of mockTxs) {
      expect(tx.inputs.length).toBeGreaterThanOrEqual(1);
      expect(tx.outputs.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("tx hashes are valid hex strings of expected length", () => {
    for (const tx of mockTxs) {
      // Cardano tx hashes are typically 64 hex chars, but fixture data may vary
      expect(tx.hash.length).toBeGreaterThanOrEqual(64);
      expect(tx.hash).toMatch(/^[0-9a-f]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Block-Tx cross-reference
// ---------------------------------------------------------------------------

describe("Block-Tx cross-references", () => {
  it("every tx.blockHash references a valid block", () => {
    for (const tx of mockTxs) {
      const block = getMockBlockByHash(tx.blockHash);
      expect(block).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Barrel exports (verify the component barrel exports expected names)
// ---------------------------------------------------------------------------

describe("Blocks barrel exports", () => {
  it("exports expected components and types", async () => {
    const mod = await import("@/components/Blocks/index");
    expect(mod).toHaveProperty("BlockCard");
    expect(mod).toHaveProperty("BlockDetail");
    expect(mod).toHaveProperty("TxRow");
    expect(mod).toHaveProperty("TxDetailPanel");
    expect(mod).toHaveProperty("FilterBar");
  });
});
