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
    targetHot: 2,
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
}

export function peerKey(host: string, port: number | bigint): string {
    return `${host}:${Number(port)}`;
}

export class PeerGovernor {
    private readonly peers = new Map<string, PeerRecord>();
    readonly targets: PeerGovernorTargets;

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

    noteKnown(
        host: string,
        port: number | bigint,
        source: PeerSource,
        trustable = false,
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
        const { warm, hot } = this.counts();
        // Warm target is independent; also allow headroom under maxWarm
        const want = this.targets.targetWarm - warm;
        const room = this.targets.maxWarm - warm;
        // Don't starve hot promotions of cold pool entirely
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

    /** Suggest demotion after failure. Returns new tier. */
    markFail(key: string, err?: string): PeerTier | null {
        const rec = this.peers.get(key);
        if (!rec) return null;
        rec.failCount += 1;
        if (err) rec.lastError = String(err).slice(0, 200);
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

    /** Cold peers ready to promote to warm (no client yet). */
    pickColdForWarm(n: number): PeerRecord[] {
        const cold = this.listByTier("cold")
            .filter((p) => !p.client)
            .sort((a, b) => {
                if (a.trustable !== b.trustable) return a.trustable ? -1 : 1;
                if (a.failCount !== b.failCount) return a.failCount - b.failCount;
                // Prefer roots over random shared for first connects
                const srcRank = (s: PeerSource) =>
                    s === "localRoot"
                        ? 0
                        : s === "bootstrap"
                        ? 1
                        : s === "publicRoot"
                        ? 2
                        : 3;
                const d = srcRank(a.source) - srcRank(b.source);
                if (d !== 0) return d;
                return a.addedAt - b.addedAt;
            });
        return cold.slice(0, Math.max(0, n));
    }

    /** Warm peers ready to promote to hot. */
    pickWarmForHot(n: number): PeerRecord[] {
        const warm = this.listByTier("warm")
            .filter((p) => p.client && !p.syncing)
            .sort((a, b) => {
                if (a.trustable !== b.trustable) return a.trustable ? -1 : 1;
                if (a.failCount !== b.failCount) return a.failCount - b.failCount;
                return (a.promotedAt ?? 0) - (b.promotedAt ?? 0);
            });
        return warm.slice(0, Math.max(0, n));
    }

    /**
     * Non-trustable hot peers eligible for soft demotion when over target.
     * Never returns the only hot peer.
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
            .filter((p) => !p.trustable)
            .sort((a, b) => b.failCount - a.failCount ||
                (b.promotedAt ?? 0) - (a.promotedAt ?? 0));
        return candidates.slice(0, take);
    }

    snapshot(): PeerGovernorSnapshot {
        const c = this.counts();
        return {
            cold: c.cold,
            warm: c.warm,
            hot: c.hot,
            total: c.total,
            targets: { ...this.targets },
            hotKeys: this.listByTier("hot").map((p) => p.key),
            warmKeys: this.listByTier("warm").map((p) => p.key),
            coldSample: this.listByTier("cold").slice(0, 12).map((p) => p.key),
        };
    }

    private evictOldestCold(): void {
        const cold = this.listByTier("cold")
            .filter((p) => !p.trustable && p.source === "shared")
            .sort((a, b) => a.addedAt - b.addedAt);
        if (cold[0]) this.peers.delete(cold[0].key);
    }
}
