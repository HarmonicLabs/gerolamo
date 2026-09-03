import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWindowIcon, findIconPath } from "./windowIcon";

describe("windowIcon", () => {
  test("findIconPath walks up to the bundle's Resources/appIcon.png", () => {
    const root = mkdtempSync(join(tmpdir(), "gerolamo-icon-"));
    mkdirSync(join(root, "Resources"), { recursive: true });
    writeFileSync(join(root, "Resources", "appIcon.png"), "png");
    const deep = join(root, "Resources", "app", "bun", "x");
    mkdirSync(deep, { recursive: true });
    expect(findIconPath(deep)).toBe(join(root, "Resources", "appIcon.png"));
    expect(findIconPath(mkdtempSync(join(tmpdir(), "gerolamo-noicon-")), ["nope.png"], 0)).toBeNull();
  });

  test("applyWindowIcon is a no-op without a window pointer or icon", () => {
    expect(applyWindowIcon(null)).toBe(false);
    expect(applyWindowIcon(1, { iconPath: null, from: mkdtempSync(join(tmpdir(), "gerolamo-noicon-")) })).toBe(false);
  });
});
