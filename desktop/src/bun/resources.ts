import os from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { NodeResources, ResourceSnapshot, SystemResources } from "../shared/resources";
import { nodeResourcesFromMetrics } from "../shared/resources";
import { dbSidecars } from "./wipe";

/**
 * Host + node resource sampling for the Control Center.
 * System stats come from node:os in the desktop's bun process; node stats
 * prefer `/metrics.process`, then Linux /proc by pid, then nothing.
 */

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

function sumCpu(list: CpuTimes[]): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const t of list) {
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

let lastSys: { total: number; idle: number } | null = null;

/** Host CPU busy % since the previous call; null on the first call. */
export function sampleSystemCpuPercent(cpus: () => CpuTimes[] = () => os.cpus().map((c) => c.times)): number | null {
  const cur = sumCpu(cpus());
  const prev = lastSys;
  lastSys = cur;
  if (!prev) return null;
  const total = cur.total - prev.total;
  if (total <= 0) return null;
  return round1(Math.max(0, Math.min(100, ((total - (cur.idle - prev.idle)) / total) * 100)));
}

export function systemResources(): SystemResources {
  const total = os.totalmem();
  const free = os.freemem();
  const [l1, l5, l15] = os.loadavg();
  return {
    cpus: typeof os.availableParallelism === "function" ? os.availableParallelism() : Math.max(1, os.cpus().length),
    cpuModel: os.cpus()[0]?.model?.trim() || null,
    cpuPercent: sampleSystemCpuPercent(),
    loadAvg: [round1(l1 ?? 0), round1(l5 ?? 0), round1(l15 ?? 0)],
    totalMemBytes: total,
    freeMemBytes: free,
    usedMemBytes: Math.max(0, total - free),
    platform: process.platform,
    arch: process.arch,
  };
}

/** Bytes on disk for the SQLite file and its WAL/SHM/journal sidecars. */
export function dbDiskBytes(dbPath: string | null | undefined): number | null {
  if (!dbPath) return null;
  let paths: string[];
  try {
    paths = dbSidecars(dbPath);
  } catch {
    return null;
  }
  let total = 0;
  let any = false;
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      total += statSync(p).size;
      any = true;
    } catch {
      /* ignore */
    }
  }
  return any ? total : null;
}

const CLK_TCK = 100; // Linux default; /proc/<pid>/stat utime/stime are in these ticks
const lastProc = new Map<number, { ticks: number; at: number }>();

/** Parse /proc/<pid>/stat + status. Exported for tests with fake readers. */
export function parseProcStats(
  pid: number,
  stat: string,
  status: string,
  nowMs: number,
  prev: { ticks: number; at: number } | null,
): NodeResources | null {
  // comm may contain spaces/parens: fields start after the last ")".
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 2).split(/\s+/);
  // After ")": state=f[0] ... utime=f[11] stime=f[12] (fields 14,15 in 1-based /proc numbering)
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  const ticks = utime + stime;
  let cpuPercent: number | null = null;
  if (prev && nowMs > prev.at) {
    cpuPercent = round1(Math.max(0, ((ticks - prev.ticks) / CLK_TCK / ((nowMs - prev.at) / 1000)) * 100));
  }
  const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
  const threads = Number(/^Threads:\s+(\d+)/m.exec(status)?.[1]);
  return {
    pid,
    cpuPercent,
    rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
    heapUsedBytes: null,
    heapTotalBytes: null,
    externalBytes: null,
    threads: Number.isFinite(threads) ? threads : null,
    dbBytes: null,
    uptimeSec: null,
    source: "proc",
  };
}

export function nodeResourcesFromProc(pid: number | null | undefined, nowMs = Date.now()): NodeResources | null {
  if (!pid || pid <= 0 || process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const prev = lastProc.get(pid) ?? null;
    const res = parseProcStats(pid, stat, status, nowMs, prev);
    if (!res) return null;
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(/\s+/);
    lastProc.set(pid, { ticks: Number(f[11]) + Number(f[12]), at: nowMs });
    return res;
  } catch {
    lastProc.delete(pid);
    return null;
  }
}

/** Threads reported by /proc are the truth even when metrics carry the rest. */
function procThreads(pid: number | null | undefined): number | null {
  if (!pid || pid <= 0 || process.platform !== "linux") return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const n = Number(/^Threads:\s+(\d+)/m.exec(status)?.[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function resourceSnapshot(opts: {
  running: boolean;
  pid: number | null | undefined;
  dbPath: string | null | undefined;
  metricsProcess?: unknown;
}): ResourceSnapshot {
  const system = systemResources();
  let node: NodeResources | null = null;
  if (opts.running) {
    node = nodeResourcesFromMetrics(opts.metricsProcess) ?? nodeResourcesFromProc(opts.pid);
    if (node) {
      if (node.pid == null) node.pid = opts.pid ?? null;
      if (node.threads == null) node.threads = procThreads(node.pid);
    } else {
      node = {
        pid: opts.pid ?? null,
        cpuPercent: null,
        rssBytes: null,
        heapUsedBytes: null,
        heapTotalBytes: null,
        externalBytes: null,
        threads: null,
        dbBytes: null,
        uptimeSec: null,
        source: "none",
      };
    }
  }
  const dbBytes = dbDiskBytes(opts.dbPath);
  if (node) node.dbBytes = dbBytes;
  else if (dbBytes != null) {
    // Stopped node: still show what the chain DB occupies on disk.
    node = {
      pid: null,
      cpuPercent: null,
      rssBytes: null,
      heapUsedBytes: null,
      heapTotalBytes: null,
      externalBytes: null,
      threads: null,
      dbBytes,
      uptimeSec: null,
      source: "none",
    };
  }
  return { system, node, sampledAt: Date.now() };
}
