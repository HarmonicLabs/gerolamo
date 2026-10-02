/**
 * Ledger peers: the relays every registered pool announces in its registration
 * certificate. cardano-node fills most of its known-peer set from them (stake-weighted
 * picks); a producer that never asks for peers over peer sharing (it must not advertise
 * itself) still needs them to keep 20 warm duplex connections to distinct relays, which
 * is what gets its blocks pulled (see PLAN_BLOCK_PRODUCTION.md, "Propagation odds").
 *
 * Sources: the `pool_relays` table (written at every registration certificate) and, for
 * pools registered before that table existed, `<node dir>/ledger-relays.json` generated
 * from a Mithril ledger snapshot by `scripts/ledger-relays.ts`; plus the big-ledger-peer
 * snapshot file named by topology.json `peerSnapshotFile`.
 *
 * Selection follows ouroboros-network `Ouroboros.Network.PeerSelection.LedgerPeers`:
 * - all ledger peers: each pool weighted by √(relative stake), renormalised over the pools
 *   that have usable relays (`recomputeRelativeStake SingAllLedgerPeers`); a pick draws
 *   x ∈ [0,1) and takes the first pool whose cumulative weight is ≥ x (`Map.lookupGE`),
 *   then one of its relays uniformly;
 * - big ledger peers: pools by stake descending, cumulated, cut after the pool that crosses
 *   90 % (`accumulateBigLedgerStake`, `takeWhilePrev (≤ 0.9)`), picks draw x ∈ [0,0.9);
 * - source (`stakeMapWithSlotOverSource`): the snapshot when its slot is ≥ both the ledger
 *   tip and useLedgerAfterSlot, else the ledger once its tip passed useLedgerAfterSlot,
 *   else nothing; the maps are re-read after 1847 s (30 s while empty).
 */
