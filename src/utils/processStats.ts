import os from "node:os";
import { readFileSync } from "node:fs";

/**
 * Resource usage of this node process and of the host, for `/metrics`.
 * All numbers are plain JSON-safe (no BigInt). CPU percentages are computed
 * from deltas between two samples: 100 = one fully busy core, so a process
 * with busy worker threads can legitimately exceed 100.
 */

export interface ProcessResources {
    pid: number;
    /** CPU since the previous sample; null on the very first sample. */
    cpuPercent: number | null;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    uptimeSec: number;
}

export interface SystemResources {
    cpus: number;
    cpuModel: string | null;
    /** Host-wide CPU busy % (0–100) since the previous sample; null on the first sample. */
    cpuPercent: number | null;
    loadAvg: [number, number, number];
    totalMemBytes: number;
    freeMemBytes: number;
    usedMemBytes: number;
    platform: string;
    arch: string;
    runtime: string;
}

/** Process CPU: user+system µs over wall-clock ms between calls. */
export function createProcessCpuSampler(
    cpuUsage: () => { user: number; system: number } = () => process.cpuUsage(),
    now: () => number = () => performance.now(),
): () => number | null {
    let last = cpuUsage();
    let lastAt = now();
    return () => {
        const cur = cpuUsage();
        const t = now();
        const elapsedMs = t - lastAt;
        const busyUs = cur.user - last.user + (cur.system - last.system);
        last = cur;
        lastAt = t;
        if (elapsedMs <= 0) return null;
        return round1(Math.max(0, (busyUs / 1000 / elapsedMs) * 100));
    };
}

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

/** Host CPU: aggregate (non-idle) / total tick delta across cores. */
/** Aggregate CPU ticks from /proc/stat (one small read) — `os.cpus()` walks /proc per core and re-reads the model (≈ 25 ms on 20 cores, 2 % of the applier at 5 s intervals). */
function hostCpuTimes(): CpuTimes[] {
    try {
        const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
        const f = line.trim().split(/\s+/);
        if (f[0] === "cpu" && f.length >= 5) {
            const n = (i: number) => Number(f[i] ?? 0);
            // user nice system idle iowait irq softirq steal
            return [{ user: n(1), nice: n(2), sys: n(3), idle: n(4) + n(5), irq: n(6) + n(7) + n(8) }];
        }
    } catch { /* not Linux */ }
    return os.cpus().map((c) => c.times);
}

export function createSystemCpuSampler(
    cpus: () => CpuTimes[] = hostCpuTimes,
    minIntervalMs = 5000,
): () => number | null {
    let last = sum(cpus());
    let lastAt = Date.now();
    let lastValue: number | null = null;
    return () => {
        // `os.cpus()` walks /proc for every core (≈ 25 ms on 20 cores): every /metrics poll
        // paid it on the applier thread (1.4 % of it). Sample at most every few seconds.
        const now = Date.now();
        if (now - lastAt < minIntervalMs) return lastValue;
        lastAt = now;
        const cur = sum(cpus());
        const total = cur.total - last.total;
        const idle = cur.idle - last.idle;
        last = cur;
        if (total <= 0) return null; // no ticks elapsed: nothing to report
        lastValue = round1(Math.max(0, Math.min(100, ((total - idle) / total) * 100)));
        return lastValue;
    };
}

function sum(list: CpuTimes[]): { total: number; idle: number } {
    let total = 0;
    let idle = 0;
    for (const t of list) {
        total += t.user + t.nice + t.sys + t.idle + t.irq;
        idle += t.idle;
    }
    return { total, idle };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function cpuCount(): number {
    return typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : Math.max(1, os.cpus().length);
}

export function processResources(cpuPercent: number | null): ProcessResources {
    const m = process.memoryUsage();
    return {
        pid: process.pid,
        cpuPercent,
        rssBytes: m.rss,
        heapUsedBytes: m.heapUsed,
        heapTotalBytes: m.heapTotal,
        externalBytes: m.external,
        arrayBuffersBytes: m.arrayBuffers ?? 0,
        uptimeSec: Math.round(process.uptime()),
    };
}

let cachedCpuModel: string | null | undefined;
/** Read once: `os.cpus()[0].model` re-populates every core's entry from /proc on each access. */
function cpuModel(): string | null {
    if (cachedCpuModel === undefined) cachedCpuModel = os.cpus()[0]?.model?.trim() || null;
    return cachedCpuModel;
}

export function systemResources(cpuPercent: number | null): SystemResources {
    const total = os.totalmem();
    const free = os.freemem();
    const [l1, l5, l15] = os.loadavg();
    const model = cpuModel();
    const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
    return {
        cpus: cpuCount(),
        cpuModel: model,
        cpuPercent,
        loadAvg: [round1(l1 ?? 0), round1(l5 ?? 0), round1(l15 ?? 0)],
        totalMemBytes: total,
        freeMemBytes: free,
        usedMemBytes: Math.max(0, total - free),
        platform: process.platform,
        arch: process.arch,
        runtime: bunVersion ? `bun ${bunVersion}` : `node ${process.versions.node}`,
    };
}

/** One sampler pair for the lifetime of the server; call `sample()` per /metrics build. */
export function createResourceSampler(): () => { process: ProcessResources; system: SystemResources } {
    const proc = createProcessCpuSampler();
    const sys = createSystemCpuSampler();
    return () => ({
        process: processResources(proc()),
        system: systemResources(sys()),
    });
}
