import { describe, expect, test } from "bun:test";
import { churnCount, PeerGovernor, PEER_SHARE_ACTIVATION_DELAY_MS, PEER_SHARE_RETRY_MS, type GovernorPeerClient, type PeerRecord } from "./PeerGovernor";
import { mulberry32 } from "../utils/prng";

const client = (key: string, extra: Partial<GovernorPeerClient> = {}): GovernorPeerClient => ({ peerKey: key, peerId: `${key}:1`, host: key.split(":")[0]!, port: 3001, ...extra });
const connect = (g: PeerGovernor, rec: PeerRecord, tier: "warm" | "hot" = "warm", extra: Partial<GovernorPeerClient> = {}) => g.attachClient(rec.key, client(rec.key, extra), tier);

describe("big ledger peers have their own targets (cardano-node PeerSelectionTargets)", () => {
    test("regular counts and targets ignore big ledger peers", () => {
        const g = new PeerGovernor({ targetHot: 2, targetWarm: 2, targetCold: 4, targetKnownBigLedger: 3, targetEstablishedBigLedger: 2, targetActiveBigLedger: 1 });
        for (let i = 0; i < 4; i++) g.noteKnown(`10.0.0.${i}`, 3001, "ledger");
        for (let i = 0; i < 3; i++) g.noteKnown(`10.9.0.${i}`, 3001, "bigLedger");
        expect(g.needsColdPeers()).toBe(false);
        expect(g.needsBigLedgerKnown()).toBe(0);
        expect(g.needsBigLedgerEstablished()).toBe(2);
        // regular picks never take big ledger peers and vice versa
        expect(g.pickColdForWarm(10).every((p) => !p.bigLedger)).toBe(true);
        expect(g.pickColdForWarm(10, Date.now(), true).every((p) => p.bigLedger)).toBe(true);
        for (const p of g.pickColdForWarm(2, Date.now(), true)) connect(g, p);
        expect(g.needsBigLedgerEstablished()).toBe(0);
        expect(g.needsWarmSlots()).toBe(2); // big ledger warm peers do not fill regular warm slots
        const [bl] = g.pickWarmForHot(1, Date.now(), true);
        connect(g, bl!, "hot");
        expect(g.needsBigLedgerHot()).toBe(0);
        expect(g.needsHotSlots()).toBe(2);
        expect(g.pickHotForDemotion(5)).toEqual([]); // a big ledger hot peer is not "excess" of targetHot
        const c = g.selectionCounters();
        expect([c.KnownPeers, c.KnownBigLedgerPeers, c.EstablishedBigLedgerPeers, c.ActiveBigLedgerPeers, c.HotBigLedgerPeers, c.Hot]).toEqual([4, 3, 2, 1, 1, 0]);
        expect(c.RootPeers).toBe(7); // ledger and big ledger peers are public root peers
    });
});

describe("local root valency groups", () => {
    test("warm valency (default = hot) and hot valency are served before regular peers", () => {
        const g = new PeerGovernor({ targetHot: 1, targetWarm: 1 });
        g.registerLocalRootGroup("lr_0", 1, 2);
        const a = g.noteKnown("192.168.1.10", 3001, "localRoot", false, "lr_0");
        const b = g.noteKnown("192.168.1.11", 3001, "localRoot", false, "lr_0");
        g.noteKnown("8.8.8.8", 3001, "publicRoot");
        expect(g.pickLocalRootColdForWarm().map((p) => p.key).sort()).toEqual([a.key, b.key].sort());
        connect(g, a); connect(g, b);
        expect(g.needsLocalRootWarm("lr_0")).toBe(0);
        expect(g.pickLocalRootWarmForHot().length).toBe(1); // hot valency 1
        connect(g, a, "hot");
        expect(g.pickLocalRootWarmForHot()).toEqual([]);
        expect(g.wouldBreachValency(g.get(a.key)!)).toBe(true);
        // local roots are protected even though trustable is false (cardano-node default)
        expect(g.isProtected(g.get(a.key)!)).toBe(true);
        expect(g.get(a.key)!.trustable).toBe(false);
    });
});

