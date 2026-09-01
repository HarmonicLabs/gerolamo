import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DATA_ROOT, assertAbsPath, normalizeDbPath, resolveRepoRoot } from "./paths";

describe("paths", () => {
  test("DATA_ROOT is under ~/.local/share/gerolamo", () => {
    expect(DATA_ROOT).toBe(join(homedir(), ".local/share/gerolamo"));
  });

  test("assertAbsPath rejects relative paths", () => {
    expect(() => assertAbsPath("data/gerolamo.db")).toThrow(/absolute/);
  });

  test("assertAbsPath rejects empty", () => {
    expect(() => assertAbsPath("")).toThrow(/required/);
  });

  test("assertAbsPath returns absolute path", () => {
    expect(assertAbsPath("/tmp/gerolamo.db")).toBe("/tmp/gerolamo.db");
  });

  test("normalizeDbPath keeps .db files", () => {
    expect(normalizeDbPath("/tmp/chain.db")).toBe("/tmp/chain.db");
  });

  test("normalizeDbPath appends gerolamo.db to a directory", () => {
    expect(normalizeDbPath("/home/bakon/.local/share/gerolamo/preprod")).toBe(
      "/home/bakon/.local/share/gerolamo/preprod/gerolamo.db",
    );
  });

  test("normalizeDbPath rejects relative", () => {
    expect(() => normalizeDbPath("data")).toThrow(/absolute/);
  });

  test("resolveRepoRoot finds src/index.ts above desktop/", () => {
    const root = resolveRepoRoot();
    expect(existsSync(join(root, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "mithril"))).toBe(true);
    expect(root.endsWith("desktop")).toBe(false);
  });
});
