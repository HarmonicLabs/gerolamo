/**
 * Pure cold/warm/hot peer governor (Cardano network-design v1).
 *
 * No network I/O — peerManager executes connect/HS/sync based on decisions.
 * Spec: cardano-docs/network-design.pdf (cold / warm / hot, valency, sharing).
 */

import { formatHostPort, normalizeHost } from "./relayAccessPoint";

export type PeerTier = "cold" | "warm" | "hot";

export type PeerSource =
    | "localRoot"
    | "bootstrap"
    | "publicRoot"
    | "shared"
    /** A relay from a pool registration certificate (ledger peers). */
    | "ledger"
    /** A relay of a pool in the top 90 % of stake (big ledger peers; their own targets). */
    | "bigLedger"
    /** A mature duplex inbound peer (connected to us InitiatorAndResponder for 15 min). */
    | "inbound"
    | "manual";

export interface PeerGovernorTargets {
    targetHot: number;
    targetWarm: number;
    targetCold: number;
    maxHot: number;
    maxWarm: number;
    maxCold: number;
    /**
     * Big ledger peer targets (cardano-node targetNumberOfKnown/Established/ActiveBigLedgerPeers,
     * defaults 15 / 10 / 5 for a relay). Big ledger peers count only against these, never against
     * the regular targets above. 0 = no big ledger peers (the default here; peerManager turns
     * them on for the relay role).
     */
    targetKnownBigLedger: number;
    targetEstablishedBigLedger: number;
    targetActiveBigLedger: number;
}

export const DEFAULT_PEER_GOVERNOR_TARGETS: PeerGovernorTargets = {
    targetHot: 3,
    targetWarm: 6,
    targetCold: 64,
    maxHot: 8,
    maxWarm: 24,
    maxCold: 256,
    targetKnownBigLedger: 0,
    targetEstablishedBigLedger: 0,
    targetActiveBigLedger: 0,
};

/** cardano-node defaults (Cardano.Network.Diffusion.Configuration.defaultDeadlineTargets). */
export const CARDANO_BIG_LEDGER_TARGETS = { targetKnownBigLedger: 15, targetEstablishedBigLedger: 10, targetActiveBigLedger: 5 } as const;

/** ouroboros-network policies (Ouroboros.Network.Diffusion.Policies / simplePeerSelectionPolicy). */
export const PEER_SHARE_ACTIVATION_DELAY_MS = 300_000;
export const PEER_SHARE_RETRY_MS = 900_000;
export const PEER_SHARE_MAX_IN_PROGRESS = 2;
export const PEER_SHARE_STICKY_MS = 823_000;
export const PEER_SHARE_MAX_PEERS = 10;
export const INBOUND_PEERS_RETRY_MS = 60_000;
export const MAX_INBOUND_PEERS = 10;
/** Inbound duplex connections become known-peer candidates after this long (inbound governor maturity). */
export const INBOUND_MATURITY_MS = 15 * 60_000;

/** Minimal client surface the governor holds (avoids circular imports). */
export interface GovernorPeerClient {
    readonly peerKey: string;
    readonly peerId: string;
    readonly host: string;
    readonly port: number | bigint;
    /** ms epoch of last ChainSync rollForward (hot liveness). */
    lastRollForwardAt?: number;
    /** ms epoch of the last ChainSync reply of any kind, AwaitReply included (bug 391). */
    lastChainSyncReplyAt?: number;
    /** The peer's last reported tip slot (from ChainSync). */
    peerSlotNumber?: number | null;
    /** Negotiated in the handshake. */
    peerSharingNegotiated?: boolean;
    handshakeVersion?: number | null;
    connectedAt?: number | null;
    /** Duplex: we serve our chain over this outbound connection; the peer has started pulling. */
    duplexServing?: boolean;
    duplexPullingSince?: number | null;
    /** Protocols the remote runs over our outbound connection (keep-alive = warm, chain-sync = hot). */
    duplexProtocols?: string[];
}

/** One row of the peer table on /stats: governor record + what the client knows. */
export interface PeerDetailSnapshot {
    key: string;
    tier: PeerTier;
    source: PeerSource;
    trustable: boolean;
    bigLedger?: boolean;
    localRootGroupId?: string;
    failCount: number;
    lastError?: string;
    lastRttMs?: number;
    addedAt: number;
    promotedAt?: number;
    nextRetryAt?: number;
    malicious?: { reason: string; until: number };
    connected: boolean;
    connectedAt?: number | null;
    tipSlot?: number | null;
    lastRollForwardAt?: number;
    version?: number | null;
    peerSharing?: boolean;
    duplexServing?: boolean;
    duplexPullingSince?: number | null;
    duplexProtocols?: string[];
}

export interface PeerRecord {
    readonly key: string;
    host: string;
    port: number;
    tier: PeerTier;
    source: PeerSource;
    trustable: boolean;
    client?: GovernorPeerClient;
    failCount: number;
    lastError?: string;
    lastRttMs?: number;
    addedAt: number;
    promotedAt?: number;
    syncing: boolean;
    /** Do not retry connect/promote until this ms epoch. */
    nextRetryAt?: number;
    /**
     * Set when the peer served provably bad data (body-hash mismatch,
     * invalid signature, chain divergence). Held cold until `until`.
     */
    malicious?: { reason: string; until: number };
    /**
     * Topology localRoots[] group id (e.g. lr_0).
     * Used for hard valency enforcement.
     */
    localRootGroupId?: string;
    /** Relay of a big ledger pool: counted against the big ledger targets only. */
    bigLedger?: boolean;
    /**
     * May be handed out over peer sharing (KnownPeers `knownPeerAdvertise = DoAdvertisePeer`):
     * roots per topology `advertise`, peers learned by peer sharing / inbound yes, ledger and
     * big ledger peers no.
     */
    advertise?: boolean;
    /** At least one handshake succeeded (`knownSuccessfulConnection`). */
    everConnected?: boolean;
    /** Earliest time we may send this peer a peer-share request (activation delay, then retry time). */
    peerShareAfter?: number;
    /** Churn just demoted this peer: do not re-promote it before this time. */
    churnHoldUntil?: number;
}