describe("churn (Churn.hs: replace 20 %, at least one)", () => {
    test("churnCount = max 1 (n div 5), bounded by n", () => {
        expect([0, 1, 4, 5, 9, 10, 20, 24].map(churnCount)).toEqual([0, 1, 1, 1, 1, 2, 4, 4]);
    });

    test("never churns local roots or the last hot peer; forgets only non-root cold peers", () => {
        const g = new PeerGovernor({ targetHot: 10, targetWarm: 10, targetCold: 50 });
        g.registerLocalRootGroup("lr_0", 1);
        const lr = g.noteKnown("127.0.0.1", 6424, "localRoot", false, "lr_0");
        connect(g, lr, "hot");
        const hot: PeerRecord[] = [];
        for (let i = 0; i < 10; i++) { const r = g.noteKnown(`10.1.0.${i}`, 3001, "ledger"); connect(g, r, "hot", { lastRollForwardAt: 1000 + i }); hot.push(r); }
        for (let i = 0; i < 5; i++) connect(g, g.noteKnown(`10.2.0.${i}`, 3001, "shared"), "warm");
        for (let i = 0; i < 10; i++) g.noteKnown(`10.3.0.${i}`, 3001, "shared");
        g.noteKnown("boot.example", 3001, "bootstrap");
        const r = mulberry32(11);
        const churnHot = g.pickChurnHot(false, r, new Set([hot[0]!.key]));
        expect(churnHot.length).toBe(2); // 10 non-local-root hot → 2
        expect(churnHot.some((p) => p.key === lr.key || p.key === hot[0]!.key)).toBe(false);
        expect(churnHot.map((p) => p.key)).toEqual([hot[1]!.key, hot[2]!.key]); // least recent roll-forward first
        const churnWarm = g.pickChurnWarm(false, r);
        expect(churnWarm.length).toBe(3); // established non-local-root = 15 → 3, all from warm
        expect(churnWarm.every((p) => p.tier === "warm")).toBe(true);
        const cold = g.pickChurnCold(false, r);
        expect(cold.length).toBe(2);
        expect(cold.every((p) => p.source === "shared")).toBe(true);
        for (const p of cold) expect(g.forget(p.key)).toBe(true);
        expect(g.forget(lr.key)).toBe(false);
        // a single hot peer is never churned away
        const g1 = new PeerGovernor();
        connect(g1, g1.noteKnown("10.0.0.1", 3001, "ledger"), "hot");
        expect(g1.pickChurnHot(false, r)).toEqual([]);
    });
});

describe("peer sharing (cardano-node policies)", () => {
    test("requests only after the activation delay, then every 15 minutes", () => {
        const g = new PeerGovernor();
        const p = g.noteKnown("10.0.0.1", 3001, "publicRoot");
        const t0 = Date.now();
        connect(g, p, "warm", { peerSharingNegotiated: true });
        expect(g.pickPeerShareDonors(2, t0)).toEqual([]);
        expect(g.pickPeerShareDonors(2, t0 + PEER_SHARE_ACTIVATION_DELAY_MS + 5).map((x) => x.key)).toEqual([p.key]);
        g.notePeerShareRequested(p.key, t0 + PEER_SHARE_ACTIVATION_DELAY_MS + 5);
        expect(g.pickPeerShareDonors(2, t0 + PEER_SHARE_ACTIVATION_DELAY_MS + PEER_SHARE_RETRY_MS)).toEqual([]);
        expect(g.pickPeerShareDonors(2, t0 + 2 * PEER_SHARE_ACTIVATION_DELAY_MS + PEER_SHARE_RETRY_MS).length).toBe(1);
    });

    test("we share advertised, once-connected, failure-free peers (IPv4 and IPv6), at most 10", () => {
        const g = new PeerGovernor();
        const lr = g.noteKnown("127.0.0.1", 6424, "localRoot", false, "lr_0", { advertise: false });
        const pub = g.noteKnown("8.8.8.8", 3001, "publicRoot", false, undefined, { advertise: true });
        const v6 = g.noteKnown("2a05:d014::1", 3001, "shared");
        const ledger = g.noteKnown("9.9.9.9", 3001, "ledger");
        const never = g.noteKnown("7.7.7.7", 3001, "shared");
        const failed = g.noteKnown("6.6.6.6", 3001, "shared");
        for (const r of [lr, pub, v6, ledger, failed]) connect(g, r);
        g.markFail(failed.key, "x");
        const out = g.shareablePeers(255, 42).map((p) => `${p.host}:${p.port}`).sort();
        expect(out).toEqual(["2a05:d014::1:3001", "8.8.8.8:3001"]);
        void never;
        for (let i = 0; i < 20; i++) connect(g, g.noteKnown(`11.0.0.${i}`, 3001, "shared"));
        expect(g.shareablePeers(255, 1).length).toBe(10);
        expect(g.shareablePeers(3, 1).length).toBe(3);
        expect(g.shareablePeers(3, 1)).toEqual(g.shareablePeers(3, 1)); // stable for a salt
    });
});

