import { describe, expect, test } from "bun:test";
import {
    accessPointFromJson, formatHostPort, ipv6FromBytes, ipv6FromLedgerBytes, ipv6FromWords, ipv6ToBytes, ipv6ToLedgerBytes, ipv6ToWords,
    isValidDestination, normalizeHost, parseHostPort, prefixSrv,
} from "./relayAccessPoint";
import { peerKey } from "./PeerGovernor";
import { hostOfPeerKey } from "../consensus/CandidateSet";

describe("IPv6 helpers", () => {
    test("RFC 5952 text round trip (::, embedded IPv4, zone ids, brackets)", () => {
        for (const [inp, out] of [
            ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
            ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
            ["::", "::"], ["::1", "::1"], ["[2a05:d014::1]", "2a05:d014::1"], ["fe80::1%eth0", "fe80::1"],
            ["2001:db8::1:0:0:1", "2001:db8::1:0:0:1"], // leftmost of equal zero runs? RFC: longest, first if tie → 2001:db8::1:0:0:1
        ] as const) expect(normalizeHost(inp)).toBe(out);
        expect(normalizeHost("::ffff:192.0.2.7")).toBe("192.0.2.7"); // v4-mapped (dual-stack listener)
        expect(ipv6FromBytes(ipv6ToBytes("::ffff:1.2.3.4")!)).toBe("::ffff:102:304");
        expect(ipv6ToBytes("not-an-ip")).toBeNull();
    });

    test("PeerSharing words are big-endian 32-bit groups (network-socket HostAddress6)", () => {
        expect(ipv6ToWords("2a05:d014:1cfa:bc01:e47e:2366:1208:625a")).toEqual([0x2a05d014, 0x1cfabc01, 0xe47e2366, 0x1208625a]);
        expect(ipv6FromWords([0x2a05d014, 0x1cfabc01, 0xe47e2366, 0x1208625a])).toBe("2a05:d014:1cfa:bc01:e47e:2366:1208:625a");
        expect(ipv6FromWords([0x20010db8, 0, 0, 1n])).toBe("2001:db8::1");
        expect(ipv6FromWords([1, 2, 3])).toBeNull();
    });

    test("ledger bytes are little-endian words (cardano-ledger-binary ipv6ToBytes)", () => {
        const b = ipv6ToLedgerBytes("2001:db8::1")!;
        expect(Buffer.from(b).toString("hex")).toBe("b80d0120000000000000000001000000");
        expect(ipv6FromLedgerBytes(b)).toBe("2001:db8::1");
        expect(ipv6FromLedgerBytes(new Uint8Array(15))).toBeNull();
    });
});

describe("host:port keys", () => {
    test("IPv6 keys are bracketed and parse back; other code finds the host", () => {
        expect(formatHostPort("2001:db8::1", 3001)).toBe("[2001:db8::1]:3001");
        expect(peerKey("2001:0db8::0001", 3001n)).toBe("[2001:db8::1]:3001");
        expect(peerKey("::ffff:10.0.0.1", 6000)).toBe("10.0.0.1:6000");
        expect(peerKey("relay.example", 3001)).toBe("relay.example:3001");
        expect(parseHostPort("[2001:db8::1]:3001")).toEqual({ host: "2001:db8::1", port: 3001 });
        expect(parseHostPort("1.2.3.4:6000")).toEqual({ host: "1.2.3.4", port: 6000 });
        expect(parseHostPort("::ffff:1.2.3.4:6000")).toEqual({ host: "1.2.3.4", port: 6000 }); // legacy unbracketed key
        expect(parseHostPort("1.2.3.4:0")).toBeNull();
        expect(hostOfPeerKey(peerKey("2001:db8::1", 3001))).toBe("2001:db8::1");
    });
});

describe("access points (FromJSON RelayAccessPoint)", () => {
    test("address / domain / SRV by the presence of port; invalid destinations dropped", () => {
        expect(accessPointFromJson({ address: "1.2.3.4", port: 3001 })).toEqual({ kind: "address", host: "1.2.3.4", port: 3001 });
        expect(accessPointFromJson({ address: "2001:db8::1", port: 3001 })).toEqual({ kind: "address", host: "2001:db8::1", port: 3001 });
        expect(accessPointFromJson({ address: "relay.example.", port: 3001 })).toEqual({ kind: "domain", host: "relay.example", port: 3001 });
        expect(accessPointFromJson({ address: "_cardano._tcp.example.org" })).toEqual({ kind: "srv", host: "_cardano._tcp.example.org" });
        expect(accessPointFromJson({ domain: "old.snapshot.example", port: 1338 })).toEqual({ kind: "domain", host: "old.snapshot.example", port: 1338 });
        expect(accessPointFromJson({ address: "0.0.0.0", port: 3001 })).toBeNull();
        expect(accessPointFromJson({ address: "::", port: 3001 })).toBeNull();
        expect(accessPointFromJson({ address: "1.2.3.4", port: 70000 })).toBeNull();
        expect(accessPointFromJson({ port: 3001 })).toBeNull();
        expect(isValidDestination("10.0.0.1")).toBe(true);
        expect(prefixSrv("example.org.")).toBe("_cardano._tcp.example.org");
    });
});