export interface LocalRootGroupSnapshot {
    groupId: string;
    valency: number;
    warmValency?: number;
    hot: number;
    warm: number;
    cold: number;
}

export interface PeerGovernorSnapshot {
    cold: number;
    warm: number;
    hot: number;
    total: number;
    targets: PeerGovernorTargets;
    hotKeys: string[];
    warmKeys: string[];
    coldSample: string[];
    /** P0 ops fields (optional for older consumers). */
    lastTickAt?: number;
    lastTickMs?: number;
    tickCount?: number;
    failedPeers?: number;
    recentErrors?: Array<{ key: string; error: string; failCount: number }>;
    maliciousPeers?: Array<{ key: string; reason: string; until: number }>;
    /** P1 localRoot valency status. */
    localRootGroups?: LocalRootGroupSnapshot[];
    /** Big ledger peers by tier (present when big ledger targets are on). */
    bigLedger?: { cold: number; warm: number; hot: number; total: number };
    /** Every hot and warm peer, then a sample of cold ones, with per-peer detail. */
    peers?: PeerDetailSnapshot[];
}

/** `host:port`; IPv6 literals bracketed (`[2001:db8::1]:3001`), v4-mapped addresses unmapped. */
export function peerKey(host: string, port: number | bigint): string {
    return formatHostPort(host, port);
}

/** Root peers (cardano-node rootPeersSet: local roots + public root peers incl. ledger / bootstrap). */
export function isRootSource(s: PeerSource): boolean {
    return s === "localRoot" || s === "publicRoot" || s === "bootstrap" || s === "ledger" || s === "bigLedger";
}

/** cardano-node counters (PeerSelectionCounters → cardano_node_metrics_peerSelection_*). */
export interface PeerSelectionCounters {
    Cold: number; Warm: number; Hot: number;
    KnownPeers: number; EstablishedPeers: number; ActivePeers: number; RootPeers: number;
    KnownBigLedgerPeers: number; EstablishedBigLedgerPeers: number; ActiveBigLedgerPeers: number;
    ColdBigLedgerPeers: number; WarmBigLedgerPeers: number; HotBigLedgerPeers: number;
    KnownLocalRootPeers: number; EstablishedLocalRootPeers: number; ActiveLocalRootPeers: number;
    /** cardano-node reports these two swapped (WarmLocalRoots = active, HotLocalRoots = established − active); kept as it does. */
    WarmLocalRoots: number; HotLocalRoots: number;
    KnownNonRootPeers: number; EstablishedNonRootPeers: number; ActiveNonRootPeers: number;
    KnownBootstrapPeers: number; EstablishedBootstrapPeers: number; ActiveBootstrapPeers: number;
}

/** FNV-1a of salt + key: the stable per-salt order cardano-node gets from `hashWithSalt`. */
export function saltedHash(salt: number, key: string): number {
    let h = (0x811c9dc5 ^ (salt >>> 0)) >>> 0;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}

/** Churn size: replace 20 %, at least one (`decreaseWithMin 1`). */
export function churnCount(v: number): number {
    return v <= 0 ? 0 : Math.min(v, Math.max(1, Math.floor(v / 5)));
}

/** Exponential backoff after fail: 15s, 30s, 60s… capped at 5m. */
export function retryBackoffMs(failCount: number): number {
    const n = Math.max(1, failCount);
    return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(n - 1, 5));
}

/** Bug 396: a quiet spell this long on every hot peer means our upstream is dead, not the network (P(no preview block for 10 min) ≈ e^-30). */
export const QUIET_NETWORK_MAX_MS = 600_000;

export class PeerGovernor {
    private readonly peers = new Map<string, PeerRecord>();
    /** localRoot group id → required valencies (hot slots to hold, established connections to keep). */
    private readonly localRootGroups = new Map<string, { hot: number; warm: number }>();
    readonly targets: PeerGovernorTargets;
    /** Last completed tick wall time (ms). */
    lastTickAt = 0;
    /** Duration of last tick (ms). */
    lastTickMs = 0;
    tickCount = 0;

    constructor(targets: Partial<PeerGovernorTargets> = {}) {
        this.targets = { ...DEFAULT_PEER_GOVERNOR_TARGETS, ...targets };
        // Clamp targets into max bounds
        this.targets.targetHot = Math.min(
            this.targets.targetHot,
            this.targets.maxHot,
        );
        this.targets.targetWarm = Math.min(
            this.targets.targetWarm,
            this.targets.maxWarm,
        );
        this.targets.targetCold = Math.min(
            this.targets.targetCold,
            this.targets.maxCold,
        );
    }

    /** Register a topology localRoots[] group: hot valency and warm valency (default = hot). */
    registerLocalRootGroup(groupId: string, valency: number, warmValency?: number): void {
        const hot = Math.max(0, Math.floor(valency));
        const warm = Math.max(hot, Math.floor(Number(warmValency ?? hot)) || 0);
        this.localRootGroups.set(groupId, { hot, warm });
    }

