import { describe, expect, test } from "bun:test";
import { PeerAddressIPv4, PeerSharingResponse } from "@harmoniclabs/ouroboros-miniprotocols-ts";
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
});
