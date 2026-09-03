import { describe, expect, test } from "bun:test";
import { ipv4NumberToString } from "./peerManager";

describe("PeerSharing IPv4 decoding", () => {
    test("decodes the raw Haskell HostAddress word in network byte order", () => {
        // PeerSharing encoded 195.49.96.166 as the raw HostAddress 0xa66031c3.
        expect(ipv4NumberToString(0xa66031c3)).toBe("195.49.96.166");
    });

    test("decodes each octet least-significant byte first", () => {
        expect(ipv4NumberToString(0x0100007f)).toBe("127.0.0.1");
    });
});