import { CborArray, CborBytes, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import {
    accessPointFromJson, accessPointKey, CARDANO_SRV_PREFIX, ipv6FromLedgerBytes, prefixSrv, validPort,
    type RelayAccessPoint,
} from "./relayAccessPoint";
import type { Rng } from "./dnsResolve";

/** A stored ledger relay. `srv` = an SRV domain (host is the unprefixed name, port 0). */
export interface LedgerRelay { pool: string; host: string; port: number; srv?: boolean }
export type StoredRelay = { host: string; port: number; srv?: boolean };

function portOf(o: CborObj | undefined): number | null {
    if (o instanceof CborUInt) { const n = Number(o.num); return validPort(n) ? n : null; }
    return null;
}

/**
 * Shelley relay CBOR, mapped as ouroboros-consensus `relayToLedgerRelayAccessPoint`:
 * [0, port, ipv4?, ipv6?] needs a port and an address (IPv4 preferred; IPv6 is four
 * little-endian words), [1, port, dns] is a domain, [1, null, dns] and [2, dns] are SRV names.
 */
export function relayFromCbor(obj: CborObj): StoredRelay | null {
    if (!(obj instanceof CborArray) || !(obj.array[0] instanceof CborUInt)) return null;
    const tag = Number(obj.array[0].num);
    if (tag === 0) {
        const port = portOf(obj.array[1]);
        if (port == null) return null;
        const v4 = obj.array[2], v6 = obj.array[3];
        // 0.0.0.0 is kept, as cardano-node does (it weighs in the stake axis); the dialer drops it
        if (v4 instanceof CborBytes && v4.bytes.length === 4) return { host: Array.from(v4.bytes).join("."), port };
        if (v6 instanceof CborBytes && v6.bytes.length === 16) {
            const host = ipv6FromLedgerBytes(v6.bytes);
            return host ? { host, port } : null;
        }
        return null;
    }
    if (tag === 1) {
        const name = obj.array[2];
        if (!(name instanceof CborText) || !name.text.trim()) return null;
        const port = portOf(obj.array[1]);
        return port == null ? { host: name.text.trim(), port: 0, srv: true } : { host: name.text.trim(), port };
    }
    if (tag === 2) {
        const name = obj.array[1];
        return name instanceof CborText && name.text.trim() ? { host: name.text.trim(), port: 0, srv: true } : null;
    }
    return null;
}

/** A cardano-ledger-ts PoolRelay object (registration certificates as the node applies them); same mapping as relayFromCbor. */
export function relayFromLedgerTs(r: any): StoredRelay | null {
    if (!r || typeof r !== "object") return null;
    const p = r.port != null ? Number(r.port) : NaN;
    const port = validPort(p) ? p : null;
    if (r.type === "ip") {
        if (port == null) return null;
        const v4 = r.ipv4, v6 = r.ipv6;
        let host: string | null = null;
        if (v4 instanceof Uint8Array && v4.length === 4) host = Array.from(v4).join(".");
        else if (typeof v4 === "string" && v4) host = v4;
        else if (v6 instanceof Uint8Array && v6.length === 16) host = ipv6FromLedgerBytes(v6);
        return host ? { host, port } : null;
    }
    if ((r.type === "dns" || r.type === "multi-host") && typeof r.dnsName === "string" && r.dnsName.trim()) {
        const host = r.dnsName.trim();
        return r.type === "dns" && port != null ? { host, port } : { host, port: 0, srv: true };
    }
    return null;
}

/** Stored relay → access point; SRV names get the CIP-0155 prefix here (`prefixLedgerRelayAccessPoint`). */
export function ledgerRelayToAccessPoint(r: StoredRelay, srvPrefix = CARDANO_SRV_PREFIX): RelayAccessPoint | null {
    if (!r || typeof r.host !== "string" || !r.host.trim()) return null;
    if (r.srv) return { kind: "srv", host: prefixSrv(r.host, srvPrefix) };
    return accessPointFromJson({ address: r.host, port: r.port }, { allowInvalidDestination: true });
}

/** Relays of every pool in a decoded ledger snapshot (`decodeLedgerSnapshot(...).pools`). */
export function ledgerRelaysFromSnapshotPools(pools: Map<string, { relays: CborObj[] }>): LedgerRelay[] {
    const out: LedgerRelay[] = [];
    for (const [pool, p] of pools) for (const r of p.relays ?? []) { const d = relayFromCbor(r); if (d) out.push({ pool, ...d }); }
    return out;
}

export interface LedgerRelaysFile { generatedAt: string; stateSlot: number | null; relays: LedgerRelay[] }

export async function loadLedgerRelaysFile(path: string): Promise<LedgerRelay[]> {
    try {
        const f = Bun.file(path);
        if (!(await f.exists())) return [];
        const j = (await f.json()) as LedgerRelaysFile;
        return Array.isArray(j?.relays) ? j.relays.filter((r) => r && typeof r.host === "string" && Number.isInteger(r.port)) : [];
    } catch { return []; }
}

/** Dedupe by host:port (SRV by name), keeping the first pool that announced it. */
export function dedupeRelays(relays: LedgerRelay[]): LedgerRelay[] {
    const seen = new Set<string>(); const out: LedgerRelay[] = [];
    for (const r of relays) { const k = `${r.srv ? "srv:" : ""}${r.host.toLowerCase()}:${r.port}`; if (seen.has(k)) continue; seen.add(k); out.push(r); }
    return out;
}

// ─── stake-weighted selection ────────────────────────────────────────────────

/** A pool with a stake weight (lovelace, or a fraction; only ratios matter) and its usable relays. */
export interface PoolRelays { pool?: string; stake: number; relays: RelayAccessPoint[] }
/** One pool on the cumulative axis: `acc` is the upper end of its interval. */
export interface AccEntry { acc: number; stake: number; pool?: string; relays: RelayAccessPoint[] }

export const BIG_LEDGER_PEER_QUOTA = 0.9;

/** `recomputeRelativeStake`: drop pools without relays, optionally √-adjust, renormalise to 1. */
export function recomputeRelativeStake(pools: PoolRelays[], sqrtAdjust: boolean): PoolRelays[] {
    const usable = pools.filter((p) => p.relays.length > 0 && Number.isFinite(p.stake) && p.stake >= 0);
    const adj = usable.map((p) => ({ ...p, stake: sqrtAdjust ? Math.sqrt(p.stake) : p.stake }));
    const total = adj.reduce((s, p) => s + p.stake, 0);
    return total > 0 ? adj.map((p) => ({ ...p, stake: p.stake / total })) : adj;
}

/** `accPoolStake`: the all-ledger-peers axis (√-weighted), in input order. */
export function accPoolStake(pools: PoolRelays[]): AccEntry[] {
    let acc = 0;
    return recomputeRelativeStake(pools, true).map((p) => ({ acc: (acc += p.stake), stake: p.stake, pool: p.pool, relays: p.relays }));
}

/** `accumulateBigLedgerStake`: largest pools first, cumulated, up to and including the one that crosses 90 %. */
export function accBigPoolStake(pools: PoolRelays[]): AccEntry[] {
    const sorted = recomputeRelativeStake(pools, false).sort((a, b) => b.stake - a.stake);
    const out: AccEntry[] = [];
    let acc = 0;
    for (const p of sorted) {
        if (out.length > 0 && out[out.length - 1]!.acc > BIG_LEDGER_PEER_QUOTA) break; // takeWhilePrev (≤ quota)
        out.push({ acc: (acc += p.stake), stake: p.stake, pool: p.pool, relays: p.relays });
    }
    return out;
}

/** `Map.lookupGE x`: the first entry whose cumulative stake is ≥ x (entries ascending by acc). */
function lookupGE(entries: AccEntry[], x: number): AccEntry | undefined {
    let lo = 0, hi = entries.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (entries[mid]!.acc >= x) hi = mid; else lo = mid + 1; }
    return entries[lo];
}