    getLocalRootValency(groupId: string | undefined): number {
        if (!groupId) return 0;
        return this.localRootGroups.get(groupId)?.hot ?? 0;
    }

    getLocalRootWarmValency(groupId: string | undefined): number {
        if (!groupId) return 0;
        return this.localRootGroups.get(groupId)?.warm ?? 0;
    }

    countEstablishedInGroup(groupId: string | undefined): number {
        if (!groupId) return 0;
        let n = 0;
        for (const p of this.peers.values()) if (p.tier !== "cold" && p.localRootGroupId === groupId) n++;
        return n;
    }

    /** How many more established (warm or hot) connections this group wants (warmValency). */
    needsLocalRootWarm(groupId: string | undefined): number {
        const want = this.getLocalRootWarmValency(groupId);
        return want > 0 ? Math.max(0, want - this.countEstablishedInGroup(groupId)) : 0;
    }

    /**
     * Local roots are never churned or demoted for excess (cardano-node manages them apart from
     * the regular targets); topology `trustable` peers are preferred too. Gerolamo used to treat
     * every local root as trustable (the flag defaulted to true); this keeps that behaviour now
     * that `trustable` follows cardano-node (default false).
     */
    isProtected(p: PeerRecord): boolean {
        return p.trustable || p.source === "localRoot";
    }

    countHotInGroup(groupId: string | undefined): number {
        if (!groupId) return 0;
        let n = 0;
        for (const p of this.peers.values()) {
            if (p.tier === "hot" && p.localRootGroupId === groupId) n++;
        }
        return n;
    }

    /** How many more hot slots this group still needs. */
    needsLocalRootHot(groupId: string | undefined): number {
        if (!groupId) return 0;
        const want = this.getLocalRootValency(groupId);
        if (want <= 0) return 0;
        return Math.max(0, want - this.countHotInGroup(groupId));
    }

    /** True if demoting this hot peer would drop its localRoot group below valency. */
    wouldBreachValency(rec: PeerRecord): boolean {
        if (!rec.localRootGroupId || rec.tier !== "hot") return false;
        const want = this.getLocalRootValency(rec.localRootGroupId);
        if (want <= 0) return false;
        return this.countHotInGroup(rec.localRootGroupId) <= want;
    }

    noteKnown(
        host: string,
        port: number | bigint,
        source: PeerSource,
        trustable = false,
        localRootGroupId?: string,
        opts: { advertise?: boolean; everConnected?: boolean } = {},
    ): PeerRecord {
        host = normalizeHost(host);
        const key = peerKey(host, port);
        const existing = this.peers.get(key);
        if (existing) {
            // Upgrade trust / prefer stronger source labels
            if (trustable) existing.trustable = true;
            if (source === "localRoot") {
                existing.source = "localRoot";
                existing.bigLedger = false; // local roots and big ledger peers are disjoint
                if (opts.advertise !== undefined) existing.advertise = opts.advertise;
            } else if (
                (source === "bootstrap" || source === "publicRoot") &&
                (existing.source === "shared" || existing.source === "ledger" || existing.source === "inbound")
            ) {
                existing.source = source;
                if (opts.advertise !== undefined) existing.advertise = opts.advertise;
            }
            if (localRootGroupId) {
                existing.localRootGroupId = localRootGroupId;
            }
            return existing;
        }
        if (
            this.counts().total >= this.targets.maxCold +
                this.targets.maxWarm +
                this.targets.maxHot &&
            !trustable
        ) {
            // Soft cap: drop oldest non-trustable cold if over total budget
            this.evictOldestCold();
        }
        const rec: PeerRecord = {
            key,
            host,
            port: Number(port),
            tier: "cold",
            source,
            trustable,
            failCount: 0,
            addedAt: Date.now(),
            syncing: false,
            localRootGroupId,
            bigLedger: source === "bigLedger",
            // KnownPeers advertise: peer-shared and inbound peers yes, ledger / big ledger no,
            // roots per topology (passed in opts).
            advertise: opts.advertise ?? (source === "shared" || source === "inbound"),
            everConnected: opts.everConnected ?? false,
        };
        this.peers.set(key, rec);
        return rec;
    }

    get(key: string): PeerRecord | undefined {
        return this.peers.get(key);
    }

    listByTier(tier: PeerTier): PeerRecord[] {
        const out: PeerRecord[] = [];
        for (const p of this.peers.values()) {
            if (p.tier === tier) out.push(p);
        }
        return out;
    }

    counts(): { cold: number; warm: number; hot: number; total: number } {
        let cold = 0;
        let warm = 0;
        let hot = 0;
        for (const p of this.peers.values()) {
            if (p.tier === "cold") cold++;
            else if (p.tier === "warm") warm++;
            else hot++;
        }
        return { cold, warm, hot, total: cold + warm + hot };
    }

    /** Counts without big ledger peers (what the regular targets are compared with, as in cardano-node). */
    regularCounts(): { cold: number; warm: number; hot: number; total: number } {
        let cold = 0, warm = 0, hot = 0;
        for (const p of this.peers.values()) {
            if (p.bigLedger) continue;
            if (p.tier === "cold") cold++; else if (p.tier === "warm") warm++; else hot++;
        }
        return { cold, warm, hot, total: cold + warm + hot };
    }

    /** Keys (`host:port`) of every known big ledger peer, for Genesis mode's GSM and density checks. */
    bigLedgerKeys(): string[] {
        const out: string[] = [];
        for (const p of this.peers.values()) if (p.bigLedger) out.push(p.key);
        return out;
    }

