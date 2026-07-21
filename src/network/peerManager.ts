import { logger } from "../utils/logger";
import {
    adaptLegacyTopology,
    isLegacyTopology,
    isTopology,
    type Topology,
} from "./topology";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import type { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { GlobalSharedMempool } from "./SharedMempool";
import {
    ConsensusOrchestrator,
    type PeerAccessor,
} from "../consensus/ConsensusOrchestratooor";
import {
    PeerGovernor,
    peerKey,
    type PeerGovernorSnapshot,
    type PeerGovernorTargets,
    type PeerRecord,
    type PeerSource,
    DEFAULT_PEER_GOVERNOR_TARGETS,
} from "./PeerGovernor";
import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";

export interface PeerGovernorConfig {
    /** Master switch — false keeps legacy hot-first path. Default true. */
    enabled?: boolean;
    targetHot?: number;
    targetWarm?: number;
    targetCold?: number;
    maxHot?: number;
    maxWarm?: number;
    maxCold?: number;
    /** Governor tick interval ms. Default 15000. */
    tickMs?: number;
    /** PeerSharing request size. Default 10. */
    shareBatch?: number;
    /** Run PeerSharing every N ticks. Default 2. */
    shareEveryTicks?: number;
}

export interface GerolamoConfig {
    readonly network: NetworkT;
    readonly networkMagic: number;
    readonly topologyFile: string;
    readonly syncFromTip: boolean;
    readonly syncFromGenesis: boolean;
    readonly genesisBlockHash: string;
    readonly syncFromPoint: boolean;
    readonly syncFromPointSlot: bigint;
    readonly syncFromPointBlockHash: string;
    readonly logLevel: string;
    readonly shelleyGenesisFile: string;
    readonly enableMinibf?: boolean;
    readonly dbPath: string;
    readonly port?: number;
    readonly unixSocket?: boolean;
    /**
     * Ouroboros Node-to-Client Unix socket path (node.socket).
     * Distinct from unixSocket (HTTP-over-unix on peerBlockServer).
     * Env: GEROLAMO_N2C_SOCKET; disable with GEROLAMO_N2C=0.
     */
    readonly n2cSocketPath?: string;
    readonly logs: {
        readonly logToFile: boolean;
        readonly logToConsole: boolean;
        readonly logDirectory: string;
    };
    readonly snapshot: {
        readonly enable: boolean;
        readonly source: string;
    };
    readonly tuiEnabled?: boolean;
    readonly blockfrostUrl?: string;
    /**
     * Body validation policy.
     * - soft (default): log failures but still apply (mid-chain tolerance)
     * - strict: reject invalid bodies — no apply / no nonce feed / no insert
     */
    readonly bodyValidation?: "soft" | "strict";
    /**
     * Plutus/native script validation.
     * - off (default): skip
     * - log: run checks, log failures, still accept
     * - strict: reject on script failure
     */
    readonly scriptValidation?: "off" | "log" | "strict";
    /** Cold/warm/hot governor knobs (network-design v1). */
    readonly peerGovernor?: PeerGovernorConfig;
    allPeers: Map<string, PeerClient>;
}

let topology: Topology;
let shelleyGenesisConfig: ShelleyGenesisConfig;
/** Live clients keyed by stable peerKey (host:port). */
const clientsByKey = new Map<string, PeerClient>();
/** Also index by peerId for consensus lookups that still pass peerId. */
const clientsById = new Map<string, PeerClient>();
let governor: PeerGovernor | undefined;
let monitorInterval: ReturnType<typeof setInterval> | undefined;
let consensus: ConsensusOrchestrator | undefined;
let activeConfig: GerolamoConfig | undefined;
let tickCount = 0;
/** In-flight connects so we don't double-promote the same cold peer. */
const connecting = new Set<string>();
let tickRunning = false;

function govEnabled(config: GerolamoConfig): boolean {
    return config.peerGovernor?.enabled !== false;
}

function targetsFromConfig(config: GerolamoConfig): Partial<PeerGovernorTargets> {
    const g = config.peerGovernor ?? {};
    return {
        targetHot: g.targetHot,
        targetWarm: g.targetWarm,
        targetCold: g.targetCold,
        maxHot: g.maxHot,
        maxWarm: g.maxWarm,
        maxCold: g.maxCold,
    };
}

function getPeerAccessor(): PeerAccessor {
    return {
        getPeer(peerId: string): PeerClient | null {
            return (
                clientsById.get(peerId) ??
                clientsByKey.get(peerId) ??
                (governor?.getClientByIdOrKey(peerId) as PeerClient | null) ??
                null
            );
        },
        pickHotPeer(): PeerClient | null {
            if (governor) {
                return (governor.pickHotPeer() as PeerClient | null) ?? null;
            }
            // legacy fallback
            for (const c of clientsByKey.values()) {
                if (c.isSyncing) return c;
            }
            return clientsByKey.values().next().value ?? null;
        },
    };
}

function wirePeerConsensus(peer: PeerClient): void {
    if (!consensus) return;
    const orch = consensus;
    peer.onRollForward = (peerId, rollForwardCborBytes, tip) => {
        void orch.handleRollForward(
            rollForwardCborBytes,
            peerId,
            BigInt(tip),
        );
    };
    peer.onRollBack = (peerId, point) => {
        void orch.handleRollBack(point).catch((err) => {
            logger.error(`handleRollBack failed for ${peerId}:`, err);
        });
    };
}

/** IPv4 PeerAddress.address is a 32-bit int — convert to dotted quad. */
export function ipv4NumberToString(addr: number | bigint): string {
    const n = Number(addr) >>> 0;
    return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
    ].join(".");
}

