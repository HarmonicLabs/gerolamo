import { logger } from "../utils/logger";
import { ledgerBackfillRaw, ledgerStartupTipOverride, ledgerStoreMode, openNodeLedgerStore } from "../ledger/nodeLedgerStore";
import { epochForSlot, firstSlotOfEpoch } from "../utils/epochFromSlotCalculations";
import { blockStoreMode, catchUpFromSqlite, configureBlockStoreMode, configureRelayStore, noteSelectedTip, persistSelectedTipTo, resolveStartupTip, selectedTipPathFor, openNodeBlockStore, relayChainStoreOverride, setNodeBlockStore } from "../storage/nodeBlockStore";
import { latestSnapshotEpoch, listPoolRelays, poolStakeForEpoch } from "../db/leaderState";
import { getMaxSlot, getChainTip } from "../db";
import { sql } from "../sql";
import {
    dedupeRelays, LedgerPeerSource, loadLedgerRelaysFile, loadPeerSnapshotFile, poolRelaysFromStored,
    type LedgerPeerSnapshot, type LedgerPeersKind,
} from "./ledgerPeers";
import { dirname, join } from "node:path";
import { normalizeTopology, type NormalizedTopology } from "./topology";
import { accessPointLabel, ipFamily, ipv6FromWords, isValidDestination, parseHostPort, type RelayAccessPoint } from "./relayAccessPoint";
import { hostHasGlobalIpv6, resolveAccessPoint, type Rng } from "./dnsResolve";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import type { NetworkT } from "@harmoniclabs/cardano-ledger-ts";
import { PeerClient } from "./PeerClient";
import { classifyPeerNetError } from "./peerNetError";
import { GlobalSharedMempool } from "./SharedMempool";
import { getMempool } from "../mempool";
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
    type PeerSelectionCounters,
    type PeerSource,
    CARDANO_BIG_LEDGER_TARGETS,
    DEFAULT_PEER_GOVERNOR_TARGETS,
    INBOUND_MATURITY_MS,
    INBOUND_PEERS_RETRY_MS,
    MAX_INBOUND_PEERS,
    PEER_SHARE_MAX_IN_PROGRESS,
    PEER_SHARE_STICKY_MS,
    saltedHash,
} from "./PeerGovernor";
import type { PeerAddress } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { emitMempool, emitPeers } from "./liveEvents";
import {
    DEFAULT_VERIFIER_LAG_HOLD_MS,
    DEFAULT_VERIFIER_MAX_LAG_SLOTS,
    DEFAULT_VERIFIER_MIN_HOT_AGE_MS,
    pickLaggingVerifiers,
} from "./verifierRotation";
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
    /** Ledger relays (registered pools) added to the cold tier per governor tick when cold is short (default 32). */
    ledgerBatch?: number;
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
    /**
     * Big ledger peer targets (cardano-node targetNumberOfKnown/Established/ActiveBigLedgerPeers).
     * Default 15 / 10 / 5 for role "relay" (cardano-node's), 0 for "producer" and "data".
     */
    targetKnownBigLedger?: number;
    targetEstablishedBigLedger?: number;
    targetActiveBigLedger?: number;
    /**
     * Peer churn (cardano-node Churn.hs): every ~55 min (+0–10 min; 15 min + 0–1 min while far
     * behind) replace 20 % of the non-local-root hot, warm and cold peers. Default on for role
     * "relay", off for "producer" and "data". `true`/`false` or `{ enabled, intervalMs, bulkIntervalMs }`.
     */
    churn?: boolean | { enabled?: boolean; intervalMs?: number; bulkIntervalMs?: number };
    /**
     * Use IPv6 peers (AAAA records, IPv6 ledger relays, IPv6 addresses learned by peer sharing).
     * "auto" (default): when this host has a global IPv6 address. Literal IPv6 roots in
     * topology.json are always used.
     */
    ipv6?: boolean | "auto";
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

export interface ProducerConfig {
    coldVkeyFile: string;
    kesSkeyFile: string;
    vrfSkeyFile: string;
    opcertFile: string;
    /** Where the last forged slot is persisted (never two blocks in one slot across restarts). */
    stateFile?: string;
    /** Log leadership without forging (read-only check against cardano-cli). */
    dryRun?: boolean;
    /**
     * Temporary: the first block Gerolamo forges on a network carries a transaction from this
     * wallet with the metadata message "Gerolamo was here!" (CIP-20 label 674). Once per
     * network, remembered in `stateFile`.
     */
    greeting?: { paymentSkeyFile: string; paymentAddress: string };
    /** Protocol version written into forged headers (explorer badge); unset = the ledger's. */
    headerProtocolVersion?: { major: number; minor: number };
}

