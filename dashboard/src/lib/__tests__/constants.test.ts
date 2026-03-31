import { describe, it, expect, test } from "bun:test";
import {
  ERA_COLORS,
  BLOCK_STATUS_COLORS,
  NAV_ITEMS,
  API_ENDPOINTS,
} from "@/lib/constants";

// ---------------------------------------------------------------------------
// ERA_COLORS
// ---------------------------------------------------------------------------

describe("ERA_COLORS", () => {
  const EXPECTED_ERAS = [
    "Byron",
    "Shelley",
    "Allegra",
    "Mary",
    "Alonzo",
    "Babbage",
    "Conway",
  ];

  it("has entries for all 7 Cardano eras", () => {
    for (const era of EXPECTED_ERAS) {
      expect(ERA_COLORS[era]).toBeDefined();
    }
  });

  it("has exactly 7 entries", () => {
    expect(Object.keys(ERA_COLORS)).toHaveLength(7);
  });

  it("values are valid hex color strings", () => {
    for (const color of Object.values(ERA_COLORS)) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCK_STATUS_COLORS
// ---------------------------------------------------------------------------

describe("BLOCK_STATUS_COLORS", () => {
  it("has finalized, volatile, and rolled-back", () => {
    expect(BLOCK_STATUS_COLORS["finalized"]).toBeDefined();
    expect(BLOCK_STATUS_COLORS["volatile"]).toBeDefined();
    expect(BLOCK_STATUS_COLORS["rolled-back"]).toBeDefined();
  });

  it("has exactly 3 entries", () => {
    expect(Object.keys(BLOCK_STATUS_COLORS)).toHaveLength(3);
  });

  it("values are valid hex color strings", () => {
    for (const color of Object.values(BLOCK_STATUS_COLORS)) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// NAV_ITEMS
// ---------------------------------------------------------------------------

describe("NAV_ITEMS", () => {
  it("has 7 items", () => {
    expect(NAV_ITEMS).toHaveLength(7);
  });

  it("each item has id, label, and icon", () => {
    for (const item of NAV_ITEMS) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.label).toBe("string");
      expect(typeof item.icon).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
    }
  });

  it("contains the expected nav ids", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(ids).toContain("overview");
    expect(ids).toContain("blocks");
    expect(ids).toContain("peers");
    expect(ids).toContain("mempool");
    expect(ids).toContain("explorer");
    expect(ids).toContain("logs");
    expect(ids).toContain("settings");
  });

  it("has unique ids", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS
// ---------------------------------------------------------------------------

describe("API_ENDPOINTS", () => {
  const EXPECTED_KEYS = [
    "status",
    "peers",
    "blocks",
    "logs",
    "utxo",
    "deltas",
    "chainState",
    "sseStatus",
    "sseBlocks",
    "sseLogs",
  ];

  it("has all expected keys", () => {
    for (const key of EXPECTED_KEYS) {
      expect(API_ENDPOINTS).toHaveProperty(key);
    }
  });

  it("all values are strings starting with /api/", () => {
    for (const value of Object.values(API_ENDPOINTS)) {
      expect(typeof value).toBe("string");
      expect(value.startsWith("/api/")).toBe(true);
    }
  });

  it("SSE endpoints are under /api/sse/", () => {
    expect(API_ENDPOINTS.sseStatus).toMatch(/^\/api\/sse\//);
    expect(API_ENDPOINTS.sseBlocks).toMatch(/^\/api\/sse\//);
    expect(API_ENDPOINTS.sseLogs).toMatch(/^\/api\/sse\//);
  });
});
