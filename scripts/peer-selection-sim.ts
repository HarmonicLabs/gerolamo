/**
 * Offline ledger-peer selection check against a cardano-node's own view (no network I/O).
 *
 *   cardano-cli latest query ledger-peer-snapshot --testnet-magic 2 --all-ledger-peers --output-json --out-file all.json
 *   cardano-cli latest query ledger-peer-snapshot --testnet-magic 2 --output-json --out-file big.json
 *   bun scripts/peer-selection-sim.ts all.json [big.json] [--draws 200000] [--seed 1]
 *
 * Rebuilds the big ledger pool set from the all-ledger-peers stake (accumulateBigLedgerStake) and
 * compares it with the node's big snapshot, then draws stake-weighted picks (√-stake for all
 * ledger peers, 90 % axis for big ones) and prints the observed vs expected pick shares.
 */
import { accBigPoolStake, accPoolStake, parsePeerSnapshot, pickLedgerPeers, type PoolRelays } from "../src/network/ledgerPeers";
import { accessPointFromJson, accessPointKey, accessPointLabel, prefixSrv, type RelayAccessPoint } from "../src/network/relayAccessPoint";
import { mulberry32 } from "../src/utils/prng";

const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
if (!files[0]) { console.error("usage: bun scripts/peer-selection-sim.ts all-ledger-peers.json [big-ledger-peers.json] [--draws N] [--seed S]"); process.exit(1); }
const all = await Bun.file(files[0]).json() as { allLedgerPools: Array<{ relativeStake: number; relays: unknown[] }>; Point?: { blockPointSlot: number } };
const pools: PoolRelays[] = all.allLedgerPools.map((p, i) => ({
    pool: `#${i}`,
    stake: p.relativeStake,
    relays: p.relays.map((r) => accessPointFromJson(r, { allowInvalidDestination: true })).filter((r): r is RelayAccessPoint => !!r).map((r) => (r.kind === "srv" ? { kind: "srv", host: prefixSrv(r.host) } as RelayAccessPoint : r)),
}));
const kinds = { address: 0, domain: 0, srv: 0, ipv6: 0 };
for (const p of pools) for (const r of p.relays) { kinds[r.kind]++; if (r.kind === "address" && r.host.includes(":")) kinds.ipv6++; }
console.log(`all ledger pools: ${pools.length} (${pools.filter((p) => p.relays.length).length} with usable relays) at slot ${all.Point?.blockPointSlot ?? "?"}; relays: ${kinds.address} address (${kinds.ipv6} IPv6), ${kinds.domain} domain, ${kinds.srv} SRV`);

const big = accBigPoolStake(pools);
console.log(`big ledger pools (top 90 %): ${big.length}, cumulative ${big[big.length - 1]?.acc.toFixed(6)}`);
if (files[1]) {
    const snap = parsePeerSnapshot(await Bun.file(files[1]).json())!;
    const key = (rs: RelayAccessPoint[]) => rs.map(accessPointKey).sort().join(",");
    const ours = new Set(big.map((e) => key(e.relays))), theirs = new Set(snap.big.map((e) => key(e.relays)));
    const onlyOurs = [...ours].filter((k) => !theirs.has(k)), onlyTheirs = [...theirs].filter((k) => !ours.has(k));
    console.log(`node's big ledger snapshot: ${snap.big.length} pools at slot ${snap.slot}; same set: ${onlyOurs.length === 0 && onlyTheirs.length === 0 ? "yes" : `no (+${onlyOurs.length} ours only, +${onlyTheirs.length} node only)`}`);
    const maxDiff = Math.max(...big.map((e, i) => Math.abs(e.acc - (snap.big[i]?.acc ?? NaN))));
    console.log(`  largest accumulatedStake difference: ${maxDiff.toExponential(3)}`);
}

const draws = opt("draws", 200_000), rng = mulberry32(opt("seed", 1));
for (const kind of ["all", "big"] as const) {
    const acc = kind === "all" ? accPoolStake(pools) : big;
    const count = new Map<string, number>();
    for (const p of pickLedgerPeers(acc, draws, kind, rng)) count.set(p.pool!, (count.get(p.pool!) ?? 0) + 1);
    const scale = kind === "big" ? 0.9 : 1;
    let worst = 0;
    const rows = acc.map((e, i) => {
        const lo = i === 0 ? 0 : acc[i - 1]!.acc, expected = Math.max(0, Math.min(e.acc, scale) - Math.min(lo, scale)) / scale;
        const seen = (count.get(e.pool!) ?? 0) / draws;
        worst = Math.max(worst, Math.abs(seen - expected));
        return { pool: e.pool!, relay: accessPointLabel(e.relays[0]!), stake: e.stake, expected, seen };
    }).sort((a, b) => b.expected - a.expected);
    console.log(`\n${kind} ledger peers, ${draws} draws: max |observed − expected| share = ${worst.toFixed(4)}`);
    for (const r of rows.slice(0, 8)) console.log(`  ${r.relay.padEnd(48)} weight ${r.stake.toFixed(4)}  expected ${(r.expected * 100).toFixed(2)} %  observed ${(r.seen * 100).toFixed(2)} %`);
}
