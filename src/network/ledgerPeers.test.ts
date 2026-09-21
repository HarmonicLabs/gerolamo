import { describe, expect, test } from "bun:test";
import { CborArray, CborBytes, CborSimple, CborText, CborUInt } from "@harmoniclabs/cbor";
import { dedupeRelays, ledgerRelaysFromSnapshotPools, relayFromCbor, relayFromLedgerTs } from "./ledgerPeers";

describe("ledger relays", () => {
    test("decodes the three certificate relay shapes", () => {
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(6000n), new CborBytes(Uint8Array.from([63, 45, 33, 80])), new CborSimple(null)]))).toEqual({ host: "63.45.33.80", port: 6000 });
        // port null → 3001; ipv6-only → skipped
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborSimple(null), new CborBytes(Uint8Array.from([10, 0, 0, 1])), new CborSimple(null)]))).toEqual({ host: "10.0.0.1", port: 3001 });
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(3001n), new CborSimple(null), new CborBytes(new Uint8Array(16))]))).toBeNull();
        expect(relayFromCbor(new CborArray([new CborUInt(1n), new CborUInt(30002n), new CborText("cf2r1.preview.pool.cardanofoundation.org")]))).toEqual({ host: "cf2r1.preview.pool.cardanofoundation.org", port: 30002 });
        expect(relayFromCbor(new CborArray([new CborUInt(2n), new CborText("_cardano._tcp.example.org")]))).toBeNull();
    });
    test("converts cardano-ledger-ts relay objects and dedupes", () => {
        expect(relayFromLedgerTs({ type: "ip", port: 3001, ipv4: Uint8Array.from([1, 2, 3, 4]) })).toEqual({ host: "1.2.3.4", port: 3001 });
        expect(relayFromLedgerTs({ type: "ip", port: 3001 })).toBeNull();
        expect(relayFromLedgerTs({ type: "dns", dnsName: "relay.example.org" })).toEqual({ host: "relay.example.org", port: 3001 });
        expect(relayFromLedgerTs({ type: "multi-host", dnsName: "x" })).toBeNull();
        const pools = new Map([["p1", { relays: [new CborArray([new CborUInt(1n), new CborUInt(3001n), new CborText("a.example")])] }], ["p2", { relays: [new CborArray([new CborUInt(1n), new CborUInt(3001n), new CborText("A.example")])] }]]);
        const all = ledgerRelaysFromSnapshotPools(pools);
        expect(all).toHaveLength(2);
        expect(dedupeRelays(all)).toEqual([{ pool: "p1", host: "a.example", port: 3001 }]);
    });
});