export type LedgerPeersKind = "all" | "big";

/** `pickPeers`: n independent stake-weighted draws (duplicates possible; callers dedupe). */
export function pickLedgerPeers(entries: AccEntry[], n: number, kind: LedgerPeersKind, rng: Rng = Math.random): Array<{ ap: RelayAccessPoint; pool?: string }> {
    const out: Array<{ ap: RelayAccessPoint; pool?: string }> = [];
    if (entries.length === 0) return out;
    const scale = kind === "big" ? BIG_LEDGER_PEER_QUOTA : 1;
    for (let i = 0; i < Math.max(0, Math.floor(n)); i++) {
        const e = lookupGE(entries, rng() * scale);
        if (!e || e.relays.length === 0) continue;
        out.push({ ap: e.relays[Math.min(e.relays.length - 1, Math.floor(rng() * e.relays.length))]!, pool: e.pool });
    }
    return out;
}

// ─── big ledger peer snapshot (topology peerSnapshotFile) ────────────────────

export interface LedgerPeerSnapshot {
    /** Slot of the snapshot point; null = origin / unknown (then cardano-node never prefers it). */
    slot: number | null;
    networkMagic: number | null;
    /** Big ledger pools on the cumulative axis, as recorded (accumulatedStake / relativeStake). */
    big: AccEntry[];
}

/**
 * `FromJSON (LedgerPeerSnapshot BigLedgerPeers)`: V23 = `{NodeToClientVersion: 23, Point:
 * {blockPointSlot, blockPointHash} | "origin", NetworkMagic, bigLedgerPools: [{accumulatedStake,
 * relativeStake, relays: [{address, port?}]}]}`; the older `{version, slotNo, bigLedgerPools}`
 * (relays keyed `domain` / `address`) is accepted too.
 */
