import { describe, expect, test } from "bun:test";
import { normalizeTopology } from "./topology";

describe("topology.json (cardano-node semantics)", () => {
    test("local root groups: valency / hotValency, warmValency default, trustable default false", () => {
        const { topology: t, warnings } = normalizeTopology({
            localRoots: [
                { accessPoints: [{ address: "127.0.0.1", port: 6424 }], advertise: false, valency: 1 }, // the live producer's shape
                { accessPoints: [{ address: "a.example", port: 3001 }, { address: "b.example", port: 3001 }], hotValency: 1, warmValency: 2, trustable: true, advertise: true },
                { accessPoints: [{ address: "10.0.0.9", port: 3001 }], valency: 1, behindFirewall: true, diffusionMode: "InitiatorOnly" },
            ],
            publicRoots: [{ accessPoints: [{ address: "p.example", port: 3001 }], advertise: false, valency: 4 }],
            useLedgerAfterSlot: 116812831,
        }, "/etc/node/topology.json");
        expect(warnings).toEqual([]);
        expect(t.localRoots[0]).toEqual({ accessPoints: [{ kind: "address", host: "127.0.0.1", port: 6424 }], advertise: false, trustable: false, hotValency: 1, warmValency: 1, behindFirewall: false, diffusionMode: "InitiatorAndResponder" });
        expect(t.localRoots[1]!.hotValency).toBe(1);
        expect(t.localRoots[1]!.warmValency).toBe(2);
        expect(t.localRoots[1]!.trustable).toBe(true);
        expect(t.localRoots[1]!.advertise).toBe(true);
        expect(t.localRoots[2]!.behindFirewall).toBe(true);
        expect(t.localRoots[2]!.diffusionMode).toBe("InitiatorOnly");
        expect(t.publicRoots[0]!.accessPoints).toEqual([{ kind: "domain", host: "p.example", port: 3001 }]);
        expect(t.bootstrapPeers).toBeNull();
        expect(t.useLedgerAfterSlot).toBe(116812831);
        expect(t.peerSnapshotFile).toBeNull();
    });

    test("useLedgerAfterSlot: absent or negative = off, 0 = always; peerSnapshotFile relative to the topology", () => {
        const base = { localRoots: [], publicRoots: [] };
        expect(normalizeTopology(base).topology.useLedgerAfterSlot).toBe(-1);
        expect(normalizeTopology({ ...base, useLedgerAfterSlot: -1 }).topology.useLedgerAfterSlot).toBe(-1);
        expect(normalizeTopology({ ...base, useLedgerAfterSlot: 0 }).topology.useLedgerAfterSlot).toBe(0);
        const r = normalizeTopology({ ...base, useLedgerAfterSlot: 0, peerSnapshotFile: "peer-snapshot.json", bootstrapPeers: [{ address: "b.example", port: 3001 }, { address: "srv.example" }] }, "/n/topology.json");
        expect(r.topology.peerSnapshotFile).toBe("/n/peer-snapshot.json");
        expect(r.topology.bootstrapPeers).toEqual([{ kind: "domain", host: "b.example", port: 3001 }, { kind: "srv", host: "srv.example" }]);
        expect(normalizeTopology({ ...base, useLedgerAfterSlot: 5, peerSnapshotFile: "/abs/s.json" }, "/n/t.json").topology.peerSnapshotFile).toBe("/abs/s.json");
        expect(normalizeTopology({ ...base, peerSnapshotFile: "s.json" }).warnings[0]).toContain("disables ledger peers");
    });

    test("malformed files are rejected; legacy Producers files are adapted; missing valency warns", () => {
        expect(() => normalizeTopology({ localRoots: [] })).toThrow("publicRoots");
        expect(() => normalizeTopology({ localRoots: {}, publicRoots: [] })).toThrow("localRoots");
        expect(() => normalizeTopology({ localRoots: [], publicRoots: [], useLedgerAfterSlot: "5" })).toThrow("useLedgerAfterSlot");
        expect(() => normalizeTopology({ localRoots: [{ accessPoints: [], valency: 1, diffusionMode: "Duplex" }], publicRoots: [] })).toThrow("diffusionMode");
        const legacy = normalizeTopology({ Producers: [{ addr: "1.2.3.4", port: 3001, valency: 2 }] }).topology;
        expect(legacy.localRoots[0]!.hotValency).toBe(2);
        expect(legacy.localRoots[0]!.accessPoints).toEqual([{ kind: "address", host: "1.2.3.4", port: 3001 }]);
        const w = normalizeTopology({ localRoots: [{ accessPoints: [{ address: "x.example", port: 1 }, { address: "0.0.0.0", port: 1 }] }], publicRoots: [] });
        expect(w.topology.localRoots[0]!.hotValency).toBe(0);
        expect(w.warnings.length).toBe(2);
    });

    test("the shipped topologies parse", async () => {
        for (const net of ["preview", "preprod", "mainnet"]) {
            const path = new URL(`../config/${net}/topology.json`, import.meta.url).pathname;
            const { topology } = normalizeTopology(await Bun.file(path).json(), path);
            expect(topology.useLedgerAfterSlot).toBeGreaterThan(0);
            expect(topology.bootstrapPeers?.length ?? 0).toBeGreaterThan(0);
        }
    });
});