/** Best-effort host string from PeerSharing PeerAddress. */
export function peerAddressToHostPort(
    p: PeerAddress,
): { host: string; port: number } | null {
    const port = Number((p as any).portNumber);
    if (!Number.isFinite(port) || port <= 0) return null;
    const addr = (p as any).address;
    if (typeof addr === "number" || typeof addr === "bigint") {
        return { host: ipv4NumberToString(addr), port };
    }
    // IPv6 raw tuple — skip in v1 (no solid connect path yet)
    if (Array.isArray(addr)) {
        logger.debug("Skipping IPv6 shared peer (v1)");
        return null;
    }
    if (typeof addr === "string" && addr.length > 0) {
        return { host: addr, port };
    }
    return null;
}

function seedTopologyIntoGovernor(topo: Topology, gov: PeerGovernor): void {
    if (topo.bootstrapPeers) {
        for (const ap of topo.bootstrapPeers) {
            gov.noteKnown(
                String(ap.address),
                ap.port,
                "bootstrap",
                false,
            );
        }
    }
    if (topo.localRoots) {
        for (const root of topo.localRoots) {
            const trustable = (root as any).trustable !== false;
            for (const ap of root.accessPoints) {
                gov.noteKnown(ap.address, ap.port, "localRoot", trustable);
            }
        }
    }
    if (topo.publicRoots) {
        for (const root of topo.publicRoots) {
            for (const ap of root.accessPoints) {
                gov.noteKnown(ap.address, ap.port, "publicRoot", false);
            }
        }
    }
}

function registerClient(peer: PeerClient): void {
    clientsByKey.set(peer.peerKey, peer);
    clientsById.set(peer.peerId, peer);
    if (activeConfig) activeConfig.allPeers = clientsById;
}

function unregisterClient(peerKeyStr: string, peerId?: string): void {
    const c = clientsByKey.get(peerKeyStr);
    clientsByKey.delete(peerKeyStr);
    if (peerId) clientsById.delete(peerId);
    else if (c) clientsById.delete(c.peerId);
}

async function connectWarm(
    rec: PeerRecord,
    config: GerolamoConfig,
    gov: PeerGovernor,
): Promise<boolean> {
    if (connecting.has(rec.key) || clientsByKey.has(rec.key)) return false;
    connecting.add(rec.key);
    try {
        const peer = new PeerClient(
            rec.host,
            rec.port,
            config,
            (peerId, pKey) => {
                logger.debug(`Peer terminated ${peerId} key=${pKey}`);
                unregisterClient(pKey, peerId);
                gov.markFail(pKey, "terminated");
                gov.detachClient(pKey);
            },
        );
        await peer.handShakePeer();
        peer.startKeepAlive();
        wirePeerConsensus(peer);
        registerClient(peer);
        gov.attachClient(rec.key, peer, "warm");
        logger.info(`Warm peer ready ${rec.key} (source=${rec.source})`);
        return true;
    } catch (error) {
        logger.error(`Failed warm connect ${rec.key}:`, error);
        gov.markFail(rec.key, String((error as any)?.message || error));
        return false;
    } finally {
        connecting.delete(rec.key);
    }
}

