/**
 * Prometheus text exposition with cardano-node's metric names, on its own host:port (like
 * cardano-node's `hasPrometheus` / `PrometheusSimple` backend). The JSON `/metrics` document on
 * the HTTP API port is a different thing and stays as it is (the watchdog reads it).
 *
 * Names and format follow hermod-tracing `Cardano.Logging.Prometheus.Exposition` as the preview
 * relay (cardano-node 11.0.1, `TraceOptionMetricsPrefix "cardano.node.metrics."`,
 * `PrometheusSimple suffix`) serves them: prefix + trace-metric name + `_int` (gauge) /
 * `_counter` (counter) / `_real` (no TYPE line); ' ', '-' and '.' become '_'; label metrics
 * are `info`; the document ends with `# EOF`. `noSuffix` drops the suffixes (cardano-node's
 * `PrometheusSimple nosuffix`). GHC RTS metrics have Bun equivalents only in part: heap and RSS
 * figures, CPU time; there is no GC count or allocation counter in Bun, so those are absent.
 */
import { settings } from "../config/settings";
import { readFileSync } from "node:fs";
import { logger } from "../utils/logger";

export type MetricKind = "int" | "counter" | "real" | "info";
export interface Metric {
    /** Trace-metric name (dots allowed), e.g. `peerSelection.Hot`, `Forge.forged`. */
    name: string;
    kind: MetricKind;
    value: number | bigint;
    labels?: Record<string, string>;
    /** Emit exactly this name (RTS gauges/counters, `rts_gc_*`), with the given TYPE. */
    raw?: "gauge" | "counter";
}

export const CARDANO_METRICS_PREFIX = "cardano.node.metrics.";

/** hermod-tracing `asPrometheusMetricName`. */
export function asPrometheusMetricName(name: string): string {
    return name.replace(/[ .-]/g, "_").replace(/[^A-Za-z0-9_]/g, "");
}

function fmt(v: number | bigint, kind: MetricKind): string {
    if (typeof v === "bigint") return v.toString();
    if (kind === "real") return Number.isFinite(v) ? String(v) : "0";
    return Number.isFinite(v) ? String(Math.trunc(v)) : "0";
}

function escapeLabel(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `renderExpositionFromSample`: one TYPE line per gauge / counter / info metric, reals bare, `# EOF` last. */
export function renderExposition(metrics: Metric[], opts: { prefix?: string; noSuffix?: boolean } = {}): string {
    const prefix = opts.prefix ?? CARDANO_METRICS_PREFIX;
    let out = "";
    for (const m of metrics) {
        if (m.raw) {
            const n = asPrometheusMetricName(m.name);
            out += `# TYPE ${n} ${m.raw}\n${n} ${fmt(m.value, m.raw === "gauge" ? "int" : "counter")}\n`;
            continue;
        }
        const suffix = opts.noSuffix || m.kind === "info" ? "" : m.kind === "int" ? "_int" : m.kind === "counter" ? "_counter" : "_real";
        const n = asPrometheusMetricName(prefix + m.name) + suffix;
        if (m.kind === "info") {
            const labels = Object.entries(m.labels ?? {}).map(([k, v]) => `${asPrometheusMetricName(k)}="${escapeLabel(v)}"`).join(",");
            out += `# TYPE ${n} info\n${n}{${labels}} 1\n`;
        } else if (m.kind === "real") out += `${n} ${fmt(m.value, "real")}\n`;
        else out += `# TYPE ${n} ${m.kind === "int" ? "gauge" : "counter"}\n${n} ${fmt(m.value, m.kind)}\n`;
    }
    return out + "# EOF\n";
}

/** Haskell `show UTCTime` style: `2026-09-27 00:01:00.864 UTC`. */
export function haskellUtc(ms: number): string {
    return new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
}

let peakHeapUsed = 0;

/** Bun-side stand-ins for the GHC RTS / resource metrics where one exists. */
export function processMetrics(startedAtMs: number): Metric[] {
    const mem = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, mem.heapUsed);
    const cpu = process.cpuUsage(); // µs
    const cpuMs = (cpu.user + cpu.system) / 1000;
    let maxRssKb = 0;
    try { maxRssKb = Number(process.resourceUsage().maxRSS) || 0; } catch { /* not supported */ }
    const out: Metric[] = [
        { name: "Mem.resident", kind: "int", value: mem.rss },
        { name: "RTS.gcLiveBytes", kind: "int", value: mem.heapUsed },
        { name: "RTS.gcHeapBytes", kind: "int", value: mem.heapTotal },
        // /proc/self/stat utime+stime is in clock ticks (100 Hz)
        { name: "Stat.cputicks", kind: "int", value: Math.round(cpuMs / 10) },
        { name: "rts_gc_current_bytes_used", kind: "int", value: mem.heapUsed, raw: "gauge" },
        { name: "rts_gc_max_bytes_used", kind: "int", value: peakHeapUsed, raw: "gauge" },
        { name: "rts_gc_peak_megabytes_allocated", kind: "int", value: Math.round(Math.max(maxRssKb / 1024, mem.rss / 1048576)), raw: "gauge" },
        { name: "rts_gc_cpu_ms", kind: "counter", value: Math.round(cpuMs), raw: "counter" },
        { name: "rts_gc_wall_ms", kind: "counter", value: Math.max(0, Date.now() - startedAtMs), raw: "counter" },
    ];
    try {
        // Linux: bytes this process caused to be read from / written to storage
        const io = readFileSync("/proc/self/io", "utf8");
        const rd = /read_bytes:\s*(\d+)/.exec(io), wr = /write_bytes:\s*(\d+)/.exec(io);
        if (rd) out.push({ name: "Stat.fsRd", kind: "int", value: Number(rd[1]) });
        if (wr) out.push({ name: "Stat.fsWr", kind: "int", value: Number(wr[1]) });
    } catch { /* not Linux */ }
    return out;
}

