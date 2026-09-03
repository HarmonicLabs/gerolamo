/**
 * Pure cold/warm/hot peer governor (Cardano network-design v1).
 *
 * No network I/O — peerManager executes connect/HS/sync based on decisions.
 * Spec: cardano-docs/network-design.pdf (cold / warm / hot, valency, sharing).
 */

export type PeerTier = "cold" | "warm" | "hot";

export type PeerSource =
    | "localRoot"
    | "bootstrap"
    | "publicRoot"
    | "shared"
    | "manual";

export interface PeerGovernorTargets {
    targetHot: number;
    targetWarm: number;
    targetCold: number;
    maxHot: number;
    maxWarm: number;
    maxCold: number;
}

export const DEFAULT_PEER_GOVERNOR_TARGETS: PeerGovernorTargets = {
    targetHot: 3,
    targetWarm: 6,
    targetCold: 64,
    maxHot: 8,
    maxWarm: 24,
    maxCold: 256,
};

/** Minimal client surface the governor holds (avoids circular imports). */
export interface GovernorPeerClient {
    readonly peerKey: string;
    readonly peerId: string;
    readonly host: string;
    readonly port: number | bigint;
    /** ms epoch of last ChainSync rollForward (hot liveness). */
    lastRollForwardAt?: number;
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
}

export interface LocalRootGroupSnapshot {
    groupId: string;
    valency: number;
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
}

export function peerKey(host: string, port: number | bigint): string {
    return `${host}:${Number(port)}`;
}

/** Exponential backoff after fail: 15s, 30s, 60s… capped at 5m. */
export function retryBackoffMs(failCount: number): number {
    const n = Math.max(1, failCount);
    return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(n - 1, 5));
}

export class PeerGovernor {
    private readonly peers = new Map<string, PeerRecord>();
    /** localRoot group id → required valency (hot slots to hold). */
    private readonly localRootGroups = new Map<string, number>();
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

    /** Register a topology localRoots[] group and its required hot valency. */
    registerLocalRootGroup(groupId: string, valency: number): void {
        const v = Math.max(0, Math.floor(valency));
        this.localRootGroups.set(groupId, v);
    }