async function promoteToHot(
    rec: PeerRecord,
    gov: PeerGovernor,
): Promise<boolean> {
    const client = clientsByKey.get(rec.key);
    if (!client) return false;
    try {
        wirePeerConsensus(client);
        await client.startSyncLoop();
        gov.attachClient(rec.key, client, "hot");
        logger.info(`Hot peer syncing ${rec.key}`);
        return true;
    } catch (error) {
        logger.error(`Failed hot promote ${rec.key}:`, error);
        try {
            client.stopSyncLoop();
        } catch {
            /* */
        }
        gov.markFail(rec.key, String((error as any)?.message || error));
        return false;
    }
}

function demoteHotToWarm(rec: PeerRecord, gov: PeerGovernor): void {
    const client = clientsByKey.get(rec.key);
    if (client) {
        try {
            client.stopSyncLoop();
        } catch (err) {
            logger.error(`stopSyncLoop failed ${rec.key}:`, err);
        }
    }
    if (client) gov.attachClient(rec.key, client, "warm");
    else gov.setTier(rec.key, "warm");
    logger.info(`Demoted hot→warm ${rec.key}`);
}

async function runPeerSharing(
    gov: PeerGovernor,
    shareBatch: number,
): Promise<void> {
    if (!gov.needsColdPeers()) return;
    const donors = [
        ...gov.listByTier("hot"),
        ...gov.listByTier("warm"),
    ].filter((r) => r.client);
    if (donors.length === 0) return;

    // Ask up to 2 connected peers
    for (const rec of donors.slice(0, 2)) {
        const client = clientsByKey.get(rec.key);
        if (!client) continue;
        try {
            const peers = await client.askForPeers(shareBatch);
            let added = 0;
            for (const p of peers) {
                const hp = peerAddressToHostPort(p);
                if (!hp) continue;
                const before = gov.get(peerKey(hp.host, hp.port));
                gov.noteKnown(hp.host, hp.port, "shared", false);
                if (!before) added++;
            }
            if (added > 0) {
                logger.info(
                    `PeerSharing via ${rec.key}: +${added} cold (batch=${peers.length})`,
                );
            }
        } catch (err) {
            logger.debug(`PeerSharing failed on ${rec.key}:`, err);
            // soft — don't demote solely for share failure
        }
    }
}

async function governorTick(
    config: GerolamoConfig,
    gov: PeerGovernor,
): Promise<void> {
    if (tickRunning) return;
    tickRunning = true;
    tickCount++;
    try {
        const gcfg = config.peerGovernor ?? {};
        const shareEvery = gcfg.shareEveryTicks ?? 2;
        const shareBatch = gcfg.shareBatch ?? 10;

        // 1) Grow cold via PeerSharing
        if (tickCount === 1 || tickCount % shareEvery === 0) {
            await runPeerSharing(gov, shareBatch);
        }

        // 2) cold → warm
        const needWarm = gov.needsWarmSlots();
        if (needWarm > 0) {
            const picks = gov.pickColdForWarm(needWarm);
            for (const rec of picks) {
                await connectWarm(rec, config, gov);
            }
        }

        // 3) warm → hot
        const needHot = gov.needsHotSlots();
        if (needHot > 0) {
            const picks = gov.pickWarmForHot(needHot);
            for (const rec of picks) {
                await promoteToHot(rec, gov);
            }
        }

        // 4) demote excess hot (never last hot)
        const demote = gov.pickHotForDemotion(gov.excessHot() || 0);
        // also soft-trim above targetHot
        if (demote.length === 0 && gov.counts().hot > gov.targets.targetHot) {
            const extra = gov.pickHotForDemotion(
                gov.counts().hot - gov.targets.targetHot,
            );
            for (const rec of extra) demoteHotToWarm(rec, gov);
        } else {
            for (const rec of demote) demoteHotToWarm(rec, gov);
        }

        // 5) if zero hot and we have cold roots, force a warm+hot attempt
        if (gov.counts().hot === 0) {
            const emergency = gov.pickColdForWarm(1);
            for (const rec of emergency) {
                const ok = await connectWarm(rec, config, gov);
                if (ok) {
                    const warm = gov.get(rec.key);
                    if (warm) await promoteToHot(warm, gov);
                }
            }
            // also try existing warm
            for (const rec of gov.pickWarmForHot(1)) {
                await promoteToHot(rec, gov);
            }
        }

        if (tickCount === 1 || tickCount % 4 === 0) {
            logger.info(
                `PeerGovernor snapshot ${JSON.stringify(gov.snapshot())}`,
            );
        }
    } catch (err) {
        logger.error("PeerGovernor tick error:", err);
    } finally {
        tickRunning = false;
    }
}

export function getGovernorSnapshot(): PeerGovernorSnapshot | null {
    return governor?.snapshot() ?? null;
}

