import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotatingLog } from "./rotatingLog";

const dir = mkdtempSync(join(tmpdir(), "gerolamo-rotlog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RotatingLog", () => {
  test("rotates by size and keeps N generations, newest first", () => {
    const p = join(dir, "daemon.log");
    const log = new RotatingLog(p, 100, 2);
    for (let i = 0; i < 10; i++) log.append(`chunk-${i} ${"x".repeat(40)}\n`);
    expect(existsSync(p)).toBe(true);
    expect(existsSync(join(dir, "daemon.1.log"))).toBe(true);
    expect(existsSync(join(dir, "daemon.2.log"))).toBe(true);
    expect(existsSync(join(dir, "daemon.3.log"))).toBe(false);
    const cur = readFileSync(p, "utf8");
    const one = readFileSync(join(dir, "daemon.1.log"), "utf8");
    expect(cur.includes("chunk-9")).toBe(true);
    expect(one < cur || one.includes("chunk-")).toBe(true);
    expect(Buffer.byteLength(cur)).toBeLessThanOrEqual(100);
  });

  test("never throws when the directory is unwritable", () => {
    const log = new RotatingLog("/proc/definitely/not/here/daemon.log", 10, 1);
    expect(() => log.append("x")).not.toThrow();
  });
});