export interface GerolamoConfig {
    readonly network: NetworkT;
    readonly networkMagic: number;
    /** "data" (default, outbound only) or "relay" (also accepts inbound N2N). See nodeRole.ts. */
    readonly role?: NodeRole;
    /** Block producer keys (cardano-cli TextEnvelope files); present ⇒ the node forges when it leads. */
    readonly producer?: ProducerConfig;
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
    /** cardano-node-format block store directory (`immutable/`, `volatile/`); default `<dir of dbPath>/db`. `GEROLAMO_BLOCK_STORE=0` disables. */
    readonly blockStoreDir?: string;
    /** Which store the N2N chain-sync / block-fetch servers read: "sqlite" (default) or "chunks" (the block store). */
    readonly relayStore?: "sqlite" | "chunks";
    /** "mirror" (default) writes the block store beside SQLite; "primary" makes it the block store (no more `blocks` rows). */
    readonly blockStoreMode?: "mirror" | "primary";
    /** LMDB ledger store: "sqlite" (default), "dual" (write both, verify), "lmdb" (LMDB answers UTxO reads). docs/PLAN_LMDB_LEDGER.md */
    readonly ledgerStore?: "sqlite" | "dual" | "lmdb";
    readonly ledgerDir?: string;
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
    /**
     * Prometheus text exposition with cardano-node metric names on its own address (off when
     * unset). Env GEROLAMO_PROMETHEUS=host:port overrides, GEROLAMO_PROMETHEUS=0 disables. The JSON
     * /metrics on `port` is unaffected.
     */
    readonly prometheus?: { host?: string; port: number; noSuffix?: boolean; enabled?: boolean };
    /** cardano-node's legacy spelling of `prometheus`: `["127.0.0.1", 12798]`. */
    readonly hasPrometheus?: [string, number];
    /**
     * Chain selection and consensus mode (consensus/chainsel/ChainSelDriver.ts). `chainSelection`:
     * "legacy" (default: primary + verifier votes) or "praos" (ouroboros-consensus candidate
     * fragments); `mode`: "praos" (default) or "genesis" (GSM + LoE + GDD; implies chainSelection praos).
     * Env overrides: GEROLAMO_CHAIN_SELECTION, GEROLAMO_CONSENSUS_MODE.
     */
    readonly consensus?: import("../consensus/chainsel/ChainSelDriver").ConsensusConfigLike["consensus"];
    /** A cardano-node config.json whose `Test*HardForkAtEpoch` overrides the hard-fork history uses (consensus/hfc). */
    readonly cardanoNodeConfigFile?: string;
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
        /**
         * A hot verifier whose tip trails the primary's by more than this many slots is
         * swapped for a warm peer (which starts at our tip). Default 200000; 0 disables.
         */
        readonly verifierMaxLagSlots?: number;
        /** How long a rotated-out verifier waits warm before it may go hot again. Default 10 min. */
        readonly verifierLagHoldMs?: number;
    };
    allPeers: Map<string, PeerClient>;
}

let topology: NormalizedTopology;
let shelleyGenesisConfig: ShelleyGenesisConfig;
/** Live clients keyed by stable peerKey (host:port). */
const clientsByKey = new Map<string, PeerClient>();
/** Also index by peerId for consensus lookups that still pass peerId. */
const clientsById = new Map<string, PeerClient>();
let governor: PeerGovernor | undefined;
let monitorInterval: ReturnType<typeof setInterval> | undefined;
let consensus: ConsensusOrchestrator | undefined;

/** The running consensus orchestrator (after initPeerManager), for the block producer. */
export function getConsensus(): ConsensusOrchestrator | undefined {
    return consensus;
}
let activeConfig: GerolamoConfig | undefined;
let tickCount = 0;
/** In-flight connects so we don't double-promote the same cold peer. */
const connecting = new Set<string>();
/** Connections the governor itself closes (churn, excess big ledger peers): no failure is recorded. */
const intentionalClose = new Set<string>();
let churnState: { enabled: boolean; intervalMs: number; bulkIntervalMs: number; nextAt: number } = { enabled: false, intervalMs: 3_300_000, bulkIntervalMs: 900_000, nextAt: Infinity };
/** Light peer sharing: next time mature inbound peers may be picked (inboundPeersRetryTime). */
let inboundPeersRetryAt = 0;
/** Peer-sharing response salt and when it is re-drawn (ps_POLICY_PEER_SHARE_STICKY_TIME). */
let shareSalt = { salt: (Math.random() * 0xffffffff) >>> 0, until: 0 };
let tickRunning = false;

const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_CONCURRENT_WARM = 2;
const DEFAULT_HOT_SILENT_MS = 180_000;

function govEnabled(config: GerolamoConfig): boolean {
    return config.peerGovernor?.enabled !== false;
}