export function parsePeerSnapshot(json: unknown, srvPrefix = CARDANO_SRV_PREFIX): LedgerPeerSnapshot | null {
    if (!json || typeof json !== "object") return null;
    const j = json as Record<string, any>;
    if (!Array.isArray(j.bigLedgerPools)) return null;
    let slot: number | null = null;
    if (j.Point && typeof j.Point === "object" && Number.isFinite(Number(j.Point.blockPointSlot))) slot = Number(j.Point.blockPointSlot);
    else if (Number.isFinite(Number(j.slotNo))) slot = Number(j.slotNo);
    const big: AccEntry[] = [];
    for (const p of j.bigLedgerPools) {
        const acc = Number(p?.accumulatedStake), stake = Number(p?.relativeStake);
        if (!Number.isFinite(acc) || !Number.isFinite(stake)) continue;
        const relays: RelayAccessPoint[] = [];
        for (const r of Array.isArray(p.relays) ? p.relays : []) {
            const ap = accessPointFromJson(r, { allowInvalidDestination: true });
            if (ap) relays.push(ap.kind === "srv" ? { kind: "srv", host: prefixSrv(ap.host, srvPrefix) } : ap);
        }
        if (relays.length) big.push({ acc, stake, relays });
    }
    big.sort((a, b) => a.acc - b.acc);
    return { slot, networkMagic: Number.isFinite(Number(j.NetworkMagic)) ? Number(j.NetworkMagic) : null, big };
}

export async function loadPeerSnapshotFile(path: string): Promise<LedgerPeerSnapshot | null> {
    try {
        const f = Bun.file(path);
        if (!(await f.exists())) return null;
        return parsePeerSnapshot(await f.json());
    } catch { return null; }
}

export interface StakeMaps { all: AccEntry[]; big: AccEntry[]; source: "snapshot" | "ledger" | "none" }

function snapshotWins(s: LedgerPeerSnapshot | null, ledgerSlot: number | null, after: number): s is LedgerPeerSnapshot {
    return !!(s && s.slot != null && s.big.length && s.slot >= (ledgerSlot ?? 0) && s.slot >= after);
}

/**
 * `stakeMapWithSlotOverSource`. `useLedgerAfterSlot`: < 0 disabled (DontUseLedgerPeers),
 * 0 always, > 0 after that slot. `ledgerPools` is what the ledger has (null = unavailable).
 */
export function stakeMapsOverSource(args: {
    useLedgerAfterSlot: number;
    ledgerSlot: number | null;
    ledgerPools: PoolRelays[] | null;
    snapshot: LedgerPeerSnapshot | null;
}): StakeMaps {
    const none: StakeMaps = { all: [], big: [], source: "none" };
    if (!(args.useLedgerAfterSlot >= 0)) return none;
    const after = args.useLedgerAfterSlot;
    const s = args.snapshot;
    if (snapshotWins(s, args.ledgerSlot, after)) {
        return { all: accPoolStake(s.big.map((e) => ({ pool: e.pool, stake: e.stake, relays: e.relays }))), big: s.big, source: "snapshot" };
    }
    const ledgerOn = after === 0 || (args.ledgerSlot != null && args.ledgerSlot >= after);
    if (ledgerOn && args.ledgerPools && args.ledgerPools.length) {
        const pools = [...args.ledgerPools].sort((a, b) => b.stake - a.stake);
        return { all: accPoolStake(pools), big: accBigPoolStake(pools), source: "ledger" };
    }
    return none;
}

