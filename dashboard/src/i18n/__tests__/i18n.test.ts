import { describe, it, expect, test } from "bun:test";
import { t, getLocale, setLocale, registerLocale } from "@/i18n/index";
import enUS from "@/i18n/en-US.json";

// ---------------------------------------------------------------------------
// t() — translation lookup
// ---------------------------------------------------------------------------

describe("t()", () => {
  it("returns translated string for known key", () => {
    expect(t("nav.overview")).toBe("Overview");
    expect(t("nav.blocks")).toBe("Blocks");
    expect(t("common.slot")).toBe("Slot");
  });

  it("returns the key itself for unknown key", () => {
    const unknownKey = "this.key.does.not.exist";
    expect(t(unknownKey)).toBe(unknownKey);
  });
});

// ---------------------------------------------------------------------------
// en-US.json completeness
// ---------------------------------------------------------------------------

describe("en-US translations", () => {
  const NAV_KEYS = [
    "nav.overview",
    "nav.blocks",
    "nav.peers",
    "nav.mempool",
    "nav.explorer",
    "nav.logs",
    "nav.settings",
  ];

  it("contains all nav keys", () => {
    const dict = enUS as Record<string, string>;
    for (const key of NAV_KEYS) {
      expect(dict[key]).toBeDefined();
    }
  });

  it("contains common keys", () => {
    const COMMON_KEYS = [
      "common.slot",
      "common.hash",
      "common.epoch",
      "common.era",
      "common.transactions",
      "common.fee",
      "common.status",
    ];
    const dict = enUS as Record<string, string>;
    for (const key of COMMON_KEYS) {
      expect(dict[key]).toBeDefined();
    }
  });

  it("contains status keys", () => {
    const dict = enUS as Record<string, string>;
    expect(dict["status.syncing"]).toBeDefined();
    expect(dict["status.synced"]).toBeDefined();
    expect(dict["status.finalized"]).toBeDefined();
    expect(dict["status.volatile"]).toBeDefined();
  });

  it("contains a11y keys", () => {
    const dict = enUS as Record<string, string>;
    expect(dict["a11y.skipToContent"]).toBeDefined();
    expect(dict["a11y.toggleNav"]).toBeDefined();
  });

  it("all values are non-empty strings", () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getLocale / setLocale
// ---------------------------------------------------------------------------

describe("getLocale / setLocale", () => {
  it("defaults to en-US", () => {
    expect(getLocale()).toBe("en-US");
  });

  it("registerLocale + setLocale changes locale", () => {
    registerLocale("test-XX", { "nav.overview": "Test Overview" });
    setLocale("test-XX");
    expect(getLocale()).toBe("test-XX");
    expect(t("nav.overview")).toBe("Test Overview");

    // Restore default
    setLocale("en-US");
    expect(getLocale()).toBe("en-US");
  });

  it("setLocale with unregistered locale stays on current", () => {
    const before = getLocale();
    setLocale("nonexistent-ZZ");
    expect(getLocale()).toBe(before);
  });
});