export function targetsFromConfig(config: Pick<GerolamoConfig, "peerGovernor" | "role" | "n2n">): Partial<PeerGovernorTargets> {
    const g = config.peerGovernor ?? {};
    // Only pass keys the config actually sets: `{...DEFAULTS, ...{targetHot: undefined}}`
    // would erase the default and leave the governor with NaN targets (mainnet
    // config had no peerGovernor block → 1 hot peer forever).
    const out: Partial<PeerGovernorTargets> = {};
    // Big ledger peers: cardano-node's targets for a relay; a producer / data node keeps none
    // unless configured (a producer's peer set is its operator's business).
    if (resolveNodeRole(config) === "relay") Object.assign(out, CARDANO_BIG_LEDGER_TARGETS);
    for (const k of ["targetHot", "targetWarm", "targetCold", "maxHot", "maxWarm", "maxCold", "targetKnownBigLedger", "targetEstablishedBigLedger", "targetActiveBigLedger"] as const) {
        const v = g[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(0, v);
    }
    return out;
}

/** Churn settings for this node (role default: on for relays). */
export function churnConfig(config: Pick<GerolamoConfig, "peerGovernor" | "role" | "n2n">): { enabled: boolean; intervalMs: number; bulkIntervalMs: number } {
    const c = config.peerGovernor?.churn;
    const enabled = typeof c === "boolean" ? c : typeof c === "object" && c && typeof c.enabled === "boolean" ? c.enabled : resolveNodeRole(config) === "relay";
    const o = typeof c === "object" && c ? c : {};
    return {
        enabled,
        intervalMs: Number.isFinite(o.intervalMs) && o.intervalMs! > 0 ? o.intervalMs! : 3_300_000, // defaultDeadlineChurnInterval
        bulkIntervalMs: Number.isFinite(o.bulkIntervalMs) && o.bulkIntervalMs! > 0 ? o.bulkIntervalMs! : 900_000, // defaultBulkChurnInterval
    };
}

function ipv6Wanted(config: GerolamoConfig): boolean {
    const v = config.peerGovernor?.ipv6;
    return v === true || (v !== false && hostHasGlobalIpv6());
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
    peer.onAwaitReply = (peerId) => orch.handleAwaitReply(peerId); // Genesis: ChainSync Jumping disengages idle peers
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
    // IPv6: four network-socket HostAddress6 words (the address big-endian)
    if (Array.isArray(addr)) {
        const host = ipv6FromWords(addr);
        return host ? { host, port } : null;
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

/**
 * Addresses behind a topology / ledger access point. A domain becomes one peer per address
 * (bootstrap and public roots are round-robin names over several relays, and cardano-node treats
 * each address as its own peer); when resolution fails the hostname is kept, so the dialer can
 * still try it. SRV names resolve to the drawn target's addresses (nothing on failure).
 */
async function expandRelay(ap: RelayAccessPoint, resolveDns: boolean, ipv6: boolean): Promise<Array<{ host: string; port: number }>> {
    if (ap.kind === "address") return [{ host: ap.host, port: ap.port }];
    if (!resolveDns) return ap.kind === "domain" ? [{ host: ap.host, port: ap.port }] : [];
    const addrs = await resolveAccessPoint(ap, { ipv6 }).catch(() => [] as Array<{ host: string; port: number }>);
    if (addrs.length === 0 && ap.kind === "domain") return [{ host: ap.host, port: ap.port }];
    return addrs;
}

async function seedTopologyIntoGovernor(
    topo: NormalizedTopology,
    gov: PeerGovernor,
    resolveDns = true,
    ipv6 = false,
): Promise<void> {
    for (const ap of topo.bootstrapPeers ?? []) {
        const addrs = await expandRelay(ap, resolveDns, ipv6);
        for (const a of addrs) gov.noteKnown(a.host, a.port, "bootstrap", false, undefined, { advertise: false });
        if (addrs.length > 1) logger.info(`Bootstrap ${accessPointLabel(ap)} → ${addrs.length} addresses`);
    }
    // Local roots: each group with its hot / warm valency (cardano-node LocalRootPeersGroup)
    for (let i = 0; i < topo.localRoots.length; i++) {
        const root = topo.localRoots[i]!;
        const groupId = `lr_${i}`;
        gov.registerLocalRootGroup(groupId, root.hotValency, root.warmValency);
        if (root.behindFirewall) {
            // Provenance Inbound: the peer dials us; the governor never connects to it.
            logger.info(`Local root group ${groupId}: behindFirewall, waiting for ${root.accessPoints.map(accessPointLabel).join(", ")} to connect in`);
            continue;
        }
        for (const ap of root.accessPoints) {
            for (const a of await expandRelay(ap, resolveDns, ipv6)) {
                gov.noteKnown(a.host, a.port, "localRoot", root.trustable, groupId, { advertise: root.advertise });
            }
        }
    }
    for (const root of topo.publicRoots) {
        for (const ap of root.accessPoints) {
            for (const a of await expandRelay(ap, resolveDns, ipv6)) {
                gov.noteKnown(a.host, a.port, "publicRoot", false, undefined, { advertise: root.advertise });
            }
        }
    }
}

let ledgerPeerConfig: { topology: NormalizedTopology; resolveDns: boolean; ipv6: boolean; file: string } | null = null;
let ledgerSource: LedgerPeerSource | null = null;
let peerSnapshotCache: { path: string; snap: LedgerPeerSnapshot | null } | null = null;
let ledgerSeededTotal = 0;
let bigLedgerSeededTotal = 0;
/** One PRNG for peer selection (stake-weighted picks, churn, coin flips); swapped in simulations. */
let selectionRng: Rng = Math.random;

/** Stake-weighted pools with their relays from the ledger (pool_relays + ledger-relays.json + the stake distribution). */
async function ledgerPoolsNow(file: string) {
    const fromTable = await listPoolRelays(sql).catch(() => [] as Array<{ pool: string; host: string; port: number; srv?: boolean }>);
    const fromFile = await loadLedgerRelaysFile(file);
    const relays = dedupeRelays([...fromTable, ...fromFile]);
    if (relays.length === 0) return null;
    let stake: Map<string, bigint> | null = null;
    try {
        const tip = BigInt(await getMaxSlot());
        const d = (await poolStakeForEpoch(Number(epochForSlot(tip)))) ?? await (async () => { const e = await latestSnapshotEpoch(); return e == null ? null : poolStakeForEpoch(e + 1); })();
        stake = d?.stake ?? null;
    } catch { stake = null; }
    if (!stake || stake.size === 0) logger.warn(`Ledger peers: no stake distribution available; weighting ${relays.length} relay(s) equally`);
    const pools = poolRelaysFromStored(relays, stake);
    logger.info(`Ledger peers: ${pools.length} pool(s) with relays (${fromTable.length} relay rows from certificates, ${fromFile.length} from ${file})${stake ? `, stake of ${stake.size} pool(s)` : ""}`);
    return pools;
}

function makeLedgerSource(lp: NonNullable<typeof ledgerPeerConfig>): LedgerPeerSource {
    return new LedgerPeerSource({
        useLedgerAfterSlot: lp.topology.useLedgerAfterSlot,
        ledgerSlot: async () => Number(await getMaxSlot()),
        ledgerPools: () => ledgerPoolsNow(lp.file),
        snapshot: async () => {
            const path = lp.topology.peerSnapshotFile;
            if (!path) return null;
            if (peerSnapshotCache?.path !== path) {
                const snap = await loadPeerSnapshotFile(path);
                peerSnapshotCache = { path, snap };
                if (snap) logger.info(`Big ledger peer snapshot ${path}: ${snap.big.length} pool(s) at slot ${snap.slot ?? "origin"}`);
                else logger.warn(`Big ledger peer snapshot ${path} could not be read`);
            }
            return peerSnapshotCache.snap;
        },
        rng: () => selectionRng(),
    });
}

/**
 * Resolve picked ledger relays and add them to the known set. A domain contributes one random
 * address (ledgerPeersThread `pickDomainAddrs`), an SRV name its drawn target's address.
 */
async function addLedgerPicks(gov: PeerGovernor, picks: Array<{ ap: RelayAccessPoint }>, source: "ledger" | "bigLedger", lp: NonNullable<typeof ledgerPeerConfig>): Promise<number> {
    let added = 0;
    await Promise.all(picks.map(async ({ ap }) => {
        let addrs = await expandRelay(ap, lp.resolveDns, lp.ipv6);
        addrs = addrs.filter((a) => isValidDestination(a.host) && (lp.ipv6 || ipFamily(a.host) !== 6));
        if (ap.kind !== "address" && addrs.length > 1) addrs = [addrs[Math.floor(selectionRng() * addrs.length)]!];
        for (const a of addrs) {
            if (gov.get(peerKey(a.host, a.port))) continue;
            gov.noteKnown(a.host, a.port, source, false);
            added++;
        }
    }));
    return added;
}

/**
 * Ledger peers into the cold tier: stake-weighted picks for the regular deficit, and big ledger
 * peers for their own known target. Honours topology useLedgerAfterSlot / peerSnapshotFile.
 */
async function seedLedgerPeers(gov: PeerGovernor, config: GerolamoConfig): Promise<number> {
    const lp = ledgerPeerConfig;
    if (!lp || !ledgerSource?.enabled) return 0;
    try {
        let added = 0;
        const regular = Math.min(Number(config.peerGovernor?.ledgerBatch ?? 32), Math.max(0, gov.targets.targetCold - gov.regularCounts().cold));
        if (regular > 0) {
            const n = await addLedgerPicks(gov, await ledgerSource.request(regular, "all"), "ledger", lp);
            ledgerSeededTotal += n;
            added += n;
            if (n) logger.info(`Ledger peers: +${n} cold (stake-weighted from ${ledgerSource.stats().source}, ${ledgerSeededTotal} since start)`);
        }
        const big = gov.needsBigLedgerKnown();
        if (big > 0) {
            const n = await addLedgerPicks(gov, await ledgerSource.request(big, "big"), "bigLedger", lp);
            bigLedgerSeededTotal += n;
            added += n;
            if (n) logger.info(`Big ledger peers: +${n} cold (${ledgerSource.stats().bigPools} big pool(s) from ${ledgerSource.stats().source}, ${bigLedgerSeededTotal} since start)`);
        }
        return added;
    } catch (err) {
        logger.warn("Ledger peers: seeding failed:", err);
        return 0;
    }
}

/** Ledger peer source state (for /metrics-style reporting and tests). */
export function getLedgerPeerStats(): ReturnType<LedgerPeerSource["stats"]> | null {
    return ledgerSource?.stats() ?? null;
}

/** Deterministic selection for offline simulations / tests. */
export function setPeerSelectionRng(rng: Rng): void {
    selectionRng = rng;
}

/** Test hook: request picks of a kind from the running ledger source. */
export async function requestLedgerPeers(n: number, kind: LedgerPeersKind) {
    return ledgerSource ? ledgerSource.request(n, kind) : [];
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
                if (intentionalClose.delete(pKey)) {
                    // churn / excess close: not the peer's fault, no failure recorded
                    gov.detachClient(pKey);
                    return;
                }
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
        peer.source = rec.source;
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
function demoteHotToWarm(rec: PeerRecord, gov: PeerGovernor, opts: { allowPrimary?: boolean } = {}): void {
    // Never demote the chain driver for excess: the newest hot peer is demoted first, and a
    // verifier just promoted to primary for throughput is exactly that peer. A *silent* primary
    // is different (bug 99): it has served nothing for `silentMs`, and demoting it lets
    // unregisterHotPeer promote a successor — otherwise the node sits on a dead primary for
    // ever (preview 2026-09-09: the local block store stopped at the certified tip and the
    // node logged "Silent hot→warm 127.0.0.1:3101" every tick without moving).
    if (rec.key === consensus?.primaryPeerKey() && !opts.allowPrimary) return;
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

/**
 * Light peer sharing (KnownPeers.belowTarget): below the known target, pick mature duplex inbound
 * peers when the coin flip says so (or nobody can be asked); otherwise send peer-share requests
 * to at most 2 connected peers whose activation delay / retry time passed, asking each for
 * min 255 (max 8 (deficit ÷ requests)) addresses, then keep a salted random subset of the new,
 * non-big-ledger ones up to the deficit.
 */
async function runPeerSharing(
    gov: PeerGovernor,
    _shareBatch: number,
    ipv6: boolean,
    now = Date.now(),
): Promise<void> {
    if (!gov.needsColdPeers()) return;
    const deficit = Math.max(0, gov.targets.targetCold - gov.regularCounts().cold);
    // Only peers that agreed to PeerSharing in the handshake may be asked.
    const donors = gov.pickPeerShareDonors(PEER_SHARE_MAX_IN_PROGRESS, now, (r) => !!clientsByKey.get(r.key)?.peerSharingNegotiated);
    const useInbound = selectionRng() < 0.5;
    if (now >= inboundPeersRetryAt && (useInbound || donors.length === 0)) {
        const mature = matureInboundPeers(now).filter((a) => !gov.get(peerKey(a.host, a.port)) && (ipv6 || ipFamily(a.host) !== 6));
        if (mature.length > 0) {
            inboundPeersRetryAt = now + INBOUND_PEERS_RETRY_MS;
            const take = mature.map((a) => ({ a, r: selectionRng() })).sort((x, y) => x.r - y.r).slice(0, Math.min(MAX_INBOUND_PEERS, deficit)).map((x) => x.a);
            // inbound peers are advertised and count as successfully connected (they are connected)
            for (const a of take) gov.noteKnown(a.host, a.port, "inbound", false, undefined, { advertise: true, everConnected: true });
            logger.info(`PeerSharing: +${take.length} cold from mature inbound duplex peers (${mature.length} candidate(s))`);
            return;
        }
    }
    if (donors.length === 0) {
        logger.debug("PeerSharing: no connected peer available for a request; skipping");
        return;
    }
    const amount = Math.min(255, Math.max(8, Math.floor(deficit / donors.length)));
    const salt = (selectionRng() * 0xffffffff) >>> 0;
    const results = await Promise.all(donors.map(async (rec) => {
        const client = clientsByKey.get(rec.key);
        gov.notePeerShareRequested(rec.key, now);
        if (!client) return [] as Array<{ host: string; port: number }>;
        try {
            const peers = await withTimeout(client.askForPeers(amount), 10_000, `askForPeers ${rec.key}`); // policyPeerShareOverallTimeout
            return peers.map(peerAddressToHostPort).filter((x): x is { host: string; port: number } => !!x);
        } catch (err) {
            logger.debug(`PeerSharing failed on ${rec.key}:`, err);
            return [];
        }
    }));
    const fresh = new Map<string, { host: string; port: number }>();
    for (const hp of results.flat()) {
        const k = peerKey(hp.host, hp.port);
        if (gov.get(k) || fresh.has(k) || !isValidDestination(hp.host)) continue; // known (big ledger peers included) are dropped
        if (!ipv6 && ipFamily(hp.host) === 6) continue;
        fresh.set(k, hp);
    }
    const chosen = [...fresh].sort((a, b) => saltedHash(salt, a[0]) - saltedHash(salt, b[0])).slice(0, deficit);
    for (const [, hp] of chosen) gov.noteKnown(hp.host, hp.port, "shared", false);
    if (chosen.length > 0) logger.info(`PeerSharing via ${donors.map((d) => d.key).join(", ")}: +${chosen.length} cold (asked ${amount} each, ${results.flat().length} received)`);
}

/** Inbound peers connected to us in duplex mode for at least INBOUND_MATURITY_MS (inbound governor "matured" peers). */
function matureInboundPeers(now = Date.now()): Array<{ host: string; port: number }> {
    const out: Array<{ host: string; port: number }> = [];
    for (const c of getInboundN2NStatus().clientList ?? []) {
        const info = c as { peer: string; since: number; duplex?: boolean | null; transport?: string };
        if (info.duplex !== true || info.transport === "ws" || now - info.since < INBOUND_MATURITY_MS) continue;
        const hp = parseHostPort(info.peer);
        if (hp) out.push(hp);
    }
    return out;
}

/** Close a warm connection on purpose (churn / excess): the peer goes cold without a failure. */
function closeWarm(rec: PeerRecord, gov: PeerGovernor, reason: string): void {
    const client = clientsByKey.get(rec.key);
    if (!client) { gov.detachClient(rec.key); return; }
    intentionalClose.add(rec.key);
    try { client.terminate(reason); } catch { /* */ }
    unregisterClient(rec.key, client.peerId);
    gov.detachClient(rec.key);
    setTimeout(() => intentionalClose.delete(rec.key), 30_000).unref?.();
}

/**
 * One churn round (cardano-node Churn.hs churnLoop, big ledger peers first, then the rest):
 * demote ~20 % of the hot peers to warm, close ~20 % of the established ones, forget ~20 % of the
 * forgettable cold ones; the next ticks promote replacements. Local roots and the chain-sync
 * primary are never churned.
 */
function runChurn(gov: PeerGovernor, tickMs: number, now = Date.now()): void {
    const primary = consensus?.primaryPeerKey();
    const exclude = new Set<string>(primary ? [primary] : []);
    const summary: string[] = [];
    for (const bigLedger of [true, false]) {
        const hot = gov.pickChurnHot(bigLedger, () => selectionRng(), exclude);
        for (const rec of hot) { demoteHotToWarm(rec, gov); rec.churnHoldUntil = now + 2 * tickMs; }
        const warm = gov.pickChurnWarm(bigLedger, () => selectionRng()).filter((r) => !hot.includes(r));
        for (const rec of warm) { closeWarm(rec, gov, "churn"); rec.churnHoldUntil = now + 5 * 60_000; }
        let forgotten = 0;
        for (const rec of gov.pickChurnCold(bigLedger, () => selectionRng())) if (!warm.includes(rec) && gov.forget(rec.key)) forgotten++;
        if (hot.length || warm.length || forgotten) summary.push(`${bigLedger ? "big ledger" : "regular"}: ${hot.length} hot→warm, ${warm.length} warm→cold, ${forgotten} forgotten`);
    }
    logger.info(`Peer churn: ${summary.join("; ") || "nothing to churn"}`);
}

async function churnDue(now: number): Promise<boolean> {
    if (!churnState.enabled || now < churnState.nextAt) return false;
    // Deadline mode (caught up): 3300 s + 0–600 s; bulk sync (far behind the best peer): 900 s + 0–60 s.
    let behind = false;
    try {
        const best = BigInt(getBestPeerTipSlot() ?? "0");
        behind = best > 0n && best - BigInt(await getMaxSlot()) > 2160n;
    } catch { behind = false; }
    const base = behind ? churnState.bulkIntervalMs : churnState.intervalMs;
    churnState.nextAt = now + base + (behind ? 60_000 : 600_000) * selectionRng();
    return true;
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

        // 1) Grow cold via PeerSharing. Asking is independent of advertising: the handshake
        // flag says whether WE answer share requests (only a node reachable at its connecting
        // address may), while a request goes to any peer that advertised willingness. A
        // producer that never asks knows only its topology roots (10 peers on preview,
        // 2026-09-12), and every extra outbound duplex connection to a different relay is
        // another chance of being adopted as that relay's warm / hot peer.
        if (gcfg.peerSharing !== false && (tickCount === 1 || tickCount % shareEvery === 0)) {
            await runPeerSharing(gov, shareBatch, ledgerPeerConfig?.ipv6 ?? false, now);
        }

        // 1b) Ledger peers (registered relays, stake-weighted) whenever cold is short, and big
        // ledger peers below their known target: the main source for a node that does not
        // advertise itself, as in cardano-node.
        if ((gov.needsColdPeers() || gov.needsBigLedgerKnown() > 0) && (tickCount === 1 || tickCount % shareEvery === 0)) {
            await seedLedgerPeers(gov, config);
        }

        // 1c) Churn round when due (relay role by default).
        if (await churnDue(now)) runChurn(gov, config.peerGovernor?.tickMs ?? 15_000, now);

        // 2a) Local-root groups below their warm valency connect regardless of the regular target.
        const lrCold = gov.pickLocalRootColdForWarm(now).slice(0, maxConcurrent);
        if (lrCold.length) await Promise.allSettled(lrCold.map((rec) => connectWarm(rec, config, gov)));

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

        // 2b) big ledger peers: cold → warm up to their established target
        const needBlWarm = gov.needsBigLedgerEstablished();
        if (needBlWarm > 0) {
            const picks = gov.pickColdForWarm(Math.min(needBlWarm, maxConcurrent), now, true);
            if (picks.length) await Promise.allSettled(picks.map((rec) => connectWarm(rec, config, gov)));
        }

        // 3a) local-root groups below their hot valency
        for (const rec of gov.pickLocalRootWarmForHot(now)) await promoteToHot(rec, gov, connectTimeoutMs);

        // 3) warm → hot
        const needHot = gov.needsHotSlots();
        if (needHot > 0) {
            const picks = gov.pickWarmForHot(needHot, now);
            for (const rec of picks) {
                await promoteToHot(rec, gov, connectTimeoutMs);
            }
        }

        // 3b) big ledger peers: warm → hot up to their active target
        const needBlHot = gov.needsBigLedgerHot();
        if (needBlHot > 0) {
            for (const rec of gov.pickWarmForHot(needBlHot, now, true)) await promoteToHot(rec, gov, connectTimeoutMs);
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
                demoteHotToWarm(rec, gov, { allowPrimary: true });
            }
        }

        // 4b) rotate verifiers that fell too far behind the primary: they no longer
        // compare anything near the tip. Only when a warm peer is ready to take the
        // slot, so the hot count never dips; the leaver waits warm for a while.
        const maxLag = BigInt(Math.max(0, Math.trunc(config.sync?.verifierMaxLagSlots ?? Number(DEFAULT_VERIFIER_MAX_LAG_SLOTS))));
        if (maxLag > 0n && consensus) {
            const snap = consensus.syncSnapshot();
            const byKey = new Map(snap.peers.map((a) => [a.key, a] as const));
            const lagging = pickLaggingVerifiers(
                gov.listByTier("hot").map((rec) => ({
                    key: rec.key,
                    role: byKey.get(rec.key)?.role ?? null,
                    lagSlots: byKey.get(rec.key)?.lagSlots ?? null,
                    promotedAt: rec.promotedAt ?? null,
                })),
                { maxLagSlots: maxLag, minHotAgeMs: DEFAULT_VERIFIER_MIN_HOT_AGE_MS, now },
            );
            for (const lag of lagging) {
                const rec = gov.get(lag.key);
                const [replacement] = gov.pickWarmForHot(1, now);
                if (!rec || !replacement) break;
                logger.info(
                    `Lagging verifier hot→warm ${rec.key} (${lag.lagSlots} slots behind the primary, limit ${maxLag}); promoting ${replacement.key}`,
                );
                demoteHotToWarm(rec, gov);
                rec.nextRetryAt = now + (config.sync?.verifierLagHoldMs ?? DEFAULT_VERIFIER_LAG_HOLD_MS);
                await promoteToHot(replacement, gov, connectTimeoutMs);
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
        // 5b) big ledger peers above their targets (e.g. after a targets change): hot → warm, then close
        for (const rec of gov.pickBigLedgerHotForDemotion(gov.excessBigLedgerHot())) demoteHotToWarm(rec, gov);
        const blExcess = gov.excessBigLedgerEstablished();
        if (blExcess > 0) {
            for (const rec of gov.listByTier("warm").filter((r) => r.bigLedger).slice(0, blExcess)) closeWarm(rec, gov, "big ledger peers above target");
        }

        // 6) if zero hot, emergency recover
        // Rehome orphan sockets first (warm with live bearer), then dial cold.
        if (gov.counts().hot === 0) {
            const rehomed = rehomeOrphanClients(gov);
            if (rehomed > 0) {
                logger.info(`Emergency rehomed ${rehomed} orphan client(s)`);
            }
            // Promote any warm bearer immediately (incl. rehomed, big ledger peers too).
            for (const rec of gov.pickWarmForHot(1, now, "any")) {
                await promoteToHot(rec, gov, connectTimeoutMs);
            }
            if (gov.counts().hot === 0) {
                let emergency = gov.pickColdForWarm(1, now, "any");
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
                for (const rec of gov.pickWarmForHot(1, now, "any")) {
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
 * Peers we advertise to others over PeerSharing (cardano-node computePeerSharingPeers): known
 * peers with advertise, a successful connection and no failures, in an order salted for 823 s,
 * at most min(10, amount). IPv4 and IPv6.
 */
export function listShareablePeers(amount: number): Array<{ host: string; port: number }> {
    if (!governor) return [];
    const now = Date.now();
    if (now >= shareSalt.until) shareSalt = { salt: (selectionRng() * 0xffffffff) >>> 0, until: now + PEER_SHARE_STICKY_MS };
    return governor.shareablePeers(amount, shareSalt.salt, now);
}

/** cardano-node peer selection counters (Prometheus peerSelection_*). */
export function getPeerSelectionCounters(): (PeerSelectionCounters & { ColdPeersPromotions: number }) | null {
    return governor ? { ...governor.selectionCounters(), ColdPeersPromotions: connecting.size } : null;
}

/** Outbound connection counts for the connectionManager_* metrics. */
export function getOutboundConnectionStats(): { outbound: number; duplex: number } {
    let outbound = 0, duplex = 0;
    for (const c of clientsByKey.values()) {
        outbound++;
        if ((c as { duplexServing?: boolean }).duplexServing) duplex++;
    }
    return { outbound, duplex };
}

export interface InboundN2NStatus {
    listening: boolean;
    host: string | null;
    port: number | null;
    clients: number;
    /** Outbound peers pulling our chain over duplex (they can carry our forged blocks). */
    duplexPullers?: string[];
    /** Connected inbound peers with what they have pulled. */
    clientList?: Array<{ peer: string; transport?: "tcp" | "ws"; since: number; version: number | null; handshakeOk: boolean; chainSyncSlot: number | null; protocols: string[] }>;
    /** Self-probe of the public relay address (config n2n.publicAddress): null = not configured / not probed yet. */
    publicReachable?: { address: string; ok: boolean; checkedAt: number; error: string | null } | null;
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
            // Validating mempool: the ledger rules decide, and hot peers pull the tx from it.
            const vm = getMempool();
            if (vm) {
                const r = await vm.addTx(txCbor, "http");
                emitMempool();
                const m = vm.measures();
                return { status: r.ok ? "success" : `rejected: ${r.reasons.slice(0, 3).join("; ")}`, nTxs: m.txCount, availableSpace: Math.max(0, m.bytes.capacity - m.bytes.size) };
            }
            const peer = getPeerAccessor().pickHotPeer();
            if (!peer) {
                throw new Error("No hot peer available for tx submit");
            }
            // The mempool is shared by every peer connection; any hot peer's client
            // appends to it, and every hot peer serves it on TxSubmission requests.
            const r = await peer.submitToSharedMempool(txCbor);
            emitMempool();
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

/** Read and normalise topology.json (cardano-node semantics); warnings go to the log. */
async function readTopology(path: string): Promise<NormalizedTopology> {
    let parsed: { topology: NormalizedTopology; warnings: string[] };
    try {
        parsed = normalizeTopology(await Bun.file(path).json(), path);
    } catch (err) {
        throw new Error(`invalid topology file at ${path}: ${(err as Error)?.message ?? err}`);
    }
    for (const w of parsed.warnings) logger.warn(`topology ${path}: ${w}`);
    const t = parsed.topology;
    logger.info(`Topology ${path}: ${t.localRoots.length} local root group(s), ${t.publicRoots.reduce((n, r) => n + r.accessPoints.length, 0)} public root(s), ${t.bootstrapPeers?.length ?? 0} bootstrap peer(s), ledger peers ${t.useLedgerAfterSlot < 0 ? "off" : t.useLedgerAfterSlot === 0 ? "always" : `after slot ${t.useLedgerAfterSlot}`}${t.peerSnapshotFile ? `, peer snapshot ${t.peerSnapshotFile}` : ""}`);
    return t;
}

/**
 * SIGHUP (as cardano-node): re-read topology.json — new local / public / bootstrap roots join the
 * known set, local-root valencies and the ledger-peer settings (useLedgerAfterSlot,
 * peerSnapshotFile) take effect, the peer snapshot is re-read. Peers already known stay.
 */
export async function reloadTopology(): Promise<string> {
    const config = activeConfig;
    if (!config || !governor) return "topology: peer governor not running";
    const t = await readTopology(config.topologyFile);
    const before = governor.counts().total;
    const resolveDns = config.peerGovernor?.resolveDns !== false;
    const ipv6 = ipv6Wanted(config);
    await seedTopologyIntoGovernor(t, governor, resolveDns, ipv6);
    topology = t;
    ledgerPeerConfig = { topology: t, resolveDns, ipv6, file: join(dirname(config.topologyFile), "ledger-relays.json") };
    peerSnapshotCache = null;
    ledgerSource = makeLedgerSource(ledgerPeerConfig);
    return `topology reloaded: ${governor.counts().total - before} new peer(s), ledger peers ${t.useLedgerAfterSlot < 0 ? "off" : "on"}`;
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

    topology = await readTopology(config.topologyFile);

    // Load once before any peers are constructed; all validators share this promise cache.
    shelleyGenesisConfig = await getShelleyGenesisConfig(config);
    GlobalSharedMempool.getInstance();
    logger.mempool("Global SharedMempool initialized in PeerManager");

    consensus = new ConsensusOrchestrator(config, getPeerAccessor());
    config.allPeers = clientsById;
    logger.info("ConsensusOrchestrator ready (rollForward/rollBack → DB)");
    try {
        const k = Number((shelleyGenesisConfig as { securityParam?: number } | null)?.securityParam) || 2160;
        configureRelayStore(config.relayStore);
        configureBlockStoreMode(config.blockStoreMode);
        const store = await openNodeBlockStore(config, k);
        if (store) {
            await catchUpFromSqlite(store, k);
            consensus.attachBlockStore(store);
            setNodeBlockStore(store);
            persistSelectedTipTo(selectedTipPathFor(store.dir));
            if (blockStoreMode() === "primary") {
                const start = await resolveStartupTip(store, store.dir);
                const emptyStore = !start && store.chunks.chunks().length === 0 && store.volatile.size === 0;
                if (emptyStore && config.syncFromGenesis) {
                    // A fresh from-genesis node: no block yet, the chain starts at the origin (bug 304; the
                    // ledger store builds the genesis state below).
                    logger.info("Block store is PRIMARY and empty: syncing from genesis");
                } else if (!start) {
                    // Mirror mode only makes sense with a populated `blocks` table; on a fresh bootstrap it
                    // would sync from genesis onto the imported ledger (2026-09-14 18:08, halted at slot 320).
                    const legacyRows = (await sql`SELECT 1 FROM blocks LIMIT 1`.values().catch(() => [])) as unknown[][];
                    const legacy = legacyRows.length > 0; // the SQLite table itself, not the routed helper (which would answer from the store)
                    if (!legacy) throw new Error("Block store: primary mode requested but the ledger's applied tip is not in the store and SQLite holds no blocks; refusing to start (re-run mithril-bootstrap --block-store … --ledger-state)");
                    logger.error("Block store: primary mode requested but the ledger's applied tip could not be found in the store; running in mirror mode on the SQLite blocks table instead");
                    configureBlockStoreMode("mirror");
                } else {
                    noteSelectedTip(start.hash);
                    logger.info(`Block store is PRIMARY: selected tip slot ${start.slot} (${start.source}); the SQLite blocks table is no longer written`);
                }
            }
            if (blockStoreMode() !== "primary") {
                const tip = await getChainTip();
                if (tip) noteSelectedTip(Uint8Array.from(Buffer.from(tip.hashHex, "hex")));
            }
            if (relayChainStoreOverride()) logger.info("N2N chain-sync / block-fetch will serve from the chunk store (GEROLAMO_RELAY_STORE=chunks)");
        }
        // LMDB ledger store (phase 1: UTxO), seeded from SQLite at the selected tip when empty
        const tipNow = await getChainTip();
        const tipBytes = tipNow ? Uint8Array.from(Buffer.from(tipNow.hashHex, "hex")) : null;
        let chain: Array<{ slot: number; hash: Uint8Array }> | undefined;
        if (blockStoreMode() === "primary" && store && tipBytes) {
            chain = store.volatileChain(tipBytes).map((b) => ({ slot: b.slot, hash: b.hash }));
            const imm = await store.immutableTip(); // last resort after a crash: every volatile diff gone, the ledger at its anchor (bug 245)
            if (imm) chain.push({ slot: imm.slot, hash: imm.hash });
        }
        await openNodeLedgerStore(config, tipNow && tipBytes ? { slot: Number(tipNow.slot), hash: tipBytes } : null, chain);
        if (store && ledgerStoreMode() !== "sqlite") {
            const tipForScan = tipBytes;
            void ledgerBackfillRaw(store, tipForScan, Number(firstSlotOfEpoch(epochForSlot(BigInt((await getChainTip())?.slot ?? 0))))).catch((err) => logger.warn(`ledger raw backfill failed: ${(err as Error).message}`));
        }
        const back = ledgerStartupTipOverride();
        if (back && blockStoreMode() === "primary" && store) {
            noteSelectedTip(back.hash); // persisted by the block store's tip writer
            logger.warn(`Block store: selected tip moved back to slot ${back.slot} to match the ledger store after a crash; the network re-sends the blocks above it`);
        }
    } catch (err) {
        logger.warn(`Block store unavailable (SQLite stays primary): ${(err as Error).message}`);
    }

    if (!govEnabled(config)) {
        logger.warn(
            "peerGovernor.enabled=false — using legacy hot-first path",
        );
        await initLegacyHotFirst(config);
        return;
    }

    governor = new PeerGovernor(targetsFromConfig(config));
    { const g = governor; consensus?.setBigLedgerPeerSource({ bigLedgerPeers: () => g.bigLedgerKeys() }); } // Genesis mode (consensus/chainsel)
    const ipv6 = ipv6Wanted(config);
    await seedTopologyIntoGovernor(
        topology,
        governor,
        config.peerGovernor?.resolveDns !== false,
        ipv6,
    );
    ledgerPeerConfig = { topology, resolveDns: config.peerGovernor?.resolveDns !== false, ipv6, file: join(dirname(config.topologyFile), "ledger-relays.json") };
    ledgerSource = makeLedgerSource(ledgerPeerConfig);
    churnState = { ...churnConfig(config), nextAt: Date.now() + churnConfig(config).intervalMs };
    logger.info(`PeerGovernor: big ledger targets ${governor.targets.targetKnownBigLedger}/${governor.targets.targetEstablishedBigLedger}/${governor.targets.targetActiveBigLedger} (known/established/active), churn ${churnState.enabled ? "on" : "off"}, IPv6 peers ${ipv6 ? "on" : "off"}`);
    await seedLedgerPeers(governor, config);
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

    for (const ap of topology.bootstrapPeers ?? []) {
        if (ap.kind !== "srv") await addHot(ap.host, ap.port);
    }
    for (const root of topology.localRoots) {
        for (const ap of root.accessPoints) {
            if (ap.kind !== "srv") await addHot(ap.host, ap.port);
        }
    }

    monitorInterval = setInterval(async () => {
        if (hotList.length > 0) return;
        logger.warn("Legacy: no hot peers — replenishing topology");
        for (const ap of topology.bootstrapPeers ?? []) {
            if (ap.kind !== "srv") await addHot(ap.host, ap.port);
        }
    }, 30_000);

    void bootstrapList;
}

// Re-export defaults for tests/docs
export { DEFAULT_PEER_GOVERNOR_TARGETS, peerKey };
export type { PeerSource, PeerGovernorSnapshot };
