/**
 * Host + Gerolamo resource usage shown on the Overview.
 * `system` is sampled by the desktop's bun process (works while the node is
 * stopped). `node` comes from the node's `/metrics.process`, falling back to
 * /proc on Linux when the node predates that field or its HTTP is down.
 */

export type SystemResources = {
  cpus: number;
  cpuModel: string | null;
  /** Host busy % 0–100; null until two samples exist. */
  cpuPercent: number | null;
  loadAvg: [number, number, number];
  totalMemBytes: number;
  freeMemBytes: number;
  usedMemBytes: number;
  platform: string;
  arch: string;
};

export type NodeResources = {
  pid: number | null;
  /** % of one core (can exceed 100 with worker threads). */
  cpuPercent: number | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  externalBytes: number | null;
  threads: number | null;
  /** SQLite file + WAL/SHM sidecars on disk. */
  dbBytes: number | null;
  uptimeSec: number | null;
  source: "metrics" | "proc" | "none";
};

export type ResourceSnapshot = {
  system: SystemResources;
  node: NodeResources | null;
  sampledAt: number;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse the node's `/metrics.process` block; null when absent or malformed. */
export function nodeResourcesFromMetrics(value: unknown): NodeResources | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const rss = num(p.rssBytes);
  if (rss == null) return null;
  return {
    pid: num(p.pid),
    cpuPercent: num(p.cpuPercent),
    rssBytes: rss,
    heapUsedBytes: num(p.heapUsedBytes),
    heapTotalBytes: num(p.heapTotalBytes),
    externalBytes: num(p.externalBytes),
    threads: num(p.threads),
    dbBytes: null,
    uptimeSec: num(p.uptimeSec),
    source: "metrics",
  };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatPercent(p: number | null | undefined, digits = 0): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(digits)}%`;
}

/** Fraction 0–100 of host memory used by the node, for a bar. */
export function nodeMemShare(node: NodeResources | null, system: SystemResources): number {
  if (!node?.rssBytes || system.totalMemBytes <= 0) return 0;
  return Math.min(100, (node.rssBytes / system.totalMemBytes) * 100);
}

/** Node CPU normalised to the whole machine (100 = every core busy). */
export function nodeCpuShare(node: NodeResources | null, system: SystemResources): number {
  if (node?.cpuPercent == null || system.cpus <= 0) return 0;
  return Math.min(100, node.cpuPercent / system.cpus);
}