export interface PrometheusConfig { host: string; port: number; noSuffix?: boolean }

/**
 * Where to serve, from (in order) the --prometheus flag (host:port, a port, or off), config `prometheus: {host, port,
 * noSuffix}`, or the cardano-node legacy key `hasPrometheus: [host, port]`. null = off.
 */
export function resolvePrometheusConfig(config: { prometheus?: unknown; hasPrometheus?: unknown } | undefined, override: string | null = settings().prometheus): PrometheusConfig | null {
    const e = override?.trim();
    if (e === "0" || e === "off") return null;
    const parse = (host: unknown, port: unknown, noSuffix?: unknown): PrometheusConfig | null => {
        const p = Number(port);
        if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
        const h = typeof host === "string" && host.trim() ? host.trim() : "127.0.0.1";
        return { host: h, port: p, noSuffix: noSuffix === true };
    };
    if (e) {
        const i = e.lastIndexOf(":");
        const r = i > 0 ? parse(e.slice(0, i).replace(/^\[|\]$/g, ""), e.slice(i + 1)) : parse("127.0.0.1", e);
        if (r) return r;
        logger.warn(`--prometheus ${e} is not host:port; Prometheus endpoint off`);
        return null;
    }
    const pc = config?.prometheus;
    if (pc && typeof pc === "object") {
        const o = pc as { enabled?: unknown; host?: unknown; port?: unknown; noSuffix?: unknown };
        if (o.enabled === false) return null;
        return parse(o.host, o.port, o.noSuffix);
    }
    const hp = config?.hasPrometheus;
    if (Array.isArray(hp) && hp.length >= 2) return parse(hp[0], hp[1]);
    return null;
}

export interface PrometheusHandle { host: string; port: number; stop(): void }

/** Serve `GET /metrics` (404 elsewhere, like cardano-node) from `collect()`. */
export function startPrometheusServer(cfg: PrometheusConfig, collect: () => Promise<Metric[]>): PrometheusHandle {
    const server = Bun.serve({
        hostname: cfg.host,
        port: cfg.port,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname !== "/metrics") return new Response("404 Not Found", { status: 404 });
            try {
                const body = renderExposition(await collect(), { noSuffix: cfg.noSuffix });
                return new Response(body, { headers: { "Content-Type": "text/plain;version=0.0.4;charset=utf-8" } });
            } catch (err) {
                logger.warn(`Prometheus scrape failed: ${(err as Error)?.message ?? err}`);
                return new Response("scrape failed", { status: 500 });
            }
        },
    });
    logger.info(`Prometheus metrics on http://${cfg.host}:${server.port}/metrics`);
    return { host: cfg.host, port: Number(server.port), stop: () => server.stop(true) };
}