export function getPeerGovernor(): PeerGovernor | undefined {
    return governor;
}

export async function stopPeerManager(): Promise<void> {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = undefined;
    }
    for (const c of [...clientsByKey.values()]) {
        try {
            c.terminate();
        } catch {
            /* */
        }
    }
    clientsByKey.clear();
    clientsById.clear();
    governor = undefined;
}

export async function initPeerManager(config: GerolamoConfig): Promise<void> {
    activeConfig = config;
    logger.setLogConfig(config.logs);
    if (config.tuiEnabled) {
        logger.setLogConfig({ logToConsole: false });
    }

    const topoFile = Bun.file(config.topologyFile);
    if (!(await topoFile.exists())) {
        throw new Error("missing topology file at " + config.topologyFile);
    }

    let parsedTopology = await topoFile.json();
    parsedTopology = isLegacyTopology(parsedTopology)
        ? adaptLegacyTopology(parsedTopology)
        : parsedTopology;

    if (!isTopology(parsedTopology)) {
        throw new Error("invalid topology file at " + config.topologyFile);
    }
    topology = parsedTopology;

    const shelleyGenesisFile = Bun.file(config.shelleyGenesisFile);
    if (!(await shelleyGenesisFile.exists())) {
        throw new Error(
            "missing Shelley genesis file at " + config.shelleyGenesisFile,
        );
    }
    shelleyGenesisConfig = await shelleyGenesisFile.json();
    GlobalSharedMempool.getInstance();
    logger.mempool("Global SharedMempool initialized in PeerManager");

    consensus = new ConsensusOrchestrator(config, getPeerAccessor());
    config.allPeers = clientsById;
    logger.info("ConsensusOrchestrator ready (rollForward/rollBack → DB)");

    if (!govEnabled(config)) {
        logger.warn(
            "peerGovernor.enabled=false — using legacy hot-first path",
        );
        await initLegacyHotFirst(config);
        return;
    }

    governor = new PeerGovernor(targetsFromConfig(config));
    seedTopologyIntoGovernor(topology, governor);
    logger.info(
        `PeerGovernor seeded ${JSON.stringify(governor.snapshot())}`,
    );

    // Immediate first tick (bootstrap warm+hot)
    await governorTick(config, governor);

    const tickMs = config.peerGovernor?.tickMs ?? 15_000;
    monitorInterval = setInterval(() => {
        if (!governor || !activeConfig) return;
        void governorTick(activeConfig, governor);
    }, tickMs);

    logger.info(
        `PeerGovernor loop started tickMs=${tickMs} targets=${
            JSON.stringify(governor.targets)
        }`,
    );
}

// ─── Legacy path (peerGovernor.enabled === false) ───────────────────────────

async function initLegacyHotFirst(config: GerolamoConfig): Promise<void> {
    const bootstrapList: PeerClient[] = [];
    const hotList: PeerClient[] = [];

    async function addHot(host: string, port: number | bigint): Promise<void> {
        try {
            const peer = new PeerClient(host, port, config, (peerId, pKey) => {
                unregisterClient(pKey, peerId);
                const idx = hotList.findIndex((p) => p.peerKey === pKey);
                if (idx >= 0) hotList.splice(idx, 1);
            });
            await peer.handShakePeer();
            peer.startKeepAlive();
            wirePeerConsensus(peer);
            registerClient(peer);
            hotList.push(peer);
            await peer.startSyncLoop();
            logger.debug(`Legacy hot peer ${peer.peerKey}`);
        } catch (error) {
            logger.error(`Legacy addPeer failed ${host}:${port}`, error);
        }
    }

    if (topology.bootstrapPeers) {
        for (const ap of topology.bootstrapPeers) {
            await addHot(String(ap.address), ap.port);
        }
    }
    if (topology.localRoots) {
        for (const root of topology.localRoots) {
            for (const ap of root.accessPoints) {
                await addHot(ap.address, ap.port);
            }
        }
    }

    monitorInterval = setInterval(async () => {
        if (hotList.length > 0) return;
        logger.warn("Legacy: no hot peers — replenishing topology");
        if (topology.bootstrapPeers) {
            for (const ap of topology.bootstrapPeers) {
                await addHot(String(ap.address), ap.port);
            }
        }
    }, 30_000);

    void bootstrapList;
}

// Re-export defaults for tests/docs
export { DEFAULT_PEER_GOVERNOR_TARGETS, peerKey };
export type { PeerSource, PeerGovernorSnapshot };
