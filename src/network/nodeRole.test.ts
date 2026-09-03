import { describe, expect, test } from "bun:test";
import { inboundEnabled, initiatorOnly, peerSharingAdvertised, resolveNodeRole } from "./nodeRole";

const n2n = { enabled: true as const, host: "0.0.0.0", port: 3001, maxConnections: 64, maxRangeBlocks: 256, handshakeTimeoutMs: 1, idleTimeoutMs: 1 };

describe("nodeRole", () => {
    test("default is a data node: outbound only, InitiatorOnly, no PeerSharing", () => {
        expect(resolveNodeRole({})).toBe("data");
        expect(resolveNodeRole(undefined)).toBe("data");
        expect(inboundEnabled({})).toBe(false);
        expect(initiatorOnly({})).toBe(true);
        expect(peerSharingAdvertised({})).toBe(false);
    });

    test("role: relay turns on inbound, InitiatorAndResponder and PeerSharing", () => {
        const c = { role: "relay" as const };
        expect(resolveNodeRole(c)).toBe("relay");
        expect(inboundEnabled(c)).toBe(true);
        expect(initiatorOnly(c)).toBe(false);
        expect(peerSharingAdvertised(c)).toBe(true);
    });

    test("legacy n2n.enabled without a role still counts as relay", () => {
        expect(resolveNodeRole({ n2n })).toBe("relay");
        expect(resolveNodeRole({ role: "data", n2n })).toBe("relay");
    });

    test("peerGovernor.peerSharing overrides the role default either way", () => {
        expect(peerSharingAdvertised({ role: "data", peerGovernor: { peerSharing: true } })).toBe(true);
        expect(peerSharingAdvertised({ role: "relay", peerGovernor: { peerSharing: false } })).toBe(false);
    });

    test("garbage role falls back to data", () => {
        expect(resolveNodeRole({ role: "banana" as any })).toBe("data");
    });
});