    bigLedgerCounts(): { cold: number; warm: number; hot: number; total: number } {
        let cold = 0, warm = 0, hot = 0;
        for (const p of this.peers.values()) {
            if (!p.bigLedger) continue;
            if (p.tier === "cold") cold++; else if (p.tier === "warm") warm++; else hot++;
        }
        return { cold, warm, hot, total: cold + warm + hot };
    }

    needsColdPeers(): boolean {
        return this.regularCounts().cold < this.targets.targetCold;
    }

    needsWarmSlots(): number {
        const { warm } = this.regularCounts();
        const want = this.targets.targetWarm - warm;
        const room = this.targets.maxWarm - warm;
        return Math.max(0, Math.min(want, room));
    }

    needsHotSlots(): number {
        const { hot } = this.regularCounts();
        const want = this.targets.targetHot - hot;
        const room = this.targets.maxHot - hot;
        return Math.max(0, Math.min(want, room));
    }

    excessHot(): number {
        return Math.max(0, this.regularCounts().hot - this.targets.maxHot);
    }

    /** Big ledger peers wanted in the known set (all tiers). */
    needsBigLedgerKnown(): number {
        return Math.max(0, this.targets.targetKnownBigLedger - this.bigLedgerCounts().total);
    }

    /** Big ledger connections (warm + hot) still wanted. */
    needsBigLedgerEstablished(): number {
        const c = this.bigLedgerCounts();
        return Math.max(0, this.targets.targetEstablishedBigLedger - (c.warm + c.hot));
    }

    needsBigLedgerHot(): number {
        return Math.max(0, this.targets.targetActiveBigLedger - this.bigLedgerCounts().hot);
    }

    excessBigLedgerHot(): number {
        return Math.max(0, this.bigLedgerCounts().hot - this.targets.targetActiveBigLedger);
    }

    excessBigLedgerEstablished(): number {
        const c = this.bigLedgerCounts();
        return Math.max(0, c.warm + c.hot - Math.max(this.targets.targetEstablishedBigLedger, this.targets.targetActiveBigLedger));
    }

    /**
     * Prefer trustable hot, then lowest failCount, then oldest promotion.
     */
    pickHotPeer(): GovernorPeerClient | null {
        const hot = this.listByTier("hot").filter((p) => p.client);
        if (hot.length === 0) return null;
        hot.sort((a, b) => {
            if (this.isProtected(a) !== this.isProtected(b)) return this.isProtected(a) ? -1 : 1;
            if (a.failCount !== b.failCount) return a.failCount - b.failCount;
            return (a.promotedAt ?? 0) - (b.promotedAt ?? 0);
        });
        return hot[0]!.client ?? null;
    }

    getClient(key: string): GovernorPeerClient | null {
        return this.peers.get(key)?.client ?? null;
    }

    /** Find client by peerId (timestamped) or peerKey. */
    getClientByIdOrKey(id: string): GovernorPeerClient | null {
        const byKey = this.peers.get(id);
        if (byKey?.client) return byKey.client;
        for (const p of this.peers.values()) {
            if (p.client?.peerId === id || p.client?.peerKey === id) {
                return p.client;
            }
        }
        return null;
    }

    attachClient(
        key: string,
        client: GovernorPeerClient,
        tier: "warm" | "hot",
    ): void {
        const rec = this.peers.get(key);
        if (!rec) return;
        const now = Date.now();
        if (!rec.everConnected || rec.tier === "cold") {
            // KnownPeers.setSuccessfulConnectionFlag; a peer-share request only after the
            // activation delay (policyPeerShareActivationDelay).
            rec.peerShareAfter = now + PEER_SHARE_ACTIVATION_DELAY_MS;
        }
        rec.everConnected = true;
        rec.client = client;
        rec.tier = tier;
        rec.promotedAt = now;
        rec.syncing = tier === "hot";
        rec.lastError = undefined;
        // Successful promote clears retry gate
        rec.nextRetryAt = undefined;
    }

    /**
     * Bookkeeping-only tier move. Caller must start/stop sync & sockets.
     * Returns false if illegal / missing.
     */
    setTier(key: string, tier: PeerTier): boolean {
        const rec = this.peers.get(key);
        if (!rec) return false;
        if (tier === "hot" && this.counts().hot >= this.targets.maxHot &&
            rec.tier !== "hot") {
            if (!rec.trustable) return false;
            // trustable may exceed target but not maxHot hard — still enforce max
            if (this.counts().hot >= this.targets.maxHot) return false;
        }
        if (tier === "warm" && rec.tier !== "warm") {
            // Inside this branch rec.tier is already cold|hot — only check capacity.
            if (this.counts().warm >= this.targets.maxWarm) {
                return false;
            }
        }
        if (tier === "cold") {
            rec.client = undefined;
            rec.syncing = false;
        } else if (tier === "warm") {
            rec.syncing = false;
        } else {
            rec.syncing = true;
        }
        rec.tier = tier;
        if (tier !== "cold") rec.promotedAt = Date.now();
        return true;
    }

    /** Default hold for a peer that served bad data: 1 hour. */
    static readonly MALICIOUS_BACKOFF_MS = 60 * 60 * 1000;

    /**
     * Peer served provably bad data. Drop straight to cold, drop the client,
     * and hold it out for `backoffMs` (default 1h) regardless of failCount.
     */
    markMalicious(
        key: string,
        reason: string,
        backoffMs: number = PeerGovernor.MALICIOUS_BACKOFF_MS,
    ): PeerTier | null {
        const rec = this.peers.get(key);
        if (!rec) return null;
        const until = Date.now() + Math.max(0, backoffMs);
        rec.failCount += 1;
        rec.lastError = String(reason).slice(0, 200);
        rec.nextRetryAt = until;
        rec.malicious = { reason: rec.lastError, until };
        rec.tier = "cold";
        rec.client = undefined;
        rec.syncing = false;
        return "cold";
    }

