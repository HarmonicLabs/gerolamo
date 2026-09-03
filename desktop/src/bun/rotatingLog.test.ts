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

import { spawn } from "bun";
import { pumpStream } from "./rotatingLog";

describe("pumpStream (node stdout → rotating log)", () => {
  test("drains a child that writes far more than the pipe buffer, keeps every line, child exits", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "gerolamo-pump-"));
    const p = join(dir2, "daemon.log");
    const log = new RotatingLog(p, 10 * 1024 * 1024, 2);
    // 20 000 lines ≈ 1.2 MB: several times the 64 KB pipe buffer.
    const child = spawn(["bun", "-e", 'for (let i = 0; i < 20000; i++) console.log("line-" + i + " " + "x".repeat(50)); console.error("done-stderr");'], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    await Promise.all([pumpStream(child.stdout as ReadableStream<Uint8Array>, log), pumpStream(child.stderr as ReadableStream<Uint8Array>, log)]);
    const code = await child.exited;
    expect(code).toBe(0);
    const text = readFileSync(p, "utf8");
    expect(text.includes("line-0 ")).toBe(true);
    expect(text.includes("line-19999 ")).toBe(true);
    expect(text.includes("done-stderr")).toBe(true);
    expect(text.split("\n").filter((l) => l.startsWith("line-")).length).toBe(20000);
    rmSync(dir2, { recursive: true, force: true });
  });
});