describe("counters", () => {
    test("cardano-node's swapped WarmLocalRoots / HotLocalRoots", () => {
        const g = new PeerGovernor();
        g.registerLocalRootGroup("lr_0", 1);
        const a = g.noteKnown("127.0.0.1", 6424, "localRoot", false, "lr_0");
        const b = g.noteKnown("127.0.0.2", 6424, "localRoot", false, "lr_0");
        connect(g, a, "hot"); connect(g, b, "warm");
        const c = g.selectionCounters();
        expect([c.KnownLocalRootPeers, c.EstablishedLocalRootPeers, c.ActiveLocalRootPeers]).toEqual([2, 2, 1]);
        expect(c.WarmLocalRoots).toBe(1); // = active
        expect(c.HotLocalRoots).toBe(1); // = established − active
    });
});

/**
 * Offline simulation of the governor loop in peerManager's order (ledger picks → cold→warm →
 * warm→hot → churn), with connections that succeed 70 % of the time. Checks that the regular and
 * big ledger targets converge, local-root valency holds, and churn rotates peers without ever
 * dropping below one hot peer.
 */
describe("simulated governor loop", () => {
    test("converges to targets and churns within bounds", () => {
        const r = mulberry32(2026);
        const g = new PeerGovernor({ targetHot: 3, targetWarm: 6, targetCold: 30, maxHot: 8, maxWarm: 24, targetKnownBigLedger: 15, targetEstablishedBigLedger: 10, targetActiveBigLedger: 5 });
        g.registerLocalRootGroup("lr_0", 1);
        g.noteKnown("127.0.0.1", 6424, "localRoot", false, "lr_0");
        let ledgerIx = 0, bigIx = 0;
        let now = Date.now();
        const tryConnect = (p: PeerRecord) => { if (r() < 0.7) connect(g, p, "warm", { lastRollForwardAt: now }); else g.markFail(p.key, "sim"); };
        let minHot = Infinity, churned = 0;
        for (let tick = 0; tick < 400; tick++) {
            now += 15_000;
            for (let i = 0; g.regularCounts().cold < g.targets.targetCold && i < 32; i++) g.noteKnown(`10.${(ledgerIx >> 8) & 255}.${ledgerIx++ & 255}.1`, 3001, "ledger");
            for (let i = g.needsBigLedgerKnown(); i > 0; i--) g.noteKnown(`10.200.${bigIx++ & 255}.1`, 3001, "bigLedger");
            for (const p of g.pickLocalRootColdForWarm(now)) tryConnect(p);
            for (const p of g.pickColdForWarm(Math.min(g.needsWarmSlots(), 2), now)) tryConnect(p);
            for (const p of g.pickColdForWarm(Math.min(g.needsBigLedgerEstablished(), 2), now, true)) tryConnect(p);
            for (const p of g.pickLocalRootWarmForHot(now)) g.attachClient(p.key, p.client!, "hot");
            for (const p of g.pickWarmForHot(g.needsHotSlots(), now)) g.attachClient(p.key, p.client!, "hot");
            for (const p of g.pickWarmForHot(g.needsBigLedgerHot(), now, true)) g.attachClient(p.key, p.client!, "hot");
            if (tick > 0 && tick % 220 === 0) { // one churn round (3300 s at 15 s ticks)
                for (const bl of [true, false]) {
                    const hot = g.pickChurnHot(bl, r);
                    for (const p of hot) { g.attachClient(p.key, p.client!, "warm"); p.churnHoldUntil = now + 30_000; }
                    const warm = g.pickChurnWarm(bl, r).filter((p) => !hot.includes(p));
                    for (const p of warm) { g.detachClient(p.key); p.churnHoldUntil = now + 300_000; }
                    for (const p of g.pickChurnCold(bl, r)) g.forget(p.key);
                    churned += hot.length + warm.length;
                }
            }
            if (tick > 20) minHot = Math.min(minHot, g.counts().hot);
        }
        const reg = g.regularCounts(), bl = g.bigLedgerCounts();
        expect(reg.hot).toBe(3);
        expect(reg.warm).toBeGreaterThanOrEqual(6 - 3);
        expect(bl.hot).toBe(5);
        expect(bl.warm + bl.hot).toBe(10);
        expect(bl.total).toBeGreaterThanOrEqual(15);
        expect(g.countHotInGroup("lr_0")).toBe(1);
        expect(minHot).toBeGreaterThanOrEqual(1);
        expect(churned).toBeGreaterThan(0);
    });
});

