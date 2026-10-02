import { describe, expect, test } from "bun:test";
import { hostHasGlobalIpv6, pickSrvTarget, resolveAccessPoint, resolveDomain, resolveSrv, type DnsBackend } from "./dnsResolve";

function backend(over: Partial<DnsBackend> = {}): DnsBackend {
    return {
        resolve4: async (h) => (h === "relay.example" ? ["3.1.1.1", "3.2.2.2", "3.1.1.1"] : h === "t1.example" ? ["4.4.4.4"] : h === "t2.example" ? ["5.5.5.5"] : []),
        resolve6: async (h) => (h === "relay.example" ? ["2A05:D014::0001"] : []),
        resolveSrv: async (n) => (n === "_cardano._tcp.pool.example"
            ? [{ name: "t1.example", port: 6001, priority: 10, weight: 1 }, { name: "t2.example", port: 6002, priority: 10, weight: 3 }, { name: "backup.example", port: 7000, priority: 20, weight: 100 }, { name: ".", port: 0, priority: 0, weight: 0 }]
            : []),
        ...over,
    };
}

describe("domain lookups (DNSActions)", () => {
    test("A only by default, A + AAAA with ipv6; deduplicated, normalised", async () => {
        expect(await resolveDomain("relay.example", { backend: backend() })).toEqual(["3.1.1.1", "3.2.2.2"]);
        expect(await resolveDomain("relay.example", { backend: backend(), ipv6: true })).toEqual(["3.1.1.1", "3.2.2.2", "2a05:d014::1"]);
        expect(await resolveDomain("10.0.0.7", { backend: backend({ resolve4: async () => { throw new Error("no"); } }) })).toEqual(["10.0.0.7"]);
    });

    test("failures and timeouts yield nothing instead of throwing", async () => {
        expect(await resolveDomain("relay.example", { backend: backend({ resolve4: async () => { throw new Error("ENOTFOUND"); } }) })).toEqual([]);
        const slow = backend({ resolve4: () => new Promise((r) => setTimeout(() => r(["9.9.9.9"]), 200)) });
        expect(await resolveDomain("relay.example", { backend: slow, timeoutMs: 20 })).toEqual([]);
    });
});

describe("SRV (srvRecordLookupWithTTL)", () => {
    test("drops '.', keeps the lowest priority, draws by weight", () => {
        const recs = [{ name: "a", port: 1, priority: 5, weight: 1 }, { name: "b", port: 2, priority: 5, weight: 3 }, { name: "c", port: 3, priority: 9, weight: 1000 }, { name: ".", port: 0, priority: 0, weight: 0 }];
        // randomR (0, 4): picks 0..1 → a, 2..4 → b
        expect(pickSrvTarget(recs, () => 0)!.name).toBe("a");
        expect(pickSrvTarget(recs, () => 0.39)!.name).toBe("a"); // floor(0.39·5) = 1
        expect(pickSrvTarget(recs, () => 0.4)!.name).toBe("b");
        expect(pickSrvTarget(recs, () => 0.999)!.name).toBe("b");
        expect(pickSrvTarget([{ name: "only", port: 9, priority: 1, weight: 0 }])!.name).toBe("only");
        expect(pickSrvTarget([{ name: ".", port: 0, priority: 0, weight: 0 }])).toBeNull();
    });

    test("resolves the drawn target with the SRV port", async () => {
        expect(await resolveSrv("_cardano._tcp.pool.example", { backend: backend(), rng: () => 0 })).toEqual([{ host: "4.4.4.4", port: 6001 }]);
        expect(await resolveSrv("_cardano._tcp.pool.example", { backend: backend(), rng: () => 0.9 })).toEqual([{ host: "5.5.5.5", port: 6002 }]);
        expect(await resolveSrv("_cardano._tcp.none.example", { backend: backend() })).toEqual([]);
        expect(await resolveAccessPoint({ kind: "srv", host: "_cardano._tcp.pool.example" }, { backend: backend(), rng: () => 0 })).toEqual([{ host: "4.4.4.4", port: 6001 }]);
        expect(await resolveAccessPoint({ kind: "address", host: "[2001:db8::1]", port: 3001 })).toEqual([{ host: "2001:db8::1", port: 3001 }]);
        expect(await resolveAccessPoint({ kind: "domain", host: "relay.example", port: 3001 }, { backend: backend() })).toEqual([{ host: "3.1.1.1", port: 3001 }, { host: "3.2.2.2", port: 3001 }]);
    });
});

describe("IPv6 reachability", () => {
    test("only a global unicast address counts", () => {
        const iface = (address: string, internal = false) => ({ address, netmask: "", family: "IPv6", mac: "", internal, cidr: null, scopeid: 0 });
        expect(hostHasGlobalIpv6({ eth0: [iface("fd08:3621:6d8f::1"), iface("fe80::1")], lo: [iface("::1", true)] } as any)).toBe(false);
        expect(hostHasGlobalIpv6({ eth0: [iface("2a01:4f8::1")] } as any)).toBe(true);
    });
});
