import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailFileLines, tailFileText } from "./tailFile";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tailFileLines", () => {
  test("returns the last N lines exactly, like readFileSync().split().slice(-N)", () => {
    const p = join(dir, "a.log");
    const all = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(i % 90)}`);
    writeFileSync(p, all.join("\n") + "\n");
    const expected = (all.join("\n") + "\n").split(/\r?\n/).slice(-200);
    expect(tailFileLines(p, 200)).toEqual(expected);
    expect(tailFileLines(p, 3)).toEqual(expected.slice(-3));
  });

  test("small window is grown until enough lines exist (long lines)", () => {
    const p = join(dir, "long.log");
    const all = Array.from({ length: 300 }, (_, i) => `${i}:${"y".repeat(5000)}`);
    writeFileSync(p, all.join("\n"));
    const got = tailFileLines(p, 50, 1024); // 1 KB window at first
    expect(got).toEqual(all.slice(-50));
  });

  test("never returns a partial first line from inside the window", () => {
    const p = join(dir, "partial.log");
    writeFileSync(p, Array.from({ length: 100_000 }, (_, i) => `entry-${i}`).join("\n"));
    const got = tailFileLines(p, 10);
    expect(got.length).toBe(10);
    expect(got[0]).toBe("entry-99990");
    expect(got.at(-1)).toBe("entry-99999");
  });

  test("file shorter than the request and missing file", () => {
    const p = join(dir, "short.log");
    writeFileSync(p, "a\nb\nc");
    expect(tailFileLines(p, 10)).toEqual(["a", "b", "c"]);
    expect(tailFileLines(join(dir, "nope.log"), 10)).toEqual([]);
    expect(tailFileText(p, 2)).toBe("b\nc");
  });
});
