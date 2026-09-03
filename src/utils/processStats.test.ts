import { describe, expect, test } from "bun:test";
import {
    createProcessCpuSampler,
    createResourceSampler,
    createSystemCpuSampler,
    processResources,
    systemResources,
} from "./processStats";

describe("processStats", () => {
    test("process CPU % is busy-µs over wall-ms; first sample after construction is a real delta", () => {
        let usage = { user: 0, system: 0 };
        let t = 1000;
        const sample = createProcessCpuSampler(() => usage, () => t);
        // 500ms wall, 250ms user + 250ms sys => 100% of one core
        usage = { user: 250_000, system: 250_000 };
        t += 500;
        expect(sample()).toBe(100);
        // 1000ms wall, 2500ms CPU => 250% (worker threads)
        usage = { user: 2_500_000, system: 500_000 };
        t += 1000;
        expect(sample()).toBe(250);
        // no wall time elapsed => null, never divide by zero
        expect(sample()).toBeNull();
    });

    test("system CPU % aggregates cores and clamps to 0..100", () => {
        let times = [
            { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 },
            { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 },
        ];
        const sample = createSystemCpuSampler(() => times);
        times = [
            { user: 600, nice: 0, sys: 50, idle: 850, irq: 0 }, // +500 busy
            { user: 0, nice: 0, sys: 0, idle: 1500, irq: 0 }, // +500 idle
        ];
        expect(sample()).toBe(50);
        expect(sample()).toBeNull();
    });

    test("snapshots are JSON-safe and plausible", () => {
        const p = processResources(12.5);
        expect(p.pid).toBe(process.pid);
        expect(p.rssBytes).toBeGreaterThan(0);
        // JSC may report heapUsed > heapTotal between collections; only require presence.
        expect(p.heapTotalBytes).toBeGreaterThan(0);
        expect(p.heapUsedBytes).toBeGreaterThan(0);
        const s = systemResources(null);
        expect(s.cpus).toBeGreaterThan(0);
        expect(s.totalMemBytes).toBeGreaterThan(s.freeMemBytes);
        expect(s.usedMemBytes + s.freeMemBytes).toBe(s.totalMemBytes);
        expect(s.loadAvg).toHaveLength(3);
        expect(s.runtime.startsWith("bun ")).toBe(true);
        expect(() => JSON.stringify(createResourceSampler()())).not.toThrow();
    });
});
