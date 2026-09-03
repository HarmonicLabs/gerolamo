import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatPercent,
  nodeCpuShare,
  nodeCoresBusy,
  formatCores,
  nodeMemShare,
  nodeResourcesFromMetrics,
  type SystemResources,
} from "./resources";

const sys: SystemResources = {
  cpus: 8,
  cpuModel: "test",
  cpuPercent: 10,
  loadAvg: [1, 1, 1],
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 8 * 1024 ** 3,
  usedMemBytes: 8 * 1024 ** 3,
  platform: "linux",
  arch: "x64",
};

describe("resources", () => {
  test("formatBytes picks the unit and never throws on junk", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatPercent(12.34, 1)).toBe("12.3%");
    expect(formatPercent(null)).toBe("—");
  });

  test("metrics.process parses to NodeResources; missing block is null", () => {
    expect(nodeResourcesFromMetrics(undefined)).toBeNull();
    expect(nodeResourcesFromMetrics({ pid: 1 })).toBeNull();
    const n = nodeResourcesFromMetrics({
      pid: 4242,
      cpuPercent: 180.5,
      rssBytes: 900_000_000,
      heapUsedBytes: 100,
      heapTotalBytes: 200,
      externalBytes: 5,
      uptimeSec: 42,
    });
    expect(n).not.toBeNull();
    expect(n!.source).toBe("metrics");
    expect(n!.pid).toBe(4242);
    expect(n!.cpuPercent).toBe(180.5);
    expect(n!.rssBytes).toBe(900_000_000);
    expect(n!.dbBytes).toBeNull();
    expect(n!.threads).toBeNull();
  });

  test("shares normalise node usage against the host", () => {
    const n = nodeResourcesFromMetrics({ rssBytes: 4 * 1024 ** 3, cpuPercent: 400 })!;
    expect(nodeMemShare(n, sys)).toBe(25);
    expect(nodeCpuShare(n, sys)).toBe(50);
    expect(nodeMemShare(null, sys)).toBe(0);
    expect(nodeCpuShare({ ...n, cpuPercent: null }, sys)).toBe(0);
  });
});

describe("nodeCoresBusy / formatCores", () => {
  test("cpuPercent is per core: 1345% is 13 cores busy, 45% is 0.5", () => {
    const base = { pid: 1, rssBytes: 1, heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, threads: null, dbBytes: null, uptimeSec: null, source: "metrics" as const };
    expect(formatCores(nodeCoresBusy({ ...base, cpuPercent: 1345 }))).toBe("13");
    expect(formatCores(nodeCoresBusy({ ...base, cpuPercent: 45 }))).toBe("0.5");
    expect(formatCores(nodeCoresBusy({ ...base, cpuPercent: null }))).toBe("—");
    expect(formatCores(nodeCoresBusy(null))).toBe("—");
  });
});
