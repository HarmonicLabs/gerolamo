import { describe, expect, test } from "bun:test";
import { CborArray, CborBytes, CborSimple, CborText, CborUInt } from "@harmoniclabs/cbor";
import {
    accBigPoolStake, accPoolStake, BIG_LEDGER_PEER_QUOTA, dedupeRelays, ledgerRelaysFromSnapshotPools, ledgerRelayToAccessPoint, LedgerPeerSource,
    LONG_PEER_LIST_LIFE_MS, parsePeerSnapshot, pickLedgerPeers, poolRelaysFromStored, relayFromCbor, relayFromLedgerTs, SHORT_PEER_LIST_LIFE_MS,
    stakeMapsOverSource, type PoolRelays,
} from "./ledgerPeers";
import { ipv6ToLedgerBytes, type RelayAccessPoint } from "./relayAccessPoint";
import { mulberry32 } from "../utils/prng";

const rng = mulberry32;
const ap = (host: string, port = 3001): RelayAccessPoint => ({ kind: "domain", host, port });

describe("ledger relays (ouroboros-consensus relayToLedgerRelayAccessPoint)", () => {
    test("decodes the certificate relay shapes", () => {
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(6000n), new CborBytes(Uint8Array.from([63, 45, 33, 80])), new CborSimple(null)]))).toEqual({ host: "63.45.33.80", port: 6000 });
        // single_host_addr without a port, or without any address: dropped (no 3001 default)
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborSimple(null), new CborBytes(Uint8Array.from([10, 0, 0, 1])), new CborSimple(null)]))).toBeNull();
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(3001n), new CborSimple(null), new CborSimple(null)]))).toBeNull();
        // 0.0.0.0 is kept (cardano-node keeps it on the stake axis; 36 preview pools register it); the dialer drops it
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(3533n), new CborBytes(new Uint8Array(4)), new CborSimple(null)]))).toEqual({ host: "0.0.0.0", port: 3533 });
        expect(ledgerRelayToAccessPoint({ host: "0.0.0.0", port: 3533 })).toEqual({ kind: "address", host: "0.0.0.0", port: 3533 });
        expect(relayFromCbor(new CborArray([new CborUInt(1n), new CborUInt(30002n), new CborText("cf2r1.preview.pool.cardanofoundation.org")]))).toEqual({ host: "cf2r1.preview.pool.cardanofoundation.org", port: 30002 });
        // single_host_name without a port and multi_host_name are SRV names
        expect(relayFromCbor(new CborArray([new CborUInt(1n), new CborSimple(null), new CborText("relays.example.org")]))).toEqual({ host: "relays.example.org", port: 0, srv: true });
        expect(relayFromCbor(new CborArray([new CborUInt(2n), new CborText("example.org")]))).toEqual({ host: "example.org", port: 0, srv: true });
    });

    test("IPv6 relays: four little-endian words, as registered on preview", () => {
        // 17236.chunk of the preview chain holds this relay's certificate bytes; cardano-cli
        // (ledger-peer-snapshot --all-ledger-peers) shows it as 2001:861:4000:2b80:216:3eff:fe05:9009.
        const onChain = Uint8Array.from(Buffer.from("61080120802b0040ff3e1602099005fe", "hex"));
        expect(Buffer.from(ipv6ToLedgerBytes("2001:861:4000:2b80:216:3eff:fe05:9009")!).toString("hex")).toBe("61080120802b0040ff3e1602099005fe");
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(3001n), new CborSimple(null), new CborBytes(onChain)]))).toEqual({ host: "2001:861:4000:2b80:216:3eff:fe05:9009", port: 3001 });
        // IPv4 wins when both are present
        expect(relayFromCbor(new CborArray([new CborUInt(0n), new CborUInt(3001n), new CborBytes(Uint8Array.from([1, 2, 3, 4])), new CborBytes(onChain)]))).toEqual({ host: "1.2.3.4", port: 3001 });
    });

    test("converts cardano-ledger-ts relay objects and dedupes", () => {
        expect(relayFromLedgerTs({ type: "ip", port: 3001, ipv4: Uint8Array.from([1, 2, 3, 4]) })).toEqual({ host: "1.2.3.4", port: 3001 });
        expect(relayFromLedgerTs({ type: "ip", port: 3001 })).toBeNull();
        expect(relayFromLedgerTs({ type: "ip", ipv4: Uint8Array.from([1, 2, 3, 4]) })).toBeNull();
        expect(relayFromLedgerTs({ type: "ip", port: 6000n, ipv6: ipv6ToLedgerBytes("2a05:d014::1") })).toEqual({ host: "2a05:d014::1", port: 6000 });
        expect(relayFromLedgerTs({ type: "dns", dnsName: "relay.example.org" })).toEqual({ host: "relay.example.org", port: 0, srv: true });
        expect(relayFromLedgerTs({ type: "dns", port: 3001, dnsName: "relay.example.org" })).toEqual({ host: "relay.example.org", port: 3001 });
        expect(relayFromLedgerTs({ type: "multi-host", dnsName: "x.example" })).toEqual({ host: "x.example", port: 0, srv: true });
        const pools = new Map([["p1", { relays: [new CborArray([new CborUInt(1n), new CborUInt(3001n), new CborText("a.example")])] }], ["p2", { relays: [new CborArray([new CborUInt(1n), new CborUInt(3001n), new CborText("A.example")])] }]]);
        const all = ledgerRelaysFromSnapshotPools(pools);
        expect(all).toHaveLength(2);
        expect(dedupeRelays(all)).toEqual([{ pool: "p1", host: "a.example", port: 3001 }]);
    });

    test("SRV names get the CIP-0155 prefix when used", () => {
        expect(ledgerRelayToAccessPoint({ host: "example.org", port: 0, srv: true })).toEqual({ kind: "srv", host: "_cardano._tcp.example.org" });
        expect(ledgerRelayToAccessPoint({ host: "1.2.3.4", port: 3001 })).toEqual({ kind: "address", host: "1.2.3.4", port: 3001 });
        expect(ledgerRelayToAccessPoint({ host: "r.example", port: 3001 })).toEqual({ kind: "domain", host: "r.example", port: 3001 });
    });
});

