import { describe, it, expect, test } from "bun:test";
import {
  ERA_NAMES,
  ERA_COLORS,
  HEALTH_COLORS,
  VOLATILE_WINDOW,
  EASE_SMOOTH,
  SCROLL_DURATION_MS,
} from "@/components/Diagram/types";

// ---------------------------------------------------------------------------
// ERA_NAMES
// ---------------------------------------------------------------------------

describe("ERA_NAMES", () => {
  it("has 7 entries (indices 0-6)", () => {
    expect(Object.keys(ERA_NAMES)).toHaveLength(7);
  });

  it("maps all era indices to correct names", () => {
    expect(ERA_NAMES[0]).toBe("Byron");
    expect(ERA_NAMES[1]).toBe("Shelley");
    expect(ERA_NAMES[2]).toBe("Allegra");
    expect(ERA_NAMES[3]).toBe("Mary");
    expect(ERA_NAMES[4]).toBe("Alonzo");
    expect(ERA_NAMES[5]).toBe("Babbage");
    expect(ERA_NAMES[6]).toBe("Conway");
  });
});

// ---------------------------------------------------------------------------
// ERA_COLORS (numeric keys)
// ---------------------------------------------------------------------------

describe("ERA_COLORS (Diagram)", () => {
  it("has 7 entries matching ERA_NAMES", () => {
    expect(Object.keys(ERA_COLORS)).toHaveLength(7);
  });

  it("every numeric era index has a hex color", () => {
    for (let i = 0; i <= 6; i++) {
      expect(ERA_COLORS[i]).toBeDefined();
      expect(ERA_COLORS[i]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// HEALTH_COLORS
// ---------------------------------------------------------------------------

describe("HEALTH_COLORS", () => {
  it("has finalized, volatile, and rolled-back", () => {
    expect(HEALTH_COLORS["finalized"]).toBeDefined();
    expect(HEALTH_COLORS["volatile"]).toBeDefined();
    expect(HEALTH_COLORS["rolled-back"]).toBeDefined();
  });

  it("has exactly 3 entries", () => {
    expect(Object.keys(HEALTH_COLORS)).toHaveLength(3);
  });

  it("values are valid hex color strings", () => {
    for (const color of Object.values(HEALTH_COLORS)) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// VOLATILE_WINDOW
// ---------------------------------------------------------------------------

describe("VOLATILE_WINDOW", () => {
  it("equals 2160 (Ouroboros k parameter)", () => {
    expect(VOLATILE_WINDOW).toBe(2160);
  });
});

// ---------------------------------------------------------------------------
// Animation constants
// ---------------------------------------------------------------------------

describe("Animation constants", () => {
  it("EASE_SMOOTH is a non-empty string", () => {
    expect(typeof EASE_SMOOTH).toBe("string");
    expect(EASE_SMOOTH.length).toBeGreaterThan(0);
  });

  it("SCROLL_DURATION_MS is a positive number", () => {
    expect(typeof SCROLL_DURATION_MS).toBe("number");
    expect(SCROLL_DURATION_MS).toBeGreaterThan(0);
  });
});
