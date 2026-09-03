import { describe, expect, test } from "bun:test";
import { expandAccessPoint } from "./peerManager";
import { PeerGovernor } from "./PeerGovernor";

describe("bootstrap DNS fan-out", () => {
    test("a round-robin name becomes one peer per IPv4 record, deduplicated", async () => {
        const hosts = await expandAccessPoint("relay.example", async () => [
            "3.1.1.1", "3.2.2.2", "3.1.1.1", "2a05::1",
        ]);
        expect(hosts).toEqual(["3.1.1.1", "3.2.2.2"]);
    });

    test("literal IPs and failed lookups pass through unchanged", async () => {
        expect(await expandAccessPoint("10.0.0.7", async () => { throw new Error("no"); })).toEqual(["10.0.0.7"]);
        expect(await expandAccessPoint("relay.example", async () => { throw new Error("ENOTFOUND"); })).toEqual(["relay.example"]);
        expect(await expandAccessPoint("relay.example", async () => [])).toEqual(["relay.example"]);
        expect(await expandAccessPoint("  ", async () => ["1.1.1.1"])).toEqual([]);
    });
});

describe("PeerGovernor.pruneFailedSharedPeers", () => {
    test("forgets shared cold peers at the failure cap, keeps trusted and fresh ones", () => {
        const g = new PeerGovernor();
        g.noteKnown("relay.example", 3001, "bootstrap", false);
        g.noteKnown("1.1.1.1", 23552, "shared", false);
        g.noteKnown("2.2.2.2", 3001, "shared", false);
        for (let i = 0; i < 3; i++) {
            g.markFail("1.1.1.1:23552", "handshake timed out");
            g.markFail("relay.example:3001", "handshake timed out");
        }
        g.markFail("2.2.2.2:3001", "once");
        expect(g.pruneFailedSharedPeers(3)).toEqual(["1.1.1.1:23552"]);
        expect(g.get("1.1.1.1:23552")).toBeUndefined();
        expect(g.get("2.2.2.2:3001")).toBeDefined();
        expect(g.get("relay.example:3001")).toBeDefined();
        expect(g.pruneFailedSharedPeers(0)).toEqual([]);
    });
});