describe("silent hot→warm demotion (bug 391)", () => {
    test("a local root is never demoted for silence; a peer that answered AwaitReply recently is alive; a truly silent peer is picked", () => {
        const g = new PeerGovernor({ targetHot: 4, targetWarm: 2 });
        g.registerLocalRootGroup("lr_0", 1, 1);
        const now = 1_800_000_000_000;
        const root = g.noteKnown("172.22.0.3", 3001, "localRoot", false, "lr_0");
        const atTip = g.noteKnown("8.8.8.8", 3001, "publicRoot");
        const silent = g.noteKnown("9.9.9.9", 3001, "publicRoot");
        const fresh = g.noteKnown("7.7.7.7", 3001, "publicRoot");
        // the root served our own chain: one AwaitReply hours ago, no RollForward ever
        connect(g, root, "hot", { lastChainSyncReplyAt: now - 8 * 3_600_000 });
        // at our tip: AwaitReply 30 s ago, last RollForward 10 min ago
        connect(g, atTip, "hot", { lastRollForwardAt: now - 600_000, lastChainSyncReplyAt: now - 30_000 });
        // silent: nothing for 10 min
        connect(g, silent, "hot", { lastRollForwardAt: now - 600_000, lastChainSyncReplyAt: now - 600_000 });
        connect(g, fresh, "hot", { lastRollForwardAt: now - 5_000, lastChainSyncReplyAt: now - 5_000 });
        for (const r of [root, atTip, silent, fresh]) g.get(r.key)!.syncing = true;
        expect(g.pickSilentHot(180_000, now).map((p) => p.key)).toEqual([silent.key]);
        expect(PeerGovernor.lastAliveAt(g.get(atTip.key)!)).toBe(now - 30_000);
    });

    test("a network-wide quiet spell demotes nobody; a peer behind the others is still picked; 10 min of total silence rotates all (bug 396)", () => {
        const now = 1_800_000_000_000;
        const build = (ages: number[]) => {
            const g = new PeerGovernor({ targetHot: 6, targetWarm: 2 });
            g.registerLocalRootGroup("lr_0", 1, 1);
            const root = g.noteKnown("172.22.0.3", 3001, "localRoot", false, "lr_0");
            connect(g, root, "hot", { lastChainSyncReplyAt: now - 8 * 3_600_000 });
            g.get(root.key)!.syncing = true;
            const keys = ages.map((age, i) => {
                const r = g.noteKnown(`10.0.0.${i + 1}`, 3001, "publicRoot");
                connect(g, r, "hot", { lastRollForwardAt: now - age, lastChainSyncReplyAt: now - age });
                g.get(r.key)!.syncing = true;
                return r.key;
            });
            return { g, keys };
        };
        // 2026-10-13 15:29 UTC: no preview block for ~225 s, all five public peers last spoke ~184 s ago
        const quiet = build([184_627, 184_616, 184_567, 184_554, 184_523]);
        expect(quiet.g.pickSilentHot(180_000, now)).toEqual([]);
        // one peer stuck while the others delivered a block 5 s ago
        const stuck = build([5_000, 6_000, 200_000, 5_500]);
        expect(stuck.g.pickSilentHot(180_000, now).map((p) => p.key)).toEqual([stuck.keys[2]]);
        // every public peer silent for 11 min: the upstream is dead, rotate them (one hot peer always stays)
        const dead = build([660_000, 661_000, 662_000]);
        expect(dead.g.pickSilentHot(180_000, now).length).toBe(3);
    });
});