describe("stake-weighted selection (Ouroboros.Network.PeerSelection.LedgerPeers)", () => {
    const pools: PoolRelays[] = [
        { pool: "a", stake: 64, relays: [ap("a")] },
        { pool: "b", stake: 16, relays: [ap("b")] },
        { pool: "c", stake: 16, relays: [ap("c")] },
        { pool: "d", stake: 4, relays: [ap("d")] },
        { pool: "none", stake: 50, relays: [] }, // no usable relay: excluded before renormalising
    ];

    test("all ledger peers: √-stake, renormalised over pools with relays", () => {
        const acc = accPoolStake(pools);
        const w = [8, 4, 4, 2].map((x) => x / 18);
        expect(acc.map((e) => e.pool)).toEqual(["a", "b", "c", "d"]);
        acc.forEach((e, i) => expect(e.stake).toBeCloseTo(w[i]!, 12));
        expect(acc[acc.length - 1]!.acc).toBeCloseTo(1, 12);
    });

    test("big ledger peers: largest first up to and including the pool that crosses 90 %", () => {
        const big = accBigPoolStake(pools);
        // a 0.64, b 0.80, c 0.96 (crosses 0.9: included), d excluded
        expect(big.map((e) => e.pool)).toEqual(["a", "b", "c"]);
        expect(big.map((e) => +e.acc.toFixed(2))).toEqual([0.64, 0.8, 0.96]);
        // exactly at the quota: the next pool still joins (takeWhilePrev (≤ 0.9))
        const exact = accBigPoolStake([{ stake: 90, relays: [ap("x")] }, { stake: 5, relays: [ap("y")] }, { stake: 5, relays: [ap("z")] }]);
        expect(exact.map((e) => e.relays[0]!.kind === "domain" && e.relays[0]!.host)).toEqual(["x", "y"]);
    });

    test("picks follow the weights (100k draws, fixed seed)", () => {
        const acc = accPoolStake(pools);
        const n = 100_000;
        const counts = new Map<string, number>();
        for (const p of pickLedgerPeers(acc, n, "all", rng(7))) counts.set(p.pool!, (counts.get(p.pool!) ?? 0) + 1);
        for (const [pool, w] of [["a", 8 / 18], ["b", 4 / 18], ["c", 4 / 18], ["d", 2 / 18]] as const) expect(Math.abs(counts.get(pool)! / n - w)).toBeLessThan(0.006);
        // big: draws in [0, 0.9) over the big axis → a 0.64/0.9, b 0.16/0.9, c the rest
        const bc = new Map<string, number>();
        for (const p of pickLedgerPeers(accBigPoolStake(pools), n, "big", rng(9))) bc.set(p.pool!, (bc.get(p.pool!) ?? 0) + 1);
        expect(Math.abs(bc.get("a")! / n - 0.64 / BIG_LEDGER_PEER_QUOTA)).toBeLessThan(0.006);
        expect(Math.abs(bc.get("c")! / n - 0.1 / BIG_LEDGER_PEER_QUOTA)).toBeLessThan(0.006);
        expect(bc.has("d")).toBe(false);
    });

    test("zero-stake pools are never picked; no distribution at all → equal weights", () => {
        const stored = [{ pool: "p1", host: "1.1.1.1", port: 3001 }, { pool: "p2", host: "2.2.2.2", port: 3001 }, { pool: "p2", host: "2.2.2.2", port: 3001 }];
        const withStake = poolRelaysFromStored(stored, new Map([["p1", 100n]]));
        expect(withStake.find((p) => p.pool === "p2")!.relays).toHaveLength(1); // deduped
        expect(pickLedgerPeers(accPoolStake(withStake), 500, "all", rng(3)).every((p) => p.pool === "p1")).toBe(true);
        expect(poolRelaysFromStored(stored, null).map((p) => p.stake)).toEqual([1, 1]);
    });
});