    getLocalRootValency(groupId: string | undefined): number {
        if (!groupId) return 0;
        return this.localRootGroups.get(groupId) ?? 0;
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
    ): PeerRecord {
        const key = peerKey(host, port);
        const existing = this.peers.get(key);
        if (existing) {
            // Upgrade trust / prefer stronger source labels
            if (trustable) existing.trustable = true;
            if (source === "localRoot") existing.source = "localRoot";
            else if (
                source === "bootstrap" &&
                existing.source === "shared"
            ) {
                existing.source = "bootstrap";
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

    needsColdPeers(): boolean {
        return this.counts().cold < this.targets.targetCold;
    }

    needsWarmSlots(): number {
        const { warm } = this.counts();
        const want = this.targets.targetWarm - warm;
        const room = this.targets.maxWarm - warm;
        return Math.max(0, Math.min(want, room));
    }

    needsHotSlots(): number {
        const { hot } = this.counts();
        const want = this.targets.targetHot - hot;
        const room = this.targets.maxHot - hot;
        return Math.max(0, Math.min(want, room));
    }

    excessHot(): number {
        return Math.max(0, this.counts().hot - this.targets.maxHot);
    }

    /**
     * Prefer trustable hot, then lowest failCount, then oldest promotion.
     */
    pickHotPeer(): GovernorPeerClient | null {
        const hot = this.listByTier("hot").filter((p) => p.client);
        if (hot.length === 0) return null;
        hot.sort((a, b) => {
            if (a.trustable !== b.trustable) return a.trustable ? -1 : 1;
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
        rec.client = client;
        rec.tier = tier;
        rec.promotedAt = Date.now();
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
            if (p.tier !== "cold" || p.trustable || p.source !== "shared") continue;
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
        return !p.nextRetryAt || p.nextRetryAt <= now;
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
        const aDebt = this.needsLocalRootHot(a.localRootGroupId) > 0 ? 0 : 1;
        const bDebt = this.needsLocalRootHot(b.localRootGroupId) > 0 ? 0 : 1;
        if (aDebt !== bDebt) return aDebt - bDebt;
        if (a.trustable !== b.trustable) return a.trustable ? -1 : 1;
        if (a.failCount !== b.failCount) return a.failCount - b.failCount;
        const d = this.srcRank(a.source) - this.srcRank(b.source);
        if (d !== 0) return d;
        return a.addedAt - b.addedAt;
    }

    /** Cold peers ready to promote to warm (no client yet, retry due). */
    pickColdForWarm(n: number, now = Date.now()): PeerRecord[] {
        const cold = this.listByTier("cold")
            .filter((p) => !p.client && this.readyForRetry(p, now))
            .sort((a, b) => this.compareForPromotion(a, b));
        return cold.slice(0, Math.max(0, n));
    }

    /** Warm peers ready to promote to hot. Prefer localRoot valency debt. */
    pickWarmForHot(n: number, now = Date.now()): PeerRecord[] {
        const warm = this.listByTier("warm")
            .filter((p) => p.client && !p.syncing && this.readyForRetry(p, now))
            .sort((a, b) => {
                const aDebt = this.needsLocalRootHot(a.localRootGroupId) > 0 ? 0 : 1;
                const bDebt = this.needsLocalRootHot(b.localRootGroupId) > 0 ? 0 : 1;
                if (aDebt !== bDebt) return aDebt - bDebt;
                if (a.trustable !== b.trustable) return a.trustable ? -1 : 1;
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
        const hot = this.listByTier("hot").filter((p) => p.client);
        if (hot.length <= 1) return [];
        const excess = Math.max(
            0,
            hot.length - this.targets.targetHot,
            this.excessHot(),
        );
        const take = Math.min(n, excess, hot.length - 1);
        const candidates = hot
            .filter((p) => {
                // Always protect localRoot valency floor
                if (this.wouldBreachValency(p)) return false;
                // Prefer non-trustable; trustable only if still excess after filter
                return !p.trustable || !p.localRootGroupId;
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
    pickSilentHot(silentMs: number, now = Date.now()): PeerRecord[] {
        const hot = this.listByTier("hot").filter((p) => p.client && p.syncing);
        // Never silent-demote the last hot peer — tip freezes if hot hits 0.
        if (hot.length <= 1) return [];
        const out: PeerRecord[] = [];
        for (const p of hot) {
            const last = p.client?.lastRollForwardAt ?? p.promotedAt ?? p.addedAt;
            if (now - last >= silentMs) out.push(p);
        }
        // Prefer demoting non-trustable / non-valency first
        out.sort((a, b) => {
            const aProtect = this.wouldBreachValency(a) ? 1 : 0;
            const bProtect = this.wouldBreachValency(b) ? 1 : 0;
            if (aProtect !== bProtect) return aProtect - bProtect;
            if (a.trustable !== b.trustable) return a.trustable ? 1 : -1;
            const la = a.client?.lastRollForwardAt ?? 0;
            const lb = b.client?.lastRollForwardAt ?? 0;
            return la - lb;
        });
        // Keep at least one hot after demotion.
        const maxDemote = hot.length - 1;
        return out.slice(0, Math.max(0, maxDemote));
    }

    noteTickComplete(startedAt: number): void {
        this.lastTickAt = Date.now();
        this.lastTickMs = Math.max(0, this.lastTickAt - startedAt);
        this.tickCount += 1;
    }

    private localRootGroupSnapshots(): LocalRootGroupSnapshot[] {
        const out: LocalRootGroupSnapshot[] = [];
        for (const [groupId, valency] of this.localRootGroups) {
            let hot = 0;
            let warm = 0;
            let cold = 0;
            for (const p of this.peers.values()) {
                if (p.localRootGroupId !== groupId) continue;
                if (p.tier === "hot") hot++;
                else if (p.tier === "warm") warm++;
                else cold++;
            }
            out.push({ groupId, valency, hot, warm, cold });
        }
        return out;
    }

    snapshot(): PeerGovernorSnapshot {
        const c = this.counts();
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
        };
    }

    private evictOldestCold(): void {
        const cold = this.listByTier("cold")
            .filter((p) => !p.trustable && p.source === "shared")
            .sort((a, b) => a.addedAt - b.addedAt);
        if (cold[0]) this.peers.delete(cold[0].key);
    }
}