    /** True while a malicious hold is in force. */
    isMaliciousHeld(key: string, now = Date.now()): boolean {
        const m = this.peers.get(key)?.malicious;
        return !!m && m.until > now;
    }

    /** Suggest demotion after failure. Returns new tier. Sets nextRetryAt backoff. */
    markFail(key: string, err?: string): PeerTier | null {
        const rec = this.peers.get(key);
        if (!rec) return null;
        rec.failCount += 1;
        if (err) rec.lastError = String(err).slice(0, 200);
        rec.nextRetryAt = Date.now() + retryBackoffMs(rec.failCount);
        if (rec.tier === "hot") {
            // Prefer warm if client still usable; manager decides disconnect
            rec.tier = "warm";
            rec.syncing = false;
            return "warm";
        }
        if (rec.tier === "warm") {
            rec.tier = "cold";
            rec.client = undefined;
            rec.syncing = false;
            return "cold";
        }
        return "cold";
    }

    detachClient(key: string): void {
        const rec = this.peers.get(key);
        if (!rec) return;
        rec.client = undefined;
        rec.syncing = false;
        if (rec.tier !== "cold") {
            rec.tier = "cold";
        }
    }

    /** Clear nextRetryAt so pickColdForWarm can select this peer again. */
    forceClearRetry(key: string): boolean {
        const rec = this.peers.get(key);
        if (!rec) return false;
        rec.nextRetryAt = undefined;
        return true;
    }

    /**
     * Best cold peer for emergency reconnect when all are backed off.
     * Prefer localRoot / bootstrap / low failCount (compareForPromotion).
     */
    /**
     * Forget shared (unverified) cold peers that keep failing. Relays share the
     * addresses of nodes that connected to them; a data node's ephemeral port
     * ends up in that list and never answers. Without pruning the governor
     * spends every tick force-retrying the same dead entries.
     * Returns the keys removed.
     */
    pruneFailedSharedPeers(maxFailures: number): string[] {
        if (!Number.isFinite(maxFailures) || maxFailures <= 0) return [];
        const removed: string[] = [];
        for (const [key, p] of this.peers) {
            if (p.tier !== "cold" || p.trustable || (p.source !== "shared" && p.source !== "ledger" && p.source !== "bigLedger" && p.source !== "inbound")) continue;
            if (p.client || p.failCount < maxFailures) continue;
            this.peers.delete(key);
            removed.push(key);
        }
        return removed;
    }

    pickBestColdIgnoringBackoff(now = Date.now()): PeerRecord | undefined {
        return this.listByTier("cold")
            .filter((p) => !p.client && !(p.malicious && p.malicious.until > now))
            .sort((a, b) => this.compareForPromotion(a, b))[0];
    }

    private readyForRetry(p: PeerRecord, now: number): boolean {
        return (!p.nextRetryAt || p.nextRetryAt <= now) && (!p.churnHoldUntil || p.churnHoldUntil <= now);
    }

    private debt(p: PeerRecord): boolean {
        return this.needsLocalRootHot(p.localRootGroupId) > 0 || this.needsLocalRootWarm(p.localRootGroupId) > 0;
    }

    private srcRank(s: PeerSource): number {
        return s === "localRoot"
            ? 0
            : s === "bootstrap"
            ? 1
            : s === "publicRoot"
            ? 2
            : 3;
    }

    /**
     * Sort key: localRoot valency debt first, then trustable, failCount, source, age.
     */
    private compareForPromotion(a: PeerRecord, b: PeerRecord): number {
        const aDebt = this.debt(a) ? 0 : 1;
        const bDebt = this.debt(b) ? 0 : 1;
        if (aDebt !== bDebt) return aDebt - bDebt;
        if (this.isProtected(a) !== this.isProtected(b)) return this.isProtected(a) ? -1 : 1;
        if (a.failCount !== b.failCount) return a.failCount - b.failCount;
        const d = this.srcRank(a.source) - this.srcRank(b.source);
        if (d !== 0) return d;
        return a.addedAt - b.addedAt;
    }

    /**
     * Cold peers ready to promote to warm (no client yet, retry due). `bigLedger`: false (default)
     * = regular peers only, true = big ledger peers only, "any" = both.
     */
    pickColdForWarm(n: number, now = Date.now(), bigLedger: boolean | "any" = false): PeerRecord[] {
        const cold = this.listByTier("cold")
            .filter((p) => !p.client && this.readyForRetry(p, now) && (bigLedger === "any" || !!p.bigLedger === bigLedger))
            .sort((a, b) => this.compareForPromotion(a, b));
        return cold.slice(0, Math.max(0, n));
    }

    /** Cold members of local-root groups below their warm valency (connected regardless of the regular warm target). */
    pickLocalRootColdForWarm(now = Date.now()): PeerRecord[] {
        const out: PeerRecord[] = [];
        const want = new Map<string, number>();
        for (const p of this.listByTier("cold").filter((q) => q.localRootGroupId && !q.client && this.readyForRetry(q, now)).sort((a, b) => a.failCount - b.failCount)) {
            const g = p.localRootGroupId!;
            if (!want.has(g)) want.set(g, this.needsLocalRootWarm(g));
            const left = want.get(g)!;
            if (left <= 0) continue;
            want.set(g, left - 1);
            out.push(p);
        }
        return out;
    }