/** Group stored relays per pool with their stake (pools missing from `stake` weigh 0; no distribution at all → equal weights). */
export function poolRelaysFromStored(relays: LedgerRelay[], stake: Map<string, bigint> | null, srvPrefix = CARDANO_SRV_PREFIX): PoolRelays[] {
    const byPool = new Map<string, { keys: Set<string>; relays: RelayAccessPoint[] }>();
    for (const r of relays) {
        const ap = ledgerRelayToAccessPoint(r, srvPrefix);
        if (!ap) continue;
        const pool = String(r.pool).toLowerCase();
        let g = byPool.get(pool);
        if (!g) byPool.set(pool, (g = { keys: new Set(), relays: [] }));
        const k = accessPointKey(ap);
        if (!g.keys.has(k)) { g.keys.add(k); g.relays.push(ap); }
    }
    const equal = !stake || stake.size === 0;
    return [...byPool].map(([pool, g]) => ({ pool, stake: equal ? 1 : Number(stake!.get(pool) ?? 0n), relays: g.relays }));
}

/** ouroboros-network `short_PEER_LIST_LIFE_TIME` / `long_PEER_LIST_LIFE_TIME`. */
export const SHORT_PEER_LIST_LIFE_MS = 30_000;
export const LONG_PEER_LIST_LIFE_MS = 1_847_000;

/**
 * The ledger-peers thread state: cached stake maps with cardano-node's refresh times, and
 * picks on request. All inputs are injected, so selection can be simulated offline.
 */
export class LedgerPeerSource {
    private maps: StakeMaps = { all: [], big: [], source: "none" };
    private loadedAt = -Infinity;
    private bigKeys = new Set<string>();

    constructor(private readonly deps: {
        useLedgerAfterSlot: number;
        ledgerSlot: () => Promise<number | null>;
        ledgerPools: () => Promise<PoolRelays[] | null>;
        snapshot: () => Promise<LedgerPeerSnapshot | null>;
        now?: () => number;
        rng?: Rng;
    }) {}

    get enabled(): boolean { return this.deps.useLedgerAfterSlot >= 0; }

    /** Current maps, re-read when older than the peer-list lifetime. */
    async current(): Promise<StakeMaps> {
        if (!this.enabled) return this.maps;
        const now = (this.deps.now ?? Date.now)();
        const empty = this.maps.all.length === 0 && this.maps.big.length === 0;
        if (now - this.loadedAt > (empty ? SHORT_PEER_LIST_LIFE_MS : LONG_PEER_LIST_LIFE_MS)) {
            this.loadedAt = now;
            const [ledgerSlot, snapshot] = await Promise.all([this.deps.ledgerSlot().catch(() => null), this.deps.snapshot().catch(() => null)]);
            // the ledger is only read when the snapshot does not win (it is the expensive part)
            const ledgerPools = snapshotWins(snapshot, ledgerSlot, this.deps.useLedgerAfterSlot) ? null : await this.deps.ledgerPools().catch(() => null);
            this.maps = stakeMapsOverSource({ useLedgerAfterSlot: this.deps.useLedgerAfterSlot, ledgerSlot, ledgerPools, snapshot });
            this.bigKeys = new Set(this.maps.big.flatMap((e) => e.relays.map(accessPointKey)));
        }
        return this.maps;
    }

    /** Up to n distinct access points drawn stake-weighted (the governor asks for its deficit). */
    async request(n: number, kind: LedgerPeersKind): Promise<Array<{ ap: RelayAccessPoint; pool?: string }>> {
        const m = await this.current();
        const entries = kind === "big" ? m.big : m.all;
        const seen = new Set<string>();
        const out: Array<{ ap: RelayAccessPoint; pool?: string }> = [];
        for (const p of pickLedgerPeers(entries, n, kind, this.deps.rng)) {
            const k = accessPointKey(p.ap);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(p);
        }
        return out;
    }

    /** Is this access point a relay of a big ledger pool (as of the last refresh)? */
    isBigLedgerAccessPoint(ap: RelayAccessPoint): boolean {
        return this.bigKeys.has(accessPointKey(ap));
    }

    stats(): { source: StakeMaps["source"]; pools: number; bigPools: number; loadedAt: number | null } {
        return { source: this.maps.source, pools: this.maps.all.length, bigPools: this.maps.big.length, loadedAt: Number.isFinite(this.loadedAt) ? this.loadedAt : null };
    }
}
