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
import { classifyPeerNetError } from "./peerNetError";
import { GlobalSharedMempool } from "./SharedMempool";
import {
    ConsensusOrchestrator,
    type PeerAccessor,
    type SyncSnapshot,
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
import { emitPeers } from "./liveEvents";
import { getShelleyGenesisConfig } from "../utils/paths";
import { withTimeout } from "../utils/withTimeout";
import type { ResolvedN2NConfig } from "./n2n/config";
import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { peerSharingAdvertised, resolveNodeRole, type NodeRole } from "./nodeRole";

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
    /** Max parallel cold→warm connects per tick. Default 2. */
    maxConcurrentWarm?: number;
    /** Handshake/connect timeout ms. Default 12000. */
    connectTimeoutMs?: number;
    /**
     * Demote hot peers with no rollForward for this many ms.
     * Default 180000 (3m). Set 0 to disable.
     */
    hotSilentMs?: number;
    /**
     * Advertise PeerSharing in the handshake and ask peers for addresses.
     * Default: true for role "relay", false for "data" (see nodeRole.ts).
     */
    peerSharing?: boolean;
    /** Forget shared (unverified) cold peers after this many failed connects. Default 3, 0 = never. */
    maxSharedPeerFailures?: number;
    /** Expand bootstrap/publicRoot DNS names into one peer per A record. Default true. */
    resolveDns?: boolean;
}

export interface BlockFetchBatchConfig {
    /** ChainSync headers per batch handed to the orchestrator (validation unit). Clamped to 1..256. */
    maxBlocks?: number;
    /**
     * Largest BlockFetch range (blocks) while far behind the tip. Ranges shrink as
     * the applier nears the tip (…64, 16, 4, 1). Default 128, clamped to 1..256.
     */
    maxRangeBlocks?: number;
    /**
     * Validated headers allowed to wait for their bodies (the header fragment).
     * Default = the security parameter k (2160 on mainnet / preprod).
     */
    headerLookahead?: number;
    /**
     * ChainSync MsgRequestNext kept in flight while behind the peer's tip
     * (protocol pipelining). 1 = one header per round trip. Default 32.
     */
    pipelineDepth?: number;
    /** Flush a partial live-tail header batch after this many ms. */
    flushMs?: number;
    /** Abort and terminate a contaminated range connection before spec 60s. */
    rangeTimeoutMs?: number;
    /** Ranges downloading concurrently across peers. Default = hot peer target. */
    parallelRanges?: number;
}