    /** Warm members of local-root groups below their hot valency. */
    pickLocalRootWarmForHot(now = Date.now()): PeerRecord[] {
        const out: PeerRecord[] = [];
        const want = new Map<string, number>();
        for (const p of this.listByTier("warm").filter((q) => q.localRootGroupId && q.client && !q.syncing && this.readyForRetry(q, now))) {
            const g = p.localRootGroupId!;
            if (!want.has(g)) want.set(g, this.needsLocalRootHot(g));
            const left = want.get(g)!;
            if (left <= 0) continue;
            want.set(g, left - 1);
            out.push(p);
        }
        return out;
    }

    /** Warm peers ready to promote to hot. Prefer localRoot valency debt. `bigLedger` as in pickColdForWarm. */
    pickWarmForHot(n: number, now = Date.now(), bigLedger: boolean | "any" = false): PeerRecord[] {
        const warm = this.listByTier("warm")
            .filter((p) => p.client && !p.syncing && this.readyForRetry(p, now) && (bigLedger === "any" || !!p.bigLedger === bigLedger))
            .sort((a, b) => {
                const aDebt = this.needsLocalRootHot(a.localRootGroupId) > 0 ? 0 : 1;
                const bDebt = this.needsLocalRootHot(b.localRootGroupId) > 0 ? 0 : 1;
                if (aDebt !== bDebt) return aDebt - bDebt;
                if (this.isProtected(a) !== this.isProtected(b)) return this.isProtected(a) ? -1 : 1;
                if (a.failCount !== b.failCount) return a.failCount - b.failCount;
                return (a.promotedAt ?? 0) - (b.promotedAt ?? 0);
            });
        return warm.slice(0, Math.max(0, n));
    }

    /**
     * Hot peers eligible for soft demotion when over target.
     * Never returns the only hot peer.
     * Never returns a localRoot peer that would breach group valency.
     */
    pickHotForDemotion(n: number): PeerRecord[] {
        const allHot = this.listByTier("hot").filter((p) => p.client);
        if (allHot.length <= 1) return [];
        const hot = allHot.filter((p) => !p.bigLedger); // big ledger peers have their own target
        const excess = Math.max(
            0,
            hot.length - this.targets.targetHot,
            this.excessHot(),
        );
        const take = Math.min(n, excess, hot.length - 1, allHot.length - 1);
        const candidates = hot
            .filter((p) => {
                // Always protect localRoot valency floor
                if (this.wouldBreachValency(p)) return false;
                // Local roots are not demoted for excess (a trustable non-root may be)
                return !this.isProtected(p) || !p.localRootGroupId;
            })
            .sort((a, b) => b.failCount - a.failCount ||
                (b.promotedAt ?? 0) - (a.promotedAt ?? 0));
        return candidates.slice(0, take);
    }

    /**
     * Hot peers silent longer than silentMs (no rollForward).
     * Spec (network-design): hot→warm is normal churn; never empty the hot set.
     * Prefer demoting non-trustable / non-valency-critical first.
     */
    /**
     * When the peer last proved it is alive on ChainSync: any reply counts, not only a RollForward. A peer on
     * our own chain answers MsgAwaitReply and then has nothing to send until a new block — that is not silence.
     * Bug 391: the server relay demoted its own producer (a local root serving the same chain) every 15 s for
     * eight hours, so the producer's block never reached the relay and was ghosted.
     */
    static lastAliveAt(p: PeerRecord): number {
        return Math.max(p.client?.lastChainSyncReplyAt ?? 0, p.client?.lastRollForwardAt ?? 0) || p.promotedAt || p.addedAt;
    }

    pickSilentHot(silentMs: number, now = Date.now()): PeerRecord[] {
        const hot = this.listByTier("hot").filter((p) => p.client && p.syncing);
        // Never silent-demote the last hot peer — tip freezes if hot hits 0.
        if (hot.length <= 1) return [];
        // Bug 396: silence is judged against the freshest hot peer, not the wall clock. When the whole network is
        // quiet (preview has a 3–4 min block gap about once a day) every peer is silent, and demoting them all left
        // the relay with only its producer (2026-10-13 15:29 and 16:36 UTC). Only a quiet spell far longer than any
        // honest gap (QUIET_NETWORK_MAX_MS) still rotates every hot peer.
        const freshest = Math.min(now, Math.max(...hot.map((p) => PeerGovernor.lastAliveAt(p))));
        const out: PeerRecord[] = [];
        for (const p of hot) {
            if (p.source === "localRoot") continue; // a local root is kept hot whatever it sends (bug 391)
            const last = PeerGovernor.lastAliveAt(p);
            if (freshest - last >= silentMs || now - last >= Math.max(silentMs, QUIET_NETWORK_MAX_MS)) out.push(p);
        }
        // Prefer demoting non-trustable / non-valency first
        out.sort((a, b) => {
            const aProtect = this.wouldBreachValency(a) ? 1 : 0;
            const bProtect = this.wouldBreachValency(b) ? 1 : 0;
            if (aProtect !== bProtect) return aProtect - bProtect;
            if (this.isProtected(a) !== this.isProtected(b)) return this.isProtected(a) ? 1 : -1;
            const la = a.client?.lastRollForwardAt ?? 0;
            const lb = b.client?.lastRollForwardAt ?? 0;
            return la - lb;
        });
        // Keep at least one hot after demotion.
        const maxDemote = hot.length - 1;
        return out.slice(0, Math.max(0, maxDemote));
    }

