import { describe, expect, test } from "bun:test";
import { asPrometheusMetricName, haskellUtc, processMetrics, renderExposition, resolvePrometheusConfig, startPrometheusServer } from "./prometheus";
import { chainDensity, gsmState } from "./nodePrometheus";
import { PeerGovernor } from "./PeerGovernor";

describe("exposition (hermod-tracing Prometheus.Exposition, suffix mode)", () => {
    test("matches the lines cardano-node 11.0.1 serves", () => {
        const text = renderExposition([
            { name: "peerSelection.Hot", kind: "int", value: 20 },
            { name: "served.block", kind: "counter", value: 944 },
            { name: "density", kind: "real", value: 0.03511338697878566 },
            { name: "Forge.about-to-lead", kind: "counter", value: 3n },
            { name: "basicInfo", kind: "info", value: 1, labels: { nodeStartTime: "2026-09-27 00:01:00.864 UTC" } },
            { name: "rts_gc_cpu_ms", kind: "counter", value: 2585399, raw: "counter" },
        ]);
        expect(text).toBe([
            "# TYPE cardano_node_metrics_peerSelection_Hot_int gauge",
            "cardano_node_metrics_peerSelection_Hot_int 20",
            "# TYPE cardano_node_metrics_served_block_counter counter",
            "cardano_node_metrics_served_block_counter 944",
            "cardano_node_metrics_density_real 0.03511338697878566",
            "# TYPE cardano_node_metrics_Forge_about_to_lead_counter counter",
            "cardano_node_metrics_Forge_about_to_lead_counter 3",
            "# TYPE cardano_node_metrics_basicInfo info",
            'cardano_node_metrics_basicInfo{nodeStartTime="2026-09-27 00:01:00.864 UTC"} 1',
            "# TYPE rts_gc_cpu_ms counter",
            "rts_gc_cpu_ms 2585399",
            "# EOF",
            "",
        ].join("\n"));
        expect(renderExposition([{ name: "slotNum", kind: "int", value: 5 }], { noSuffix: true })).toBe("# TYPE cardano_node_metrics_slotNum gauge\ncardano_node_metrics_slotNum 5\n# EOF\n");
        expect(asPrometheusMetricName("cardano.node.metrics.Forge.node-is-leader x")).toBe("cardano_node_metrics_Forge_node_is_leader_x");
        expect(haskellUtc(Date.UTC(2026, 8, 27, 0, 1, 0, 864))).toBe("2026-09-27 00:01:00.864 UTC");
    });

    test("governor counters use the relay's peerSelection names", () => {
        const g = new PeerGovernor();
        const names = Object.keys(g.selectionCounters()).map((k) => asPrometheusMetricName(`cardano.node.metrics.peerSelection.${k}`) + "_int");
        // names read from the preview relay's /metrics (127.0.0.1:12798) on 2026-09-28
        for (const n of ["cardano_node_metrics_peerSelection_Cold_int", "cardano_node_metrics_peerSelection_KnownBigLedgerPeers_int", "cardano_node_metrics_peerSelection_WarmLocalRoots_int", "cardano_node_metrics_peerSelection_ActiveNonRootPeers_int", "cardano_node_metrics_peerSelection_EstablishedBootstrapPeers_int", "cardano_node_metrics_peerSelection_RootPeers_int"]) expect(names).toContain(n);
    });

    test("process metrics exist and are sane", () => {
        const m = processMetrics(Date.now() - 5000);
        const by = new Map(m.map((x) => [x.name, Number(x.value)]));
        expect(by.get("Mem.resident")!).toBeGreaterThan(0);
        expect(by.get("rts_gc_wall_ms")!).toBeGreaterThanOrEqual(5000);
        expect(by.get("rts_gc_max_bytes_used")!).toBeGreaterThanOrEqual(by.get("rts_gc_current_bytes_used")!);
    });
});

describe("density / GSM", () => {
    test("fragmentChainDensity over the last k blocks", () => {
        expect(chainDensity([1000n, 980n, 960n, 900n])).toBeCloseTo(3 / 100, 12);
        expect(chainDensity([5n])).toBe(0);
        expect(chainDensity([5n, 5n])).toBe(0);
        expect(gsmState(null, 100n)).toBe(0);
        expect(gsmState(99_000n, 100_000n)).toBe(2);
        expect(gsmState(50_000n, 100_000n)).toBe(1);
    });
});

describe("configuration and server", () => {
    test("the --prometheus flag beats config beats legacy hasPrometheus; off by default", () => {
        expect(resolvePrometheusConfig({}, null)).toBeNull();
        expect(resolvePrometheusConfig({ hasPrometheus: ["0.0.0.0", 12798] }, null)).toEqual({ host: "0.0.0.0", port: 12798, noSuffix: false });
        expect(resolvePrometheusConfig({ prometheus: { port: 12799, noSuffix: true } }, null)).toEqual({ host: "127.0.0.1", port: 12799, noSuffix: true });
        expect(resolvePrometheusConfig({ prometheus: { port: 12799, enabled: false } }, null)).toBeNull();
        expect(resolvePrometheusConfig({ prometheus: { port: 1 } }, "127.0.0.1:12800")).toEqual({ host: "127.0.0.1", port: 12800, noSuffix: false });
        expect(resolvePrometheusConfig({ prometheus: { port: 1 } }, "0")).toBeNull();
        expect(resolvePrometheusConfig({}, "[::1]:9100")).toEqual({ host: "::1", port: 9100, noSuffix: false });
    });

    test("serves /metrics only, with the cardano-node content type", async () => {
        const h = startPrometheusServer({ host: "127.0.0.1", port: 0 }, async () => [{ name: "slotNum", kind: "int", value: 42 }]);
        try {
            const r = await fetch(`http://127.0.0.1:${h.port}/metrics`);
            expect(r.status).toBe(200);
            expect(r.headers.get("content-type")).toBe("text/plain;version=0.0.4;charset=utf-8");
            expect(await r.text()).toContain("cardano_node_metrics_slotNum_int 42");
            expect((await fetch(`http://127.0.0.1:${h.port}/`)).status).toBe(404);
        } finally { h.stop(); }
    });
});
