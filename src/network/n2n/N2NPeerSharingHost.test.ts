import { describe, expect, test } from "bun:test";
import { Cbor } from "@harmoniclabs/cbor";
import { PeerAddressIPv4, PeerAddressIPv6, PeerSharingResponse } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { N2NPeerSharingHost, ipv4ToWord32 } from "./N2NPeerSharingHost";
import { ipv4NumberToString, peerAddressToHostPort } from "../peerManager";

describe("N2NPeerSharingHost", () => {
    test("ipv4ToWord32 is the exact inverse of the decoder used for received addresses", () => {
        for (const ip of ["3.126.235.206", "192.168.0.1", "255.255.255.255", "0.0.0.0", "10.0.0.7"]) {
            const w = ipv4ToWord32(ip)!;
            expect(ipv4NumberToString(w)).toBe(ip);
        }
        expect(ipv4ToWord32("2a05::1")).toBeNull();
        expect(ipv4ToWord32("1.2.3")).toBeNull();
        expect(ipv4ToWord32("1.2.3.999")).toBeNull();
    });

    test("buildResponse hands out at most `amount` valid IPv4 peers that round-trip through the client decoder", () => {
        const provider = () => [
            { host: "3.126.235.206", port: 3001 },
            { host: "relay.example", port: 3001 }, // hostname: not shareable
            { host: "54.194.143.142", port: 30000 },
            { host: "1.2.3.4", port: 0 }, // bad port
            { host: "5.6.7.8", port: 3001 },
        ];
        const resp = N2NPeerSharingHost.buildResponse(provider, 2);
        expect(resp).toBeInstanceOf(PeerSharingResponse);
        expect(resp.peerAddresses).toHaveLength(2);
        const decoded = resp.peerAddresses.map((a) => peerAddressToHostPort(a));
        expect(decoded).toEqual([{ host: "3.126.235.206", port: 3001 }, { host: "54.194.143.142", port: 30000 }]);
        // wire round-trip
        const again = PeerSharingResponse.fromCborObj(resp.toCborObj());
        expect(again.peerAddresses[0]).toBeInstanceOf(PeerAddressIPv4);
        expect(peerAddressToHostPort(again.peerAddresses[1]!)).toEqual({ host: "54.194.143.142", port: 30000 });
        expect(N2NPeerSharingHost.buildResponse(provider, 0).peerAddresses).toHaveLength(0);
        expect(N2NPeerSharingHost.buildResponse(() => [], 10).peerAddresses).toHaveLength(0);
    });

    test("IPv6 peers are shared as [1, w1, w2, w3, w4, port] and decode back", () => {
        const resp = N2NPeerSharingHost.buildResponse(() => [
            { host: "2a05:d014:1cfa:bc01:e47e:2366:1208:625a", port: 3001 },
            { host: "[2001:db8::1]", port: 6000 },
            { host: "::ffff:10.0.0.9", port: 3001 }, // v4-mapped → shared as IPv4
        ], 10);
        expect(resp.peerAddresses).toHaveLength(3);
        expect(resp.peerAddresses[0]).toBeInstanceOf(PeerAddressIPv6);
        expect(resp.peerAddresses[2]).toBeInstanceOf(PeerAddressIPv4);
        const wire = Cbor.encode(resp.peerAddresses[0]!.toCborObj()).toString();
        // [1, 0x2a05d014, 0x1cfabc01, 0xe47e2366, 0x1208625a, 3001]
        expect(wire).toBe("86011a2a05d0141a1cfabc011ae47e23661a1208625a190bb9");
        const again = PeerSharingResponse.fromCborObj(resp.toCborObj());
        expect(again.peerAddresses.map((a) => peerAddressToHostPort(a))).toEqual([
            { host: "2a05:d014:1cfa:bc01:e47e:2366:1208:625a", port: 3001 },
            { host: "2001:db8::1", port: 6000 },
            { host: "10.0.0.9", port: 3001 },
        ]);
    });
});