    /** Drop a known peer entirely (churn "forget", or a pruned address). Never a connected one. */
    forget(key: string): boolean {
        const p = this.peers.get(key);
        if (!p || p.client || p.tier !== "cold") return false;
        return this.peers.delete(key);
    }

    /** Big ledger demotion candidates (over their active target), newest promotion first; never the last hot peer. */
    pickBigLedgerHotForDemotion(n: number): PeerRecord[] {
        const allHot = this.listByTier("hot").filter((p) => p.client);
        const bl = allHot.filter((p) => p.bigLedger).sort((a, b) => b.failCount - a.failCount || (b.promotedAt ?? 0) - (a.promotedAt ?? 0));
        return bl.slice(0, Math.max(0, Math.min(n, allHot.length - 1)));
    }

    /**
     * Churn candidates (cardano-node Churn: replace ~20 % of active, then established, then known
     * peers every churn interval). Local roots are never churned. `kind` picks regular or big
     * ledger peers. Order: hot — least recently useful first (no roll-forward for longest;
     * cardano-node ranks by upstreamyness / fetchyness); warm — random (warmDemotionPolicy);
     * cold — random, peers with failures first (coldForgetPolicy `r / (failCount + 1)`).
     */
    pickChurnHot(bigLedger: boolean, rng: () => number = Math.random, exclude: ReadonlySet<string> = new Set()): PeerRecord[] {
        const eligible = this.listByTier("hot").filter((p) => p.client && !!p.bigLedger === bigLedger && p.source !== "localRoot");
        const hot = eligible.filter((p) => !exclude.has(p.key));
        const all = this.listByTier("hot").length;
        const n = Math.min(churnCount(eligible.length), hot.length, Math.max(0, all - 1));
        return hot
            .map((p) => ({ p, k: p.client?.lastRollForwardAt ?? p.promotedAt ?? 0, r: rng() }))
            .sort((a, b) => a.k - b.k || a.r - b.r)
            .slice(0, n)
            .map((x) => x.p);
    }

