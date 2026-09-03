import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbDiskBytes, parseProcStats, sampleSystemCpuPercent, systemResources } from "./resources";

const STAT =
  "4242 (bun src/index.ts) S 1 4242 4242 0 -1 4194560 100 0 0 0 1500 500 0 0 20 0 9 0 12345 1000000 250000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
const STATUS = "Name:\tbun\nVmRSS:\t  1024000 kB\nThreads:\t9\n";

describe("desktop resources", () => {
  test("parseProcStats reads utime/stime after a comm with spaces, RSS and threads", () => {
    const first = parseProcStats(4242, STAT, STATUS, 10_000, null);
    expect(first).not.toBeNull();
    expect(first!.cpuPercent).toBeNull();
    expect(first!.rssBytes).toBe(1024000 * 1024);
    expect(first!.threads).toBe(9);
    expect(first!.source).toBe("proc");
    // 2000 ticks at start; +200 ticks over 1s => 200%
    const later = STAT.replace(" 1500 500 ", " 1600 600 ");
    const second = parseProcStats(4242, later, STATUS, 11_000, { ticks: 2000, at: 10_000 });
    expect(second!.cpuPercent).toBe(200);
    expect(parseProcStats(1, "garbage", STATUS, 0, null)).toBeNull();
  });

  test("system CPU sampler needs two samples and clamps", () => {
    let times = [{ user: 100, nice: 0, sys: 0, idle: 900, irq: 0 }];
    expect(sampleSystemCpuPercent(() => times)).toBeNull();
    times = [{ user: 350, nice: 0, sys: 0, idle: 1650, irq: 0 }];
    expect(sampleSystemCpuPercent(() => times)).toBe(25);
  });

  test("dbDiskBytes sums the SQLite file and sidecars that exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "gerolamo-res-"));
    const db = join(dir, "gerolamo.db");
    expect(dbDiskBytes(db)).toBeNull();
    writeFileSync(db, Buffer.alloc(1000));
    writeFileSync(`${db}-wal`, Buffer.alloc(24));
    expect(dbDiskBytes(db)).toBe(1024);
    expect(dbDiskBytes(null)).toBeNull();
    expect(dbDiskBytes("relative/path.db")).toBeNull();
  });

  test("systemResources is plausible", () => {
    const s = systemResources();
    expect(s.cpus).toBeGreaterThan(0);
    expect(s.totalMemBytes).toBeGreaterThan(0);
    expect(s.usedMemBytes + s.freeMemBytes).toBe(s.totalMemBytes);
  });
});