describe("source selection (stakeMapWithSlotOverSource) and the peer snapshot", () => {
    const ledgerPools: PoolRelays[] = [{ pool: "L", stake: 1, relays: [ap("ledger.example")] }];
    const snapshot = parsePeerSnapshot({ NodeToClientVersion: 23, NetworkMagic: 2, Point: { blockPointSlot: 1000, blockPointHash: "00" }, bigLedgerPools: [{ accumulatedStake: 0.5, relativeStake: 0.5, relays: [{ address: "snap.example", port: 3001 }] }, { accumulatedStake: 0.95, relativeStake: 0.45, relays: [{ address: "10.1.1.1", port: 6000 }, { address: "srv.example" }] }] })!;

    test("parses V23 snapshots, SRV relays prefixed", () => {
        expect(snapshot.slot).toBe(1000);
        expect(snapshot.networkMagic).toBe(2);
        expect(snapshot.big.map((e) => e.acc)).toEqual([0.5, 0.95]);
        expect(snapshot.big[1]!.relays).toEqual([{ kind: "address", host: "10.1.1.1", port: 6000 }, { kind: "srv", host: "_cardano._tcp.srv.example" }]);
    });

    test("parses the shipped snapshots (V23 preview, older mainnet / preprod format)", async () => {
        for (const net of ["preview", "preprod", "mainnet"]) {
            const s = parsePeerSnapshot(await Bun.file(new URL(`../config/${net}/peer-snapshot.json`, import.meta.url)).json())!;
            expect(s.big.length).toBeGreaterThan(10);
            expect(s.slot).toBeGreaterThan(0);
            expect(s.big[s.big.length - 1]!.acc).toBeGreaterThan(0.85);
            expect(s.big.every((e, i) => i === 0 || e.acc >= s.big[i - 1]!.acc)).toBe(true);
        }
    });

    test("snapshot wins only when not older than the ledger tip and useLedgerAfterSlot", () => {
        expect(stakeMapsOverSource({ useLedgerAfterSlot: 500, ledgerSlot: 900, ledgerPools, snapshot }).source).toBe("snapshot");
        expect(stakeMapsOverSource({ useLedgerAfterSlot: 500, ledgerSlot: 1001, ledgerPools, snapshot }).source).toBe("ledger");
        expect(stakeMapsOverSource({ useLedgerAfterSlot: 2000, ledgerSlot: 900, ledgerPools, snapshot }).source).toBe("none"); // before slot, snapshot too old
        expect(stakeMapsOverSource({ useLedgerAfterSlot: 2000, ledgerSlot: 2500, ledgerPools, snapshot }).source).toBe("ledger");
        expect(stakeMapsOverSource({ useLedgerAfterSlot: -1, ledgerSlot: 2500, ledgerPools, snapshot }).source).toBe("none"); // DontUseLedgerPeers
        expect(stakeMapsOverSource({ useLedgerAfterSlot: 0, ledgerSlot: null, ledgerPools, snapshot: null }).source).toBe("ledger"); // Always
        const m = stakeMapsOverSource({ useLedgerAfterSlot: 0, ledgerSlot: 10, ledgerPools, snapshot });
        expect(m.big).toBe(snapshot.big); // the snapshot's own accumulated axis
        const s5 = Math.sqrt(0.5), s45 = Math.sqrt(0.45);
        expect(m.all[0]!.stake).toBeCloseTo(s5 / (s5 + s45), 12);
        expect(m.all[1]!.stake).toBeCloseTo(s45 / (s5 + s45), 12);
    });

    test("LedgerPeerSource refreshes after 1847 s (30 s while empty) and dedupes picks", async () => {
        let now = 0, reads = 0, pools: PoolRelays[] | null = null;
        const src = new LedgerPeerSource({ useLedgerAfterSlot: 0, ledgerSlot: async () => 5, ledgerPools: async () => { reads++; return pools; }, snapshot: async () => null, now: () => now, rng: rng(5) });
        expect(await src.request(3, "all")).toEqual([]);
        expect(reads).toBe(1);
        pools = [{ pool: "x", stake: 1, relays: [ap("x1"), ap("x2")] }];
        now += SHORT_PEER_LIST_LIFE_MS - 1; await src.request(3, "all"); expect(reads).toBe(1);
        now += 2; const picks = await src.request(50, "all"); expect(reads).toBe(2);
        expect(picks.length).toBe(2); // two distinct relays, drawn repeatedly
        now += LONG_PEER_LIST_LIFE_MS - 10; await src.request(1, "all"); expect(reads).toBe(2);
        now += 20; await src.request(1, "all"); expect(reads).toBe(3);
        expect(src.isBigLedgerAccessPoint(ap("x1"))).toBe(true); // the only pool holds 100 % of stake
        const off = new LedgerPeerSource({ useLedgerAfterSlot: -1, ledgerSlot: async () => 5, ledgerPools: async () => pools, snapshot: async () => null });
        expect(off.enabled).toBe(false);
        expect(await off.request(5, "all")).toEqual([]);
    });
});