    pickChurnWarm(bigLedger: boolean, rng: () => number = Math.random): PeerRecord[] {
        const warm = this.listByTier("warm").filter((p) => p.client && !!p.bigLedger === bigLedger && p.source !== "localRoot");
        const established = warm.length + this.listByTier("hot").filter((p) => !!p.bigLedger === bigLedger && p.source !== "localRoot").length;
        const n = Math.min(churnCount(established), warm.length);
        return warm.map((p) => ({ p, r: rng() })).sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.p);
    }

    pickChurnCold(bigLedger: boolean, rng: () => number = Math.random): PeerRecord[] {
        const forgettable = (p: PeerRecord) => !p.client && !p.trustable && !!p.bigLedger === bigLedger &&
            (p.source === "shared" || p.source === "ledger" || p.source === "bigLedger" || p.source === "inbound");
        const cold = this.listByTier("cold").filter(forgettable);
        const n = Math.min(churnCount(cold.length), cold.length);
        return cold.map((p) => ({ p, r: rng() / (p.failCount + 1) })).sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.p);
    }

    /**
     * Peers we may ask for addresses now (EstablishedPeers.availableForPeerShare): connected,
     * the remote agreed to peer sharing, activation delay / retry time passed.
     */
    pickPeerShareDonors(max: number, now = Date.now(), negotiated: (p: PeerRecord) => boolean = (p) => !!p.client?.peerSharingNegotiated): PeerRecord[] {
        return [...this.listByTier("hot"), ...this.listByTier("warm")]
            .filter((p) => p.client && negotiated(p) && (p.peerShareAfter ?? 0) <= now)
            .slice(0, Math.max(0, max));
    }

    notePeerShareRequested(key: string, now = Date.now()): void {
        const p = this.peers.get(key);
        if (p) p.peerShareAfter = now + PEER_SHARE_RETRY_MS;
    }

    /**
     * What we answer a MsgShareRequest with (KnownPeers.getPeerSharingResponsePeers +
     * computePeerSharingPeers): known peers with advertise, a successful connection and no
     * failures, in a salted hash order, at most min(10, amount).
     */
    shareablePeers(amount: number, salt: number, now = Date.now()): Array<{ host: string; port: number }> {
        const want = Math.max(0, Math.min(PEER_SHARE_MAX_PEERS, Math.floor(amount)));
        if (want === 0) return [];
        return [...this.peers.values()]
            .filter((p) => p.advertise && p.everConnected && p.failCount === 0 && !(p.malicious && p.malicious.until > now))
            .sort((a, b) => saltedHash(salt, a.key) - saltedHash(salt, b.key))
            .slice(0, want)
            .map((p) => ({ host: p.host, port: p.port }));
    }

    /** cardano-node PeerSelectionCounters (see `isRootSource` for root peers). */
    selectionCounters(): PeerSelectionCounters {
        const c: PeerSelectionCounters = {
            Cold: 0, Warm: 0, Hot: 0, KnownPeers: 0, EstablishedPeers: 0, ActivePeers: 0, RootPeers: 0,
            KnownBigLedgerPeers: 0, EstablishedBigLedgerPeers: 0, ActiveBigLedgerPeers: 0, ColdBigLedgerPeers: 0, WarmBigLedgerPeers: 0, HotBigLedgerPeers: 0,
            KnownLocalRootPeers: 0, EstablishedLocalRootPeers: 0, ActiveLocalRootPeers: 0, WarmLocalRoots: 0, HotLocalRoots: 0,
            KnownNonRootPeers: 0, EstablishedNonRootPeers: 0, ActiveNonRootPeers: 0,
            KnownBootstrapPeers: 0, EstablishedBootstrapPeers: 0, ActiveBootstrapPeers: 0,
        };
        for (const p of this.peers.values()) {
            const est = p.tier !== "cold", act = p.tier === "hot";
            if (isRootSource(p.source)) c.RootPeers++;
            if (p.bigLedger) {
                c.KnownBigLedgerPeers++;
                if (est) c.EstablishedBigLedgerPeers++;
                if (act) c.ActiveBigLedgerPeers++;
                if (p.tier === "cold") c.ColdBigLedgerPeers++; else if (p.tier === "warm") c.WarmBigLedgerPeers++; else c.HotBigLedgerPeers++;
                continue;
            }
            c.KnownPeers++;
            if (est) c.EstablishedPeers++;
            if (act) c.ActivePeers++;
            if (p.tier === "cold") c.Cold++; else if (p.tier === "warm") c.Warm++; else c.Hot++;
            if (p.source === "localRoot") { c.KnownLocalRootPeers++; if (est) c.EstablishedLocalRootPeers++; if (act) c.ActiveLocalRootPeers++; }
            if (!isRootSource(p.source)) { c.KnownNonRootPeers++; if (est) c.EstablishedNonRootPeers++; if (act) c.ActiveNonRootPeers++; }
            if (p.source === "bootstrap") { c.KnownBootstrapPeers++; if (est) c.EstablishedBootstrapPeers++; if (act) c.ActiveBootstrapPeers++; }
        }
        c.WarmLocalRoots = c.ActiveLocalRootPeers;
        c.HotLocalRoots = c.EstablishedLocalRootPeers - c.ActiveLocalRootPeers;
        return c;
    }

    noteTickComplete(startedAt: number): void {
        this.lastTickAt = Date.now();
        this.lastTickMs = Math.max(0, this.lastTickAt - startedAt);
        this.tickCount += 1;
    }

    private localRootGroupSnapshots(): LocalRootGroupSnapshot[] {
        const out: LocalRootGroupSnapshot[] = [];
        for (const [groupId, { hot: valency, warm: warmValency }] of this.localRootGroups) {
            let hot = 0;
            let warm = 0;
            let cold = 0;
            for (const p of this.peers.values()) {
                if (p.localRootGroupId !== groupId) continue;
                if (p.tier === "hot") hot++;
                else if (p.tier === "warm") warm++;
                else cold++;
            }
            out.push({ groupId, valency, warmValency, hot, warm, cold });
        }
        return out;
    }

    snapshot(): PeerGovernorSnapshot {
        const c = this.counts();
        const bl = this.bigLedgerCounts();
        const failed = [...this.peers.values()].filter((p) => p.failCount > 0);
        const recentErrors = failed
            .filter((p) => p.lastError)
            .sort((a, b) => b.failCount - a.failCount)
            .slice(0, 8)
            .map((p) => ({
                key: p.key,
                error: p.lastError ?? "",
                failCount: p.failCount,
            }));
        const groups = this.localRootGroupSnapshots();
        const nowMs = Date.now();
        const maliciousPeers = [...this.peers.values()]
            .filter((p) => p.malicious && p.malicious.until > nowMs)
            .map((p) => ({ key: p.key, reason: p.malicious!.reason, until: p.malicious!.until }));
        return {
            cold: c.cold,
            warm: c.warm,
            hot: c.hot,
            total: c.total,
            targets: { ...this.targets },
            hotKeys: this.listByTier("hot").map((p) => p.key),
            warmKeys: this.listByTier("warm").map((p) => p.key),
            coldSample: this.listByTier("cold").slice(0, 12).map((p) => p.key),
            lastTickAt: this.lastTickAt || undefined,
            lastTickMs: this.lastTickMs || undefined,
            tickCount: this.tickCount || undefined,
            failedPeers: failed.length,
            recentErrors: recentErrors.length ? recentErrors : undefined,
            localRootGroups: groups.length ? groups : undefined,
            maliciousPeers: maliciousPeers.length ? maliciousPeers : undefined,
            bigLedger: this.targets.targetKnownBigLedger > 0 || bl.total > 0 ? bl : undefined,
            peers: [...this.listByTier("hot"), ...this.listByTier("warm"), ...this.listByTier("cold").slice(0, 24)].map((p) => ({
                key: p.key, tier: p.tier, source: p.source, trustable: p.trustable, bigLedger: p.bigLedger || undefined, localRootGroupId: p.localRootGroupId,
                failCount: p.failCount, lastError: p.lastError, lastRttMs: p.lastRttMs, addedAt: p.addedAt, promotedAt: p.promotedAt, nextRetryAt: p.nextRetryAt,
                malicious: p.malicious && p.malicious.until > nowMs ? p.malicious : undefined,
                connected: !!p.client,
                connectedAt: p.client?.connectedAt ?? null,
                tipSlot: p.client?.peerSlotNumber ?? null,
                lastRollForwardAt: p.client?.lastRollForwardAt,
                version: p.client?.handshakeVersion ?? null,
                peerSharing: p.client?.peerSharingNegotiated,
                duplexServing: p.client?.duplexServing,
                duplexPullingSince: p.client?.duplexPullingSince ?? null,
                duplexProtocols: p.client?.duplexProtocols ?? [],
            })),
        };
    }

    private evictOldestCold(): void {
        const cold = this.listByTier("cold")
            .filter((p) => !p.trustable && (p.source === "shared" || p.source === "ledger" || p.source === "bigLedger" || p.source === "inbound"))
            .sort((a, b) => a.addedAt - b.addedAt);
        if (cold[0]) this.peers.delete(cold[0].key);
    }
}
