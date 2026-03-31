import { describe, it, expect, test } from "bun:test";
import {
  mockBlocks,
  mockTxs,
  mockPeers,
  mockMempool,
  mockStatus,
  getMockBlockByHash,
  getMockTxByHash,
  generateMockBlocks,
} from "@/mocks/index";

// ---------------------------------------------------------------------------
// mockBlocks
// ---------------------------------------------------------------------------

describe("mockBlocks", () => {
  it("has at least 10 entries", () => {
    expect(mockBlocks.length).toBeGreaterThanOrEqual(10);
  });

  it("each block has required fields", () => {
    for (const block of mockBlocks) {
      expect(typeof block.slot).toBe("number");
      expect(typeof block.hash).toBe("string");
      expect(typeof block.prevHash).toBe("string");
      expect(typeof block.era).toBe("number");
      expect(typeof block.epoch).toBe("number");
      expect(typeof block.txCount).toBe("number");
      expect(typeof block.size).toBe("number");
    }
  });

  it("blocks have unique hashes", () => {
    const hashes = mockBlocks.map((b) => b.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("blocks are in descending slot order", () => {
    for (let i = 1; i < mockBlocks.length; i++) {
      expect(mockBlocks[i - 1].slot).toBeGreaterThan(mockBlocks[i].slot);
    }
  });
});

// ---------------------------------------------------------------------------
// mockTxs
// ---------------------------------------------------------------------------

describe("mockTxs", () => {
  it("has entries", () => {
    expect(mockTxs.length).toBeGreaterThan(0);
  });

  it("each tx has hash, fee, inputs, and outputs", () => {
    for (const tx of mockTxs) {
      expect(typeof tx.hash).toBe("string");
      expect(typeof tx.fee).toBe("number");
      expect(Array.isArray(tx.inputs)).toBe(true);
      expect(Array.isArray(tx.outputs)).toBe(true);
      expect(tx.inputs.length).toBeGreaterThan(0);
      expect(tx.outputs.length).toBeGreaterThan(0);
    }
  });

  it("each tx has unique hash", () => {
    const hashes = mockTxs.map((t) => t.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("each tx input has required fields", () => {
    for (const tx of mockTxs) {
      for (const input of tx.inputs) {
        expect(typeof input.txHash).toBe("string");
        expect(typeof input.index).toBe("number");
        expect(typeof input.address).toBe("string");
        expect(typeof input.value).toBe("string");
      }
    }
  });

  it("each tx output has required fields", () => {
    for (const tx of mockTxs) {
      for (const output of tx.outputs) {
        expect(typeof output.address).toBe("string");
        expect(typeof output.value).toBe("string");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mockMempool
// ---------------------------------------------------------------------------

describe("mockMempool", () => {
  it("has entries", () => {
    expect(mockMempool.length).toBeGreaterThan(0);
  });

  it("each mempool tx has hash, fee, size, arrivedAt, inputs, outputs, ttl", () => {
    for (const tx of mockMempool) {
      expect(typeof tx.hash).toBe("string");
      expect(typeof tx.fee).toBe("number");
      expect(typeof tx.size).toBe("number");
      expect(typeof tx.arrivedAt).toBe("string");
      expect(Array.isArray(tx.inputs)).toBe(true);
      expect(Array.isArray(tx.outputs)).toBe(true);
      expect(typeof tx.ttl).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// mockPeers
// ---------------------------------------------------------------------------

describe("mockPeers", () => {
  it("has entries", () => {
    expect(mockPeers.length).toBeGreaterThan(0);
  });

  it("each peer has required fields", () => {
    for (const peer of mockPeers) {
      expect(typeof peer.id).toBe("string");
      expect(typeof peer.host).toBe("string");
      expect(typeof peer.port).toBe("number");
      expect(typeof peer.category).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// mockStatus
// ---------------------------------------------------------------------------

describe("mockStatus", () => {
  it("has tip info", () => {
    expect(typeof mockStatus.tip.slot).toBe("number");
    expect(typeof mockStatus.tip.hash).toBe("string");
    expect(typeof mockStatus.tip.epoch).toBe("number");
    expect(typeof mockStatus.tip.era).toBe("number");
  });

  it("has sync info", () => {
    expect(typeof mockStatus.sync.progress).toBe("number");
    expect(typeof mockStatus.sync.speed).toBe("number");
    expect(typeof mockStatus.sync.startedAt).toBe("string");
  });

  it("has top-level numeric fields", () => {
    expect(typeof mockStatus.uptime).toBe("number");
    expect(typeof mockStatus.network).toBe("string");
    expect(typeof mockStatus.volatileBlocks).toBe("number");
    expect(typeof mockStatus.immutableBlocks).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// getMockBlockByHash
// ---------------------------------------------------------------------------

describe("getMockBlockByHash", () => {
  it("returns the correct block for an existing hash", () => {
    const first = mockBlocks[0];
    const found = getMockBlockByHash(first.hash);
    expect(found).toBeDefined();
    expect(found!.slot).toBe(first.slot);
  });

  it("returns undefined for a non-existent hash", () => {
    expect(getMockBlockByHash("nonexistent_hash_0000")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMockTxByHash
// ---------------------------------------------------------------------------

describe("getMockTxByHash", () => {
  it("returns the correct tx for an existing hash", () => {
    const first = mockTxs[0];
    const found = getMockTxByHash(first.hash);
    expect(found).toBeDefined();
    expect(found!.fee).toBe(first.fee);
  });

  it("returns undefined for a non-existent hash", () => {
    expect(getMockTxByHash("nonexistent_tx_hash")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateMockBlocks
// ---------------------------------------------------------------------------

describe("generateMockBlocks", () => {
  it("returns the requested count", () => {
    const blocks = generateMockBlocks(100);
    expect(blocks).toHaveLength(100);
  });

  it("each generated block has required fields", () => {
    const blocks = generateMockBlocks(5);
    for (const block of blocks) {
      expect(typeof block.slot).toBe("number");
      expect(typeof block.hash).toBe("string");
      expect(typeof block.prevHash).toBe("string");
      expect(typeof block.era).toBe("number");
      expect(typeof block.epoch).toBe("number");
      expect(typeof block.txCount).toBe("number");
      expect(typeof block.size).toBe("number");
      expect(typeof block.insertedAt).toBe("string");
    }
  });

  it("generated blocks have unique hashes", () => {
    const blocks = generateMockBlocks(100);
    const hashes = blocks.map((b) => b.hash);
    expect(new Set(hashes).size).toBe(100);
  });

  it("generated blocks have decreasing slots", () => {
    const blocks = generateMockBlocks(50);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i - 1].slot).toBeGreaterThan(blocks[i].slot);
    }
  });

  it("generated blocks form a chain via prevHash", () => {
    const blocks = generateMockBlocks(10);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].prevHash).toBe(blocks[i - 1].hash);
    }
  });

  it("returns empty array for count 0", () => {
    expect(generateMockBlocks(0)).toHaveLength(0);
  });
});