export interface GerolamoConfig {
    readonly network: NetworkT;
    readonly networkMagic: number;
    /** "data" (default, outbound only) or "relay" (also accepts inbound N2N). See nodeRole.ts. */
    readonly role?: NodeRole;
    readonly topologyFile: string;
    readonly syncFromTip: boolean;
    readonly syncFromGenesis: boolean;
    readonly genesisBlockHash: string;
    readonly syncFromPoint: boolean;
    readonly syncFromPointSlot: bigint;
    readonly syncFromPointBlockHash: string;
    readonly logLevel: string;
    readonly shelleyGenesisFile: string;
    readonly byronGenesisFile?: string;
    /** Byron genesis hash: expected prevBlock of the epoch-0 EBB when syncing from origin. */
    readonly byronGenesisHash?: string;
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
    /** Optional inbound Cardano node-to-node TCP relay listener. */
    readonly n2n?: ResolvedN2NConfig;
    readonly logs: {
        readonly logToFile: boolean;
        readonly logToConsole: boolean;
        readonly logDirectory: string;
        /** Rotate each level's .jsonl when larger than this (bytes; default 64 MiB, 0 = never). */
        readonly maxFileBytes?: number;
        /** Rotated files kept per level (default 5). */
        readonly keepFiles?: number;
    };
    readonly snapshot: {
        readonly enable: boolean;
        readonly source: string;
    };
    readonly tuiEnabled?: boolean;
    readonly blockfrostUrl?: string;
    /** @deprecated ignored — validation is derived from the sync mode (see consensus/validationPolicy.ts). */
    readonly bodyValidation?: "auto" | "soft" | "strict";
    /** @deprecated ignored — validation is derived from the sync mode (see consensus/validationPolicy.ts). */
    readonly scriptValidation?: "off" | "log" | "strict";
    /** Cold/warm/hot governor knobs (network-design v1). */
    readonly peerGovernor?: PeerGovernorConfig;
    /** True BlockFetch RequestRange catch-up batching. */
    readonly blockFetchBatch?: BlockFetchBatchConfig;
    /** Header-validation CPU pool. */
    readonly validation?: {
        /** Bun workers for header validation: number, or "auto" (= all cores). 0 = inline. */
        readonly workers?: number | "auto";
    };
    /** Multi-peer honesty knobs. */
    readonly sync?: {
        /**
         * Skip the MiniBF forward index (tx_index / address_tx / mb_*) while the applier
         * is more than one epoch behind the primary's tip; run scripts/backfill-minibf.mjs
         * once caught up. Off by default: the index is then always complete.
         */
        readonly skipIndexWhileBehind?: boolean;
        /** Verifiers that must agree on an alternative before the primary is considered wrong. Default 2. */
        readonly quorum?: number;
        /** Cold hold for divergent / lying peers, ms. Default 1h. */
        readonly maliciousHoldMs?: number;
    };
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

const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_CONCURRENT_WARM = 2;
const DEFAULT_HOT_SILENT_MS = 180_000;

function govEnabled(config: GerolamoConfig): boolean {
    return config.peerGovernor?.enabled !== false;
}

function targetsFromConfig(config: GerolamoConfig): Partial<PeerGovernorTargets> {
    const g = config.peerGovernor ?? {};
    // Only pass keys the config actually sets: `{...DEFAULTS, ...{targetHot: undefined}}`
    // would erase the default and leave the governor with NaN targets (mainnet
    // config had no peerGovernor block → 1 hot peer forever).
    const out: Partial<PeerGovernorTargets> = {};
    for (const k of ["targetHot", "targetWarm", "targetCold", "maxHot", "maxWarm", "maxCold"] as const) {
        const v = g[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
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
        return orch.handleRollForward(
            rollForwardCborBytes,
            peerId,
            BigInt(tip),
        );
    };
    peer.onRollForwardBatch = (peerId, items) => {
        return orch.handleRollForwardBatch(items, peerId);
    };
    peer.onRollBack = async (peerId, point) => {
        await orch.handleRollBack(point, undefined, peerId).catch((err) => {
            logger.error(`handleRollBack failed for ${peerId}:`, err);
            throw err;
        });
    };
}

/**
 * PeerSharing encodes SockAddrInet's raw Haskell HostAddress Word32.
 * Its octets are least-significant first (the same order as
 * Network.Socket.hostAddressToTuple), not display-order integer shifts.
 */
export function ipv4NumberToString(addr: number | bigint): string {
    const n = Number(addr) >>> 0;
    return [
        n & 0xff,
        (n >>> 8) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 24) & 0xff,
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

export type DnsResolver = (host: string) => Promise<string[]>;

const DEFAULT_DNS_TIMEOUT_MS = 4000;

/**
 * One topology access point → one peer per IPv4 A record.
 * IOG's public relays (`preprod-node.play.dev.cardano.org`, `backbone.cardano.iog.io`)
 * are round-robin names over 8+ hosts; cardano-node treats each address as its
 * own peer (that is what `valency` counts). Without this the governor sees a
 * single "peer" and can never reach targetHot from bootstrap alone.
 * Literal IPs and failed lookups pass through unchanged.
 */
export async function expandAccessPoint(
    host: string,
    resolver: DnsResolver = (h) => resolve4(h),
): Promise<string[]> {
    const h = String(host).trim();
    if (!h) return [];
    if (isIP(h)) return [h];
    try {
        const addrs = await withTimeout(resolver(h), DEFAULT_DNS_TIMEOUT_MS, `dns ${h}`);
        const uniq = [...new Set(addrs.filter((a) => isIP(a) === 4))];
        return uniq.length > 0 ? uniq : [h];
    } catch (err) {
        logger.debug(`DNS expand failed for ${h}, keeping hostname:`, err);
        return [h];
    }
}

async function seedTopologyIntoGovernor(
    topo: Topology,
    gov: PeerGovernor,
    resolveDns = true,
    resolver?: DnsResolver,
): Promise<void> {
    const expand = (host: string) =>
        resolveDns ? expandAccessPoint(host, resolver) : Promise.resolve([String(host)]);
    if (topo.bootstrapPeers) {
        for (const ap of topo.bootstrapPeers) {
            const hosts = await expand(String(ap.address));
            for (const host of hosts) {
                gov.noteKnown(host, ap.port, "bootstrap", false);
            }
            if (hosts.length > 1) {
                logger.info(`Bootstrap ${ap.address}:${ap.port} → ${hosts.length} addresses`);
            }
        }
    }
    if (topo.localRoots) {
        // P1: register each localRoots[] group + hard valency
        for (let i = 0; i < topo.localRoots.length; i++) {
            const root = topo.localRoots[i]!;
            const groupId = `lr_${i}`;
            const valency = Math.max(0, Math.floor(Number(root.valency ?? 0)));
            gov.registerLocalRootGroup(groupId, valency);
            const trustable = (root as { trustable?: boolean }).trustable !== false;
            for (const ap of root.accessPoints) {
                gov.noteKnown(
                    ap.address,
                    ap.port,
                    "localRoot",
                    trustable,
                    groupId,
                );
            }
        }
    }
    if (topo.publicRoots) {
        for (const root of topo.publicRoots) {
            for (const ap of root.accessPoints) {
                for (const host of await expand(ap.address)) {
                    gov.noteKnown(host, ap.port, "publicRoot", false);
                }
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
    if (connecting.has(rec.key)) return false;
    // Respect exponential backoff gate
    if (rec.nextRetryAt && rec.nextRetryAt > Date.now()) return false;

    // Stale zombie: socket still in clientsByKey but governor tier is cold
    // (e.g. prior silent-demote + markFail orphan). Tear down then redial.
    const existing = clientsByKey.get(rec.key);
    if (existing) {
        const govRec = gov.get(rec.key);
        if (govRec && (govRec.tier === "warm" || govRec.tier === "hot") && govRec.client) {
            // Already warm/hot with a live client — nothing to do.
            return true;
        }
        logger.info(
            `connectWarm: clearing stale client ${rec.key} (govTier=${govRec?.tier ?? "?"})`,
        );
        try {
            existing.terminate();
        } catch {
            /* */
        }
        unregisterClient(rec.key, existing.peerId);
        gov.detachClient(rec.key);
    }

    connecting.add(rec.key);
    let peer: PeerClient | undefined;
    let registered = false;
    try {
        peer = new PeerClient(
            rec.host,
            rec.port,
            config,
            shelleyGenesisConfig,
            (peerId, pKey, reason) => {
                logger.info(`Peer terminated ${peerId} key=${pKey}${reason ? ` reason=${reason}` : ""}`);
                unregisterClient(pKey, peerId);
                consensus?.unregisterHotPeer(pKey);
                if (reason?.startsWith("malicious:")) {
                    // Provably bad data (body hash / signature / divergence): 1h cold hold.
                    logger.warn(`Peer ${pKey} held cold for bad data: ${reason}`);
                    gov.markMalicious(
                        pKey,
                        reason,
                        config.sync?.maliciousHoldMs ?? PeerGovernor.MALICIOUS_BACKOFF_MS,
                    );
                    return;
                }
                if (registered) {
                    gov.markFail(pKey, reason ?? "terminated");
                }
                gov.detachClient(pKey);
            },
        );
        const timeoutMs =
            config.peerGovernor?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        await withTimeout(
            peer.handShakePeer(),
            timeoutMs,
            `handshake ${rec.key}`,
            () => peer?.terminate(`handshake ${rec.key} timed out`),
        );
        peer.startKeepAlive();
        wirePeerConsensus(peer);
        registerClient(peer);
        registered = true;
        gov.attachClient(rec.key, peer, "warm");
        logger.info(`Warm peer ready ${rec.key} (source=${rec.source})`);
        return true;
    } catch (error) {
        const failure = classifyPeerNetError(error, rec.key);
        if (failure.expected) logger.warn(`Failed warm connect ${failure.line}`);
        else logger.error(`Failed warm connect ${rec.key}:`, error);
        // Close unregistered half-open sockets too; timeouts used to leak SYN-SENT FDs.
        try {
            peer?.terminate(String((error as any)?.message || error));
            const half = clientsByKey.get(rec.key);
            if (half) {
                half.terminate();
                unregisterClient(rec.key, half.peerId);
            }
        } catch {
            /* */
        }
        gov.markFail(rec.key, String((error as any)?.message || error));
        return false;
    } finally {
        connecting.delete(rec.key);
    }
}

export function startHotSyncWithTimeout(
    client: {
        startSyncLoop(): Promise<void>;
        terminate(reason?: string): void;
    },
    key: string,
    timeoutMs: number,
): Promise<void> {
    const label = `hot sync ${key}`;
    return withTimeout(client.startSyncLoop(), timeoutMs, label, () => {
        client.terminate(`${label} timed out after ${timeoutMs}ms`);
    });
}

async function promoteToHot(
    rec: PeerRecord,
    gov: PeerGovernor,
    timeoutMs: number,
): Promise<boolean> {
    const client = clientsByKey.get(rec.key);
    if (!client) return false;
    try {
        wirePeerConsensus(client);
        consensus?.registerHotPeer(rec.key);
        await startHotSyncWithTimeout(client, rec.key, timeoutMs);
        gov.attachClient(rec.key, client, "hot");
        logger.info(`Hot peer syncing ${rec.key} (${consensus?.roleOf(rec.key) ?? "no-orchestrator"})`);
        return true;
    } catch (error) {
        const failure = classifyPeerNetError(error);
        if (failure.expected) {
            logger.warn(`Failed hot promote ${rec.key} ${failure.line}`);
        } else {
            logger.error(`Failed hot promote ${rec.key}:`, error);
        }
        try {
            client.stopSyncLoop();
        } catch {
            /* */
        }
        consensus?.unregisterHotPeer(rec.key);
        const reason = failure.line;
        client.terminate(`hot promotion ${rec.key}: ${reason}`);
        // Registered-client termination records the failure. Keep this fallback
        // for a client already absent from the manager map.
        if (gov.get(rec.key)?.tier !== "cold") {
            gov.markFail(rec.key, reason);
        }
        return false;
    }
}

/**
 * Spec (network-design): hot→warm demotion keeps the bearer for keepalive / ΔQ.
 * ChainSync stops; socket + keepalive stay. Do NOT markFail (that cold-drops).
 */
function demoteHotToWarm(rec: PeerRecord, gov: PeerGovernor): void {
    // Never demote the chain driver. The newest hot peer is demoted first, and a verifier
    // just promoted to primary for throughput is exactly that peer. One guard, here, so
    // every demotion path (excess, silent, future ones) is covered.
    if (rec.key === consensus?.primaryPeerKey()) return;
    logger.info(`Hot→warm demotion ${rec.key} (${consensus?.roleOf(rec.key) ?? "no-role"})`);
    consensus?.unregisterHotPeer(rec.key);
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

/**
 * Re-home zombies: live socket in clientsByKey but governor tier is cold
 * (orphan from prior silent+markFail). Spec warm = bearer up without consensus.
 */
function rehomeOrphanClients(gov: PeerGovernor): number {
    let n = 0;
    for (const [key, client] of clientsByKey) {
        const rec = gov.get(key);
        if (!rec) continue;
        if (rec.tier === "cold" || !rec.client) {
            gov.attachClient(key, client, "warm");
            // Clear backoff so we can promote immediately.
            gov.forceClearRetry(key);
            n++;
            logger.info(
                `Rehomed orphan client ${key} → warm (was tier=${rec.tier})`,
            );
        }
    }
    return n;
}

async function runPeerSharing(
    gov: PeerGovernor,
    shareBatch: number,
): Promise<void> {
    if (!gov.needsColdPeers()) return;
    // Only peers that agreed to PeerSharing in the handshake may be asked.
    const donors = [
        ...gov.listByTier("hot"),
        ...gov.listByTier("warm"),
    ].filter((r) => r.client && clientsByKey.get(r.key)?.peerSharingNegotiated);
    if (donors.length === 0) {
        logger.debug("PeerSharing: no connected peer negotiated it; skipping");
        return;
    }

    // Ask up to 2 connected peers (timeout — hung share must not stall tick)
    for (const rec of donors.slice(0, 2)) {
        const client = clientsByKey.get(rec.key);
        if (!client) continue;
        try {
            const peers = await withTimeout(
                client.askForPeers(shareBatch),
                DEFAULT_CONNECT_TIMEOUT_MS,
                `askForPeers ${rec.key}`,
            );
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
    if (tickRunning) {
        logger.debug("Governor tick skipped (already running)");
        return;
    }
    tickRunning = true;
    const startedAt = Date.now();
    tickCount++;
    try {
        const gcfg = config.peerGovernor ?? {};
        const shareEvery = gcfg.shareEveryTicks ?? 2;
        const shareBatch = gcfg.shareBatch ?? 10;
        const maxConcurrent =
            gcfg.maxConcurrentWarm ?? DEFAULT_MAX_CONCURRENT_WARM;
        const connectTimeoutMs =
            gcfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        const silentMs = gcfg.hotSilentMs ?? DEFAULT_HOT_SILENT_MS;
        const now = Date.now();

        // 0) Drop shared addresses that never answer (ephemeral ports of other data nodes)
        const pruned = gov.pruneFailedSharedPeers(gcfg.maxSharedPeerFailures ?? 3);
        if (pruned.length > 0) {
            logger.info(`Forgot ${pruned.length} dead shared peer(s): ${pruned.slice(0, 4).join(", ")}${pruned.length > 4 ? "…" : ""}`);
        }

        // 1) Grow cold via PeerSharing (only when we advertised it in the handshake)
        if (
            peerSharingAdvertised(config) &&
            (tickCount === 1 || tickCount % shareEvery === 0)
        ) {
            await runPeerSharing(gov, shareBatch);
        }

        // 2) cold → warm (capped concurrency; pickColdForWarm respects nextRetryAt)
        // Spec (network-design): maintain targetWarm even when cold peers are
        // all in backoff — force-clear the best cold so warm does not stall at 0
        // while hot alone holds the tip.
        const needWarm = gov.needsWarmSlots();
        if (needWarm > 0) {
            let picks = gov.pickColdForWarm(
                Math.min(needWarm, maxConcurrent),
                now,
            );
            if (picks.length === 0) {
                const best = gov.pickBestColdIgnoringBackoff();
                if (best) {
                    gov.forceClearRetry(best.key);
                    logger.info(
                        `Warm force-clear retry ${best.key} ` +
                            `(failCount=${best.failCount} source=${best.source})`,
                    );
                    picks = [best];
                }
            }
            await Promise.allSettled(
                picks.map((rec) => connectWarm(rec, config, gov)),
            );
        }

        // 3) warm → hot
        const needHot = gov.needsHotSlots();
        if (needHot > 0) {
            const picks = gov.pickWarmForHot(needHot, now);
            for (const rec of picks) {
                await promoteToHot(rec, gov, connectTimeoutMs);
            }
        }

        // 4) silent hot→warm liveness demote (spec churn; keep bearer)
        // Do NOT markFail — that cold-drops and orphans the socket in clientsByKey.
        if (silentMs > 0) {
            for (const rec of gov.pickSilentHot(silentMs, now)) {
                const last =
                    rec.client?.lastRollForwardAt ??
                    rec.promotedAt ??
                    rec.addedAt;
                logger.info(
                    `Silent hot→warm ${rec.key} idleMs=${now - last}`,
                );
                demoteHotToWarm(rec, gov);
            }
        }

        // 5) demote excess hot (never last hot; pure pick already enforces)
        const demote = gov.pickHotForDemotion(gov.excessHot() || 0);
        if (demote.length === 0 && gov.counts().hot > gov.targets.targetHot) {
            const extra = gov.pickHotForDemotion(
                gov.counts().hot - gov.targets.targetHot,
            );
            for (const rec of extra) demoteHotToWarm(rec, gov);
        } else {
            for (const rec of demote) demoteHotToWarm(rec, gov);
        }

        // 6) if zero hot, emergency recover
        // Rehome orphan sockets first (warm with live bearer), then dial cold.
        if (gov.counts().hot === 0) {
            const rehomed = rehomeOrphanClients(gov);
            if (rehomed > 0) {
                logger.info(`Emergency rehomed ${rehomed} orphan client(s)`);
            }
            // Promote any warm bearer immediately (incl. rehomed).
            for (const rec of gov.pickWarmForHot(1, now)) {
                await promoteToHot(rec, gov, connectTimeoutMs);
            }
            if (gov.counts().hot === 0) {
                let emergency = gov.pickColdForWarm(1, now);
                if (emergency.length === 0) {
                    const best = gov.pickBestColdIgnoringBackoff();
                    if (best) {
                        gov.forceClearRetry(best.key);
                        logger.info(
                            `Emergency force-clear retry ${best.key} ` +
                                `(failCount=${best.failCount} source=${best.source})`,
                        );
                        emergency = [best];
                    }
                }
                for (const rec of emergency) {
                    const ok = await connectWarm(rec, config, gov);
                    if (ok) {
                        const warm = gov.get(rec.key);
                        if (warm) {
                            await promoteToHot(
                                warm,
                                gov,
                                connectTimeoutMs,
                            );
                        }
                    }
                }
                for (const rec of gov.pickWarmForHot(1, now)) {
                    await promoteToHot(rec, gov, connectTimeoutMs);
                }
            }
        }

        const snap = gov.snapshot();
        // Always publish peers for WS subscribers (fire-and-forget)
        emitPeers(snap as unknown as Record<string, unknown>);
        if (tickCount === 1 || tickCount % 4 === 0) {
            logger.info(
                `PeerGovernor snapshot ${JSON.stringify(snap)}`,
            );
        }
    } catch (err) {
        logger.error("PeerGovernor tick error:", err);
    } finally {
        gov.noteTickComplete(startedAt);
        tickRunning = false;
    }
}

/** Multi-peer sync state (primary, verifier agreement, range scheduler, workers). */
export function getSyncSnapshot(): SyncSnapshot | null {
    return consensus?.syncSnapshot() ?? null;
}

export function getGovernorSnapshot(): PeerGovernorSnapshot | null {
    return governor?.snapshot() ?? null;
}

/** Best producer tip slot from live ChainSync (MsgRollForward / FindIntersect tip). */
export function getBestPeerTipSlot(): string | null {
    let best = 0n;
    for (const c of clientsByKey.values()) {
        const n = c.peerSlotNumber;
        if (n == null || !Number.isFinite(n) || n <= 0) continue;
        const slot = BigInt(Math.trunc(n));
        if (slot > best) best = slot;
    }
    return best > 0n ? best.toString() : null;
}

export function getPeerGovernor(): PeerGovernor | undefined {
    return governor;
}

/**
 * Thin facade for HTTP / Mini-BF: tx submit + governor observability.
 * Does not expose full PeerClient map.
 */
/**
 * Peers we advertise to others over PeerSharing: connected hot/warm first, then
 * a sample of cold ones; IPv4 host:port keys only (IPv6 sharing not implemented).
 */
export function listShareablePeers(amount: number): Array<{ host: string; port: number }> {
    if (!governor) return [];
    const out: Array<{ host: string; port: number }> = [];
    const seen = new Set<string>();
    const push = (key: string) => {
        if (seen.has(key)) return;
        const i = key.lastIndexOf(":");
        if (i < 0) return;
        const host = key.slice(0, i);
        const port = Number(key.slice(i + 1));
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !Number.isInteger(port) || port <= 0) return;
        seen.add(key);
        out.push({ host, port });
    };
    for (const tier of ["hot", "warm", "cold"] as const) {
        for (const r of governor.listByTier(tier)) {
            if (out.length >= amount) return out;
            if (r.malicious && r.malicious.until > Date.now()) continue;
            push(r.key);
        }
    }
    return out;
}

export interface InboundN2NStatus {
    listening: boolean;
    host: string | null;
    port: number | null;
    clients: number;
}

let inboundStatusProvider: (() => InboundN2NStatus) | null = null;

/** Called by the entrypoint once the inbound N2N listener is up (or known to be off). */
export function setInboundN2NStatusProvider(fn: (() => InboundN2NStatus) | null): void {
    inboundStatusProvider = fn;
}

export function getInboundN2NStatus(): InboundN2NStatus {
    if (inboundStatusProvider) {
        try {
            return inboundStatusProvider();
        } catch {
            /* fall through */
        }
    }
    return { listening: false, host: null, port: null, clients: 0 };
}

export function createHttpPeerManager(): {
    submitTx: (args: { txCbor: Uint8Array }) => Promise<{ status: string; nTxs: number; availableSpace: number }>;
    getGovernorSnapshot: () => PeerGovernorSnapshot | null;
    getBestPeerTipSlot: () => string | null;
    getSyncSnapshot: () => SyncSnapshot | null;
    getInboundStatus: () => InboundN2NStatus;
} {
    return {
        async submitTx({ txCbor }: { txCbor: Uint8Array }) {
            const peer = getPeerAccessor().pickHotPeer();
            if (!peer) {
                throw new Error("No hot peer available for tx submit");
            }
            // The mempool is shared by every peer connection; any hot peer's client
            // appends to it, and every hot peer serves it on TxSubmission requests.
            const r = await peer.submitToSharedMempool(txCbor);
            return { status: String(r.status), nTxs: Number(r.nTxs), availableSpace: Number(r.aviableSpace) };
        },
        getGovernorSnapshot: () => getGovernorSnapshot(),
        getBestPeerTipSlot: () => getBestPeerTipSlot(),
        getSyncSnapshot: () => getSyncSnapshot(),
        getInboundStatus: () => getInboundN2NStatus(),
    };
}

export async function stopPeerManager(): Promise<void> {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = undefined;
    }
    // Applier first: the range being applied finishes its transaction before its
    // peers go away (their in-flight fetches would otherwise fail fast into the log).
    try {
        await consensus?.stop();
    } catch (err) {
        logger.error("Consensus stop error:", err);
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

    // Load once before any peers are constructed; all validators share this promise cache.
    shelleyGenesisConfig = await getShelleyGenesisConfig(config);
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
    await seedTopologyIntoGovernor(
        topology,
        governor,
        config.peerGovernor?.resolveDns !== false,
    );
    logger.info(
        `Node role: ${resolveNodeRole(config)} (peerSharing ${peerSharingAdvertised(config) ? "on" : "off"})`,
    );
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
            const peer = new PeerClient(
                host,
                port,
                config,
                shelleyGenesisConfig,
                (peerId, pKey) => {
                    unregisterClient(pKey, peerId);
                    const idx = hotList.findIndex((p) => p.peerKey === pKey);
                    if (idx >= 0) hotList.splice(idx, 1);
                },
            );
            await peer.handShakePeer();
            peer.startKeepAlive();
            wirePeerConsensus(peer);
            registerClient(peer);
            hotList.push(peer);
            consensus?.registerHotPeer(peer.peerKey);
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
