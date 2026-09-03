import { logger } from "../utils/logger";
import {
    blockFetchHeaderIdentity as headerIdentityOfBlock,
    blockParser,
    headerParser,
    type ParsedHeader,
} from "./blockHeaderParser";
import { validateBlock } from "./BlockBodyValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import {
    BlockFetchBlock,
    ChainPoint,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../tui";
import { calculatePreProdCardanoEpoch } from "../utils/epochFromSlotCalculations";
import { blockFrostFetchEra } from "../utils/blockFrostFetchEra";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { blake2b_256 } from "@harmoniclabs/crypto";
import type { GerolamoConfig } from "../network/peerManager";
import type {
    PeerClient,
    RollForwardBatchItem,
} from "../network/PeerClient";
import {
    applyTransaction,
    getBlockByHash,
    getBlockBySlot,
    getEpochNonce as dbGetEpochNonce,
    getEpochNonceState,
    getMaxSlot,
    getRecentBlockHeaders,
    getValidBlocksBefore,
    getValidHeadersBefore,
    insertBlockBatchVolatile,
    insertBlockVolatile,
    insertHeaderBatchVolatile,
    rollbackChainTo,
    storeEpochNonce,
    gcVolatile,
    countBlocksAfterSlot,
} from "../db";
import { applyBlock } from "./BlockApplication";
import { type ChainCandidate, evaluateChains } from "./chainSelection";
import {
    getHeaderSlot,
    getHeaderPrevHash,
    getHeaderPrevHashHex,
} from "../utils/eraAccessors";
import { getShelleyGenesisConfig } from "../utils/paths";
import { NonceEvolver } from "../utils/nonceEvolver";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import { emitTip } from "../network/liveEvents";
import { assertBlockRangeMatches } from "./blockRange";
import { splitEraBlock, verifyBlockBodyHash } from "./bodyHash";
import { ByronObftState } from "./byron/ByronOBFT";
import { getByronGenesisConfig } from "../utils/paths";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { CandidateSet, type PeerAgreement, type PeerRole } from "./CandidateSet";
import { RangeMismatch, RangeScheduler, SchedulerReset, type RangeSchedulerStats } from "./RangeScheduler";
import { ValidationPool, resolveWorkerCount } from "./workers/ValidationPool";
import { getEpochBodyParams, type EpochBodyParams } from "./epochParams";
import { ApplyProfile, type ProfileSnapshot } from "./applyProfile";
import { resolveValidationPolicy } from "./validationPolicy";

export interface PeerAccessor {
    getPeer(peerId: string): PeerClient | null;
    pickHotPeer(): PeerClient | null;
}

/** Point handed to the range scheduler (from a validated ChainSync header). */
interface RangePt {
    slot: bigint;
    hash: string;
}

/** A validated header waiting for its body. */
interface PendingHeader {
    item: RollForwardBatchItem;
    parsedHeader: ParsedHeader;
    /** Epoch η0 hex; empty for Byron. */
    nonce: string;
}

export type BodyValidationPolicy = "soft" | "strict";

/** A body that fails ledger rules in strict mode. Peers agreed on the block, so this is
 *  our ledger (or our rules), not the peer: never blame the connection for it. */
export class BodyValidationFailure extends Error {
    constructor(readonly slot: bigint, readonly hash: string, readonly detail: string) {
        super(`Block body validation failed at slot ${slot} hash=${hash} (strict; ${detail})`);
        this.name = "BodyValidationFailure";
    }
}

export interface SyncHalt {
    slot: string;
    hash: string;
    reason: string;
    since: number;
}

export interface SyncSnapshot {
    /** Set when strict validation stopped the applier; sync will not resume until the DB is repaired/resynced. */
    halted: SyncHalt | null;
    mode: "genesis" | "tip" | "point" | "resume";
    bodyValidation: BodyValidationPolicy;
    primary: string | null;
    quorum: number;
    peers: PeerAgreement[];
    scheduler: RangeSchedulerStats;
    validationWorkers: number;
    pendingHeaders: number;
    blocksApplied: number;
    blocksPerSec: number;
    /** Where wall time goes per block (ms), header stage + apply stage. */
    profile: ProfileSnapshot;
}

interface HeaderInsertData {
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
}

interface BlockInsertData {
    slot: bigint;
    blockHash: string;
    prevHash: string;
    headerData: Uint8Array;
    blockData: Uint8Array;
    block_fetch_RawCbor: Uint8Array;
}

interface RollbackPoint {
    blockHeader?: {
        slotNumber: bigint;
    };
}

export class ConsensusOrchestrator {
    readonly config: GerolamoConfig;
    readonly peers!: PeerAccessor;
    private batchBlockRecords: Map<string, BlockInsertData> = new Map();
    private batchHeaderRecords: Map<string, HeaderInsertData> = new Map();
    private volatileDbGcCounter = 0;
    /** Run volatile GC (invalid rows older than k) once per this many applied blocks. */
    private static readonly VOLATILE_GC_EVERY_BLOCKS = 2048;
    private epochNonceCache: Map<number, string> = new Map();
    /**
     * Hash of the last applied Byron block (hex). Byron has no VRF/KES, so
     * prevBlock chaining is the header-level integrity check we enforce.
     * null = unknown; re-seeded from the DB (or Byron genesis) on demand.
     */
    private lastByronTipHash: string | null = null;
    /** Byron OBFT state (signatures, delegation, k-window threshold). Lazy-init from byronGenesisFile. */
    private byronObft: ByronObftState | null = null;
    private byronObftInit: Promise<ByronObftState | null> | null = null;
    /**
     * Recently applied header hashes (hex). Several hot peers deliver the
     * same headers; a block must never be applied twice (fees would be
     * counted into the treasury again). LRU-bounded; DB is the fallback.
     */
    private readonly appliedRecently = new Set<string>();
    private readonly appliedRecentlyOrder: string[] = [];
    private static readonly APPLIED_LRU_SIZE = 8192;
    /** Per-peer candidate fragments + primary/verifier roles (multi-peer honesty). */
    readonly candidates = new CandidateSet({ depth: 2160 });
    /** Parallel BlockFetch across agreeing peers, ordered apply. */
    private scheduler: RangeScheduler<RangePt, BlockFetchBlock> | null = null;
    /** Validated primary headers awaiting bodies, by header hash (hex). */
    private readonly pendingHeaders = new Map<string, PendingHeader>();
    /** Last primary Byron header hash validated (not yet necessarily applied). */
    private lastPrimaryByronHeaderHash: string | null = null;
    /** CPU pool for KES/VRF header validation. */
    private pool: ValidationPool | null = null;
    private blocksApplied = 0;
    private readonly applyTimestamps: number[] = [];
    private readonly profile = new ApplyProfile();
    private halted: SyncHalt | null = null;
    /** Last header accepted from the primary (hash hex); null = re-anchor on the DB tip. */
    private lastAccepted: { slot: bigint; hash: string } | null = null;
    private static readonly PROFILE_LOG_EVERY = 256;
    /** Continuous UPDN+TICKN (phase 3). Lazy-init after genesis load. */
    private nonceEvolver: NonceEvolver | null = null;
    private nonceEvolverInit: Promise<void> | null = null;
    /**
     * Serialize rollForward apply/DB writes on the shared SQLite connection.
     * PeerClient fires onRollForward without awaiting; concurrent handlers race
     * sql.begin() → SQLITE "cannot start a transaction within a transaction".
     */
    private rollForwardChain: Promise<void> = Promise.resolve();

    constructor(
        config: GerolamoConfig,
        peers: PeerAccessor,
    ) {
        this.config = config;
        this.peers = peers;
        this.pool = new ValidationPool(resolveWorkerCount(config.validation?.workers));
        // setInterval(() => {
        // 	if (Date.now() - this.lastActivity > 300000) { // 5 minutes
        // 		logger.warn("Sync stalled, no rollForward for 5 minutes");
        // 		if (this.stalledCallback) this.stalledCallback();
        // 	}
        // }, 60000); // check every minute
    }

    private async ensureNonceEvolver(): Promise<NonceEvolver | null> {
        if (this.nonceEvolver) return this.nonceEvolver;
        if (!this.nonceEvolverInit) {
            this.nonceEvolverInit = (async () => {
                try {
                    const genesis = (await getShelleyGenesisConfig(
                        this.config,
                    )) as ShelleyGenesisConfig;
                    this.nonceEvolver = new NonceEvolver(genesis);
                    logger.debug(
                        `NonceEvolver ready (stabilityWindow=${this.nonceEvolver.getStabilityWindow()})`,
                    );
                } catch (err: unknown) {
                    logger.warn("NonceEvolver init failed:", err);
                    this.nonceEvolver = null;
                }
            })();
        }
        await this.nonceEvolverInit;
        return this.nonceEvolver;
    }

    /**
     * Bootstrap continuous ηv/ηc when inactive.
     * Prefer DB evolving/candidate; else ηv=ηc=η0 (correct at epoch start).
     */
    private async ensureEvolverBootstrapped(
        epoch: number,
        eta0Hex: string,
    ): Promise<void> {
        const evolver = await this.ensureNonceEvolver();
        if (!evolver || evolver.isActive()) return;
        try {
            const st = await getEpochNonceState(epoch);
            if (st?.evolving_hex && st?.candidate_hex) {
                evolver.bootstrap(epoch, eta0Hex, {
                    etaVHex: st.evolving_hex,
                    etaCHex: st.candidate_hex,
                });
                logger.debug(
                    `NonceEvolver restored ηv/ηc from DB for epoch ${epoch}`,
                );
            } else {
                evolver.bootstrap(epoch, eta0Hex);
                logger.debug(
                    `NonceEvolver bootstrapped ηv=ηc=η0 for epoch ${epoch}`,
                );
            }
        } catch (err: unknown) {
            logger.warn(
                `NonceEvolver bootstrap failed for epoch ${epoch}:`,
                err,
            );
        }
    }

    /** Feed one applied Shelley+ block into UPDN; persist any TICKN η0. */
    private async feedNonceEvolver(
        slot: bigint | number,
        header: unknown,
        epoch: number,
        eta0Hex: string,
    ): Promise<void> {
        try {
            await this.ensureEvolverBootstrapped(epoch, eta0Hex);
            const evolver = this.nonceEvolver;
            if (!evolver?.isActive()) return;

            const bnonce = NonceEvolver.extractBlockNonce(header);
            if (!bnonce) return; // Byron / missing VRF

            const prevHash = getHeaderPrevHash(header as any);
            const tickns = evolver.processBlock(slot, bnonce, prevHash);
            for (const t of tickns) {
                this.epochNonceCache.set(t.epoch, t.eta0Hex);
                try {
                    await storeEpochNonce(
                        t.epoch,
                        t.eta0Hex,
                        "local",
                        t.etaVHex,
                        t.etaCHex,
                    );
                    logger.info(
                        `TICKN η0_${t.epoch}=${t.eta0Hex.slice(0, 16)}… ` +
                            `(blocks=${t.nBlocksPrev} freeze=${t.nBeforeFreeze})`,
                    );
                } catch (storeErr: unknown) {
                    logger.warn(
                        `Failed to persist TICKN η0 for epoch ${t.epoch}:`,
                        storeErr,
                    );
                }
            }

            // Persist evolving/candidate for current epoch (mid-chain resume)
            if (tickns.length === 0 && evolver.isActive()) {
                const snap = evolver.snapshot();
                try {
                    await storeEpochNonce(
                        snap.epoch,
                        eta0Hex,
                        "local",
                        snap.etaVHex,
                        snap.etaCHex,
                    );
                } catch {
                    // non-fatal; next TICKN still persists
                }
            }
        } catch (err: unknown) {
            logger.warn("NonceEvolver feed failed:", err);
        }
    }

    /** Hash (hex) of the block at the DB tip, or null on an empty DB. */
    private async dbTipHash(): Promise<string | null> {
        const maxSlot = await getMaxSlot();
        if (maxSlot <= 0n) return null;
        const row = await getBlockBySlot(maxSlot);
        if (!row) return null;
        const h: unknown = Array.isArray(row) ? row[3] : (row as any).block_hash ?? (row as any).hash;
        if (h instanceof Uint8Array) return toHex(h);
        return typeof h === "string" ? h.toLowerCase() : null;
    }

    private async getCurrentTip(): Promise<
        { blockNumber: number; slotNumber: bigint }
    > {
        const maxSlot = await getMaxSlot();
        const blockCount = maxSlot > 0n ? Number(maxSlot) : 0; // Approximate, since slots may have gaps
        return { blockNumber: blockCount, slotNumber: maxSlot };
    }

    /**
     * Resolve epoch η0 for header VRF:
     * 1) in-memory cache
     * 2) local SQLite (epoch_nonces)
     * 3) external Blockfrost/onchainapps → persist to DB
     *
     * Continuous UPDN+TICKN (phase 3) evolves ηv/ηc on applied blocks and
     * writes next-epoch η0 via storeEpochNonce(source='local').
     * Mid-chain still bootstraps η0 from DB/external when needed.
     */
    private async getEpochNonce(epoch: number): Promise<string | null> {
        if (this.epochNonceCache.has(epoch)) {
            logger.debug(`Cache hit for epoch nonce ${epoch}`);
            return this.epochNonceCache.get(epoch)!;
        }

        try {
            const local = await dbGetEpochNonce(epoch);
            if (local) {
                this.epochNonceCache.set(epoch, local);
                logger.debug(`DB hit for epoch nonce ${epoch}`);
                return local;
            }
        } catch (error: unknown) {
            logger.warn(`Local epoch nonce read failed for ${epoch}:`, error);
        }

        try {
            const nonce = await blockFrostFetchEra(this.config, epoch);
            this.epochNonceCache.set(epoch, nonce);
            try {
                await storeEpochNonce(epoch, nonce, "external");
            } catch (storeErr: unknown) {
                logger.warn(
                    `Failed to persist epoch ${epoch} nonce to DB:`,
                    storeErr,
                );
            }
            logger.debug(
                `Fetched and cached epoch ${epoch} nonce from external (persisted)`,
            );
            return nonce;
        } catch (error: unknown) {
            logger.error(`Failed to fetch epoch ${epoch} nonce:`, error);
            return null;
        }
    }

    private async ensureByronObft(): Promise<ByronObftState | null> {
        if (this.byronObft) return this.byronObft;
        if (!this.byronObftInit) {
            this.byronObftInit = (async () => {
                try {
                    const genesis = await getByronGenesisConfig(this.config);
                    if (!genesis) {
                        logger.warn(
                            "No byronGenesisFile configured: Byron headers get structural checks only (no OBFT signature/delegation verification)",
                        );
                        return null;
                    }
                    const state = new ByronObftState(genesis);
                    // Rebuild the k-window from what is already applied.
                    try {
                        const recent = await getRecentBlockHeaders(state.k);
                        state.seed(
                            recent.reverse().map((r) => ({ rawHeader: r.header_data, slot: r.slot })),
                        );
                    } catch (err: unknown) {
                        logger.warn("Byron OBFT window seed failed:", err);
                    }
                    logger.info(
                        `Byron OBFT ready: ${state.genesisKeys.size} genesis keys, k=${state.k}, max ${state.maxSignaturesPerWindow} sigs/window`,
                    );
                    this.byronObft = state;
                    return state;
                } catch (err: unknown) {
                    logger.error("Byron OBFT init failed:", err);
                    return null;
                }
            })();
        }
        return this.byronObftInit;
    }

    private rememberApplied(hashHex: string): void {
        const h = hashHex.toLowerCase();
        if (this.appliedRecently.has(h)) return;
        this.appliedRecently.add(h);
        this.appliedRecentlyOrder.push(h);
        while (this.appliedRecentlyOrder.length > ConsensusOrchestrator.APPLIED_LRU_SIZE) {
            const old = this.appliedRecentlyOrder.shift();
            if (old) this.appliedRecently.delete(old);
        }
    }

    /** Pending ranges/headers/fragments are void after the chain moved backwards. */
    private afterRollback(): void {
        this.lastAccepted = null;
        this.pendingHeaders.clear();
        this.lastPrimaryByronHeaderHash = null;
        this.scheduler?.reset("rollback");
        this.candidates.reset();
    }

    private forgetApplied(): void {
        this.appliedRecently.clear();
        this.appliedRecentlyOrder.length = 0;
    }

    /** True when this header hash is already applied (LRU, then DB). */
    private async isAlreadyApplied(hashHex: string): Promise<boolean> {
        const h = hashHex.toLowerCase();
        if (this.appliedRecently.has(h)) return true;
        try {
            if (await getBlockByHash(h)) {
                this.rememberApplied(h);
                return true;
            }
        } catch (err: unknown) {
            logger.warn(`applied-lookup failed for ${h}:`, err);
        }
        return false;
    }

    /** Peer served provably bad data: cut it off with a reason the governor holds cold for 1h. */
    private terminateMalicious(peer: PeerClient, reason: string): never {
        logger.error(`Malicious peer ${peer.peerId}: ${reason}`);
        peer.terminate(`malicious: ${reason}`);
        throw new Error(`malicious peer ${peer.peerId}: ${reason}`);
    }

    /** Raw `[txPayload, ssc, dlg, upd]` (Byron main) from a BlockFetch payload, or undefined. */
    private static byronRawBody(blockData: Uint8Array): Uint8Array | undefined {
        try {
            const { rawBlock } = splitEraBlock(blockData);
            const arr = Cbor.parseLazy(rawBlock);
            return arr instanceof LazyCborArray ? arr.array[1] : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Byron prevBlock chaining. The expected parent is, in order:
     * the previous header of this batch, the last applied Byron block,
     * any block already in the DB with that hash, or — on an empty chain —
     * the configured Byron genesis hash.
     */
    private async assertByronContinuity(
        parsed: ParsedHeader,
        prevInBatch: string | null,
    ): Promise<void> {
        const prev = parsed.prevHashHex?.toLowerCase();
        const self = toHex(parsed.blockHeaderHash);
        if (!prev) {
            throw new Error(
                `Byron header ${self} at slot ${parsed.slot} has no prevBlock`,
            );
        }
        const expected = (prevInBatch ?? this.lastByronTipHash)?.toLowerCase();
        if (expected && prev === expected) return;

        // Not the in-memory tip (restart, same-slot EBB, or a peer replaying
        // from origin): accept any parent we already hold — applyBlock is
        // INSERT OR IGNORE, so a replay is harmless.
        try {
            if (await getBlockByHash(prev)) {
                if (expected) {
                    logger.debug(
                        `Byron header ${self} at slot ${parsed.slot} extends known block ${prev} (tip was ${expected})`,
                    );
                }
                return;
            }
        } catch (err: unknown) {
            logger.warn(`Byron continuity DB lookup failed for ${prev}:`, err);
        }
        if (expected) {
            throw new Error(
                `Byron chain break at slot ${parsed.slot} hash=${self}: prevBlock=${prev} expected=${expected}`,
            );
        }

        let dbEmpty = false;
        try {
            dbEmpty = (await getMaxSlot()) === 0n;
        } catch {
            dbEmpty = false;
        }
        if (dbEmpty) {
            const genesis = this.config.byronGenesisHash?.toLowerCase();
            if (!genesis) {
                logger.warn(
                    `Byron genesis hash not configured; accepting first block ${self} with prevBlock=${prev} unverified`,
                );
                return;
            }
            if (prev === genesis) return;
            throw new Error(
                `Byron chain break at origin: first header ${self} prevBlock=${prev} but byronGenesisHash=${genesis}`,
            );
        }

        throw new Error(
            `Byron chain break at slot ${parsed.slot} hash=${self}: prevBlock=${prev} is not a known block`,
        );
    }

    async handleRollForward(
        rollForwardCborBytes: Uint8Array,
        peerId: string,
        tip: bigint,
    ): Promise<void> {
        return this.handleRollForwardBatch(
            [{ rollForwardCborBytes, tip }],
            peerId,
        );
    }

    async handleRollForwardBatch(
        items: RollForwardBatchItem[],
        peerId: string,
    ): Promise<void> {
        if (items.length === 0) return;
        const run = this.rollForwardChain.then(() =>
            this.processRollForwardBatch(items, peerId)
        );
        this.rollForwardChain = run.then(() => undefined, () => undefined);
        return run;
    }

    // ─────────────────────────── multi-peer plumbing ───────────────────────────

    /** A peer became hot: give it a role (first hot = primary). */
    registerHotPeer(peerKey: string): PeerRole {
        const role = this.candidates.addPeer(peerKey);
        logger.info(`Hot peer ${peerKey} joins as ${role}${role === "verifier" ? ` (primary ${this.candidates.primary()})` : ""}`);
        return role;
    }

    /** A hot peer left (demoted / terminated). Promotes a successor if it was primary. */
    unregisterHotPeer(peerKey: string): void {
        if (!this.candidates.hasPeer(peerKey)) return;
        const wasPrimary = this.candidates.primary() === peerKey;
        this.candidates.removePeer(peerKey);
        if (wasPrimary) {
            const next = this.candidates.bestSuccessor();
            this.lastAccepted = null; // re-anchor the contiguity check on the DB tip
            if (next) {
                this.candidates.setPrimary(next);
                logger.warn(`Primary ${peerKey} left; ${next} promoted to primary`);
                // Its stream is wherever it got to as a verifier — usually ahead of what we
                // applied. Restart it from our DB tip so no block between is skipped.
                const succ = this.peerByKey(next);
                if (succ) void succ.restartChainSync("promoted to primary; re-anchor on DB tip");
            } else {
                logger.warn(`Primary ${peerKey} left; no verifier available, next hot peer becomes primary`);
            }
            // Pending headers came from the old primary's fragment; their bodies can still be
            // fetched from agreeing peers, so the scheduler keeps running.
        }
    }

    roleOf(peerKey: string): PeerRole | null {
        return this.candidates.roleOf(peerKey);
    }

    /** Not configurable: strict whenever the ledger is complete, report-only for tip sync. See validationPolicy.ts. */
    resolveBodyPolicy(): BodyValidationPolicy {
        return resolveValidationPolicy(this.config).body;
    }

    syncSnapshot(): SyncSnapshot {
        const now = Date.now();
        while (this.applyTimestamps.length && now - this.applyTimestamps[0]! > 10_000) this.applyTimestamps.shift();
        const mode: SyncSnapshot["mode"] = this.config.syncFromGenesis
            ? "genesis"
            : this.config.syncFromPoint
            ? "point"
            : "tip";
        const cand = this.candidates.snapshot();
        return {
            halted: this.halted,
            mode,
            bodyValidation: this.resolveBodyPolicy(),
            primary: cand.primary,
            quorum: this.quorum(),
            peers: cand.peers,
            scheduler: this.scheduler?.stats() ?? { inFlight: 0, queued: 0, awaitingApply: 0, applied: 0, retries: 0, nextApplySeq: 0 },
            validationWorkers: this.pool?.workerCount ?? 0,
            pendingHeaders: this.pendingHeaders.size,
            blocksApplied: this.blocksApplied,
            blocksPerSec: Math.round((this.applyTimestamps.length / 10) * 100) / 100,
            profile: this.profile.snapshot(),
        };
    }

    private quorum(): number {
        const q = Number(this.config.sync?.quorum ?? 2);
        return Number.isFinite(q) && q >= 1 ? Math.trunc(q) : 2;
    }

    private peerByKey(key: string): PeerClient | null {
        return this.peers.getPeer(key);
    }

    private ensureScheduler(): RangeScheduler<RangePt, BlockFetchBlock> {
        if (this.scheduler) return this.scheduler;
        const parallel = Number(
            this.config.blockFetchBatch?.parallelRanges ?? this.config.peerGovernor?.targetHot ?? 3,
        );
        this.scheduler = new RangeScheduler<RangePt, BlockFetchBlock>({
            maxInFlight: Number.isFinite(parallel) && parallel >= 1 ? Math.trunc(parallel) : 3,
            retryLimit: 4,
            pickPeers: (endSlot) => this.eligibleFetchPeers(endSlot),
            fetch: (peerKey, points) => this.fetchRangeFrom(peerKey, points),
            verify: (points, blocks, peerKey) => this.verifyFetchedRange(points, blocks, peerKey),
            onRange: (points, blocks, peerKey) => this.applyRange(points, blocks, peerKey),
            onPeerFailure: (peerKey, err, info) => {
                const peer = this.peerByKey(peerKey);
                if (info.malicious && peer) {
                    try {
                        this.terminateMalicious(peer, `range seq=${info.seq}: ${err instanceof Error ? err.message : String(err)}`);
                    } catch {
                        /* thrown on purpose by terminateMalicious */
                    }
                } else {
                    logger.warn(`Range seq=${info.seq} failed on ${peerKey}: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
            onFatal: (err) => {
                if (err instanceof BodyValidationFailure) {
                    // Every agreeing peer served this block and its body hash checked out: the
                    // block is real. Failing its ledger rules means OUR ledger state (or our
                    // rules) is wrong. Terminating peers would only hide that, so stop applying
                    // and say so loudly. The scheduler stays poisoned on purpose.
                    this.halted = { slot: err.slot.toString(), hash: err.hash, reason: err.message, since: Date.now() };
                    logger.error(
                        `SYNC HALTED: ${err.message}. The local ledger is inconsistent with the chain ` +
                            `(missing or extra UTxOs). Peers are not at fault. Fix: wipe the chain DB and resync from genesis.`,
                    );
                    return;
                }
                logger.error("Range pipeline failed; resetting and restarting the primary's ChainSync:", err);
                const primaryKey = this.candidates.primary();
                const primary = primaryKey ? this.peerByKey(primaryKey) : null;
                this.pendingHeaders.clear();
                this.lastPrimaryByronHeaderHash = null;
                this.scheduler?.reset("range pipeline failed");
                primary?.terminate("range pipeline failed");
            },
        });
        return this.scheduler;
    }

    /** Peers safe to serve bodies for a range ending at `endSlot`: primary + verifiers agreeing through it. */
    private eligibleFetchPeers(endSlot: bigint): string[] {
        const out: string[] = [];
        for (const a of this.candidates.snapshot().peers) {
            if (a.role === "primary" || this.candidates.agreesThrough(a.key, endSlot)) {
                if (this.peerByKey(a.key)) out.push(a.key);
            }
        }
        return out;
    }

    private async fetchRangeFrom(peerKey: string, points: RangePt[]): Promise<BlockFetchBlock[]> {
        const peer = this.peerByKey(peerKey);
        if (!peer) throw new Error(`peer ${peerKey} is gone`);
        const chainPoints = points.map((p) =>
            new ChainPoint({ blockHeader: { slotNumber: p.slot, hash: fromHex(p.hash) } })
        );
        const result = await peer.fetchBlockRange(chainPoints);
        if (!Array.isArray(result)) {
            throw new Error(`peer ${peerKey} returned MsgNoBlocks for ${points.length}-point range`);
        }
        return result;
    }

    /** Identity + body integrity of a fetched range. Throws RangeMismatch when the peer lied. */
    private verifyFetchedRange(points: RangePt[], blocks: BlockFetchBlock[], peerKey: string): void {
        if (blocks.length !== points.length) {
            throw new RangeMismatch(`peer ${peerKey} returned ${blocks.length} blocks for ${points.length} points`);
        }
        for (let i = 0; i < points.length; i++) {
            const want = points[i]!;
            const identity = headerIdentityOfBlock(blocks[i]!.blockData);
            const got = toHex(identity.hash);
            if (got.toLowerCase() !== want.hash.toLowerCase()) {
                throw new RangeMismatch(
                    `peer ${peerKey} block ${i} header hash ${got} ≠ advertised ${want.hash} (slot ${want.slot})`,
                );
            }
            const body = verifyBlockBodyHash(blocks[i]!.blockData);
            if (!body.ok) {
                throw new RangeMismatch(
                    `peer ${peerKey} body hash mismatch at slot ${want.slot} hash=${want.hash}: expected=${body.expected} actual=${body.actual}`,
                );
            }
        }
    }

    // ───────────────────────────── header stage ─────────────────────────────

    private async processRollForwardBatch(
        items: RollForwardBatchItem[],
        peerId: string,
    ): Promise<void> {
        logger.debug(
            `Processing rollForward batch (${items.length}) from peer ${peerId}...`,
        );
        try {
            const peer = this.peers.getPeer(peerId);
            if (!peer) {
                // Terminated while its last batch was still queued — nothing to do.
                logger.debug(`Peer ${peerId} gone before its rollForward batch was processed; dropping ${items.length} header(s)`);
                return;
            }
            const peerKey = peer.peerKey;
            let role = this.candidates.roleOf(peerKey);
            if (!role) role = this.registerHotPeer(peerKey);

            // 1) parse (cheap, main thread) — needed for slot/epoch before nonce lookup
            const parsed: ParsedHeader[] = [];
            const tParse = performance.now();
            for (const item of items) {
                const p = await headerParser(item.rollForwardCborBytes);
                if (!p) throw new Error(`Header parse failed for peer ${peerId}`);
                parsed.push(p);
            }
            this.profile.add("hdr.parse", performance.now() - tParse);

            // 2) nonces (main thread: DB / network)
            const nonces: string[] = [];
            const tNonce = performance.now();
            for (const p of parsed) {
                if (p.isByron) {
                    nonces.push("");
                    continue;
                }
                const eta0 = await this.getEpochNonce(p.epoch);
                if (!eta0) {
                    throw new Error(
                        `Missing epoch nonce for slot ${p.slot.toString()} hash=${toHex(p.blockHeaderHash)}`,
                    );
                }
                nonces.push(eta0);
            }
            this.profile.add("hdr.nonce", performance.now() - tNonce);

            // 3) era validation (KES/VRF/op-cert or Byron structural) — worker pool
            const pool = this.pool!;
            const tVal = performance.now();
            const results = await pool.validateAll(
                items.map((item, i) => ({
                    rollForward: item.rollForwardCborBytes,
                    nonceHex: nonces[i]!,
                    config: {
                        networkMagic: this.config.networkMagic,
                        shelleyGenesisFile: this.config.shelleyGenesisFile,
                        network: String(this.config.network),
                    },
                })),
            );
            this.profile.add("hdr.validate", performance.now() - tVal);
            for (let i = 0; i < results.length; i++) {
                const r = results[i]!;
                if (r.ok) continue;
                const msg = `Header validation failed at slot ${parsed[i]!.slot} hash=${toHex(parsed[i]!.blockHeaderHash)}: ${r.reason ?? "invalid"}`;
                if (role === "verifier") this.terminateMalicious(peer, msg);
                throw new Error(msg);
            }

            // 4) role-specific handling
            if (role === "verifier") {
                await this.observeVerifierHeaders(peer, parsed);
                return;
            }
            await this.acceptPrimaryHeaders(peer, items, parsed, nonces);
        } catch (error: unknown) {
            logger.error(
                `Error processing rollForward batch for peer ${peerId}:`,
                error,
            );
            throw error;
        }
    }

    /** Verifier headers: compare against the primary; act on divergence. */
    private async observeVerifierHeaders(peer: PeerClient, parsed: ParsedHeader[]): Promise<void> {
        const peerKey = peer.peerKey;
        for (const p of parsed) {
            const verdict = this.candidates.observe(peerKey, { slot: p.slot, hash: toHex(p.blockHeaderHash) });
            if (verdict.kind !== "divergent") continue;

            const outvote = this.candidates.primaryOutvoted(this.quorum());
            if (outvote.outvoted && outvote.by?.includes(peerKey)) {
                await this.switchPrimaryAfterOutvote(outvote.slot!, outvote.hash!, outvote.by!);
                return;
            }
            this.terminateMalicious(
                peer,
                `diverges from primary at slot ${verdict.slot}: peer=${verdict.peerHash} primary=${verdict.primaryHashes.join("|") || "∅"}`,
            );
        }
    }

    /**
     * ≥quorum verifiers agree on a different block than the primary at `slot`:
     * the primary is the outlier. Hold it cold, adopt the best agreeing verifier
     * as primary, roll our chain back to just before the fork and refill from
     * the new primary's fragment.
     */
    private async switchPrimaryAfterOutvote(slot: bigint, hash: string, by: string[]): Promise<void> {
        const oldKey = this.candidates.primary();
        const successor = by
            .map((k) => this.candidates.agreement(k))
            .filter((a): a is PeerAgreement => !!a)
            .sort((a, b) => Number((b.tipSlot ?? 0n) - (a.tipSlot ?? 0n)))[0]?.key ?? by[0]!;
        logger.warn(
            `Primary ${oldKey} outvoted at slot ${slot}: ${by.length} verifiers agree on ${hash}. Switching primary to ${successor}.`,
        );
        this.pendingHeaders.clear();
        this.lastPrimaryByronHeaderHash = null;
        this.lastAccepted = null;
        this.scheduler?.reset("primary outvoted");
        this.candidates.setPrimary(successor);
        if (oldKey) {
            const old = this.peerByKey(oldKey);
            if (old) old.terminate(`malicious: outvoted at slot ${slot} (served ${this.candidates.agreement(oldKey)?.tipHash ?? "?"}, quorum on ${hash})`);
            this.candidates.removePeer(oldKey);
        }
        // Undo everything from the fork slot on; the new primary's fragment refills it.
        const rollbackTo = slot > 0n ? slot - 1n : 0n;
        await this.handleRollBack({ blockHeader: { slotNumber: rollbackTo } });
        const points = this.candidates.fragmentOf(successor).filter((p) => p.slot >= slot);
        const maxBlocks = Math.max(1, Number(this.config.blockFetchBatch?.maxBlocks ?? 32));
        for (let i = 0; i < points.length; i += maxBlocks) {
            const chunk = points.slice(i, i + maxBlocks).map((p) => ({ slot: p.slot, hash: p.hash }));
            // These headers were validated when observed; bodies are verified on fetch.
            this.ensureScheduler().submit(chunk).applied.catch(() => undefined);
        }
    }

    /** Primary headers: dedupe, Byron chaining/OBFT, then hand ranges to the scheduler. */
    private async acceptPrimaryHeaders(
        peer: PeerClient,
        items: RollForwardBatchItem[],
        parsed: ParsedHeader[],
        nonces: string[],
    ): Promise<void> {
        const peerKey = peer.peerKey;
        if (this.halted) return; // strict validation stopped the applier; nothing more is applied
        const points: RangePt[] = [];
        let skippedDuplicates = 0;
        let prevByronHashInBatch: string | null = null;
        let expectedPrev: string | null | undefined = this.lastAccepted?.hash; // undefined = not yet anchored

        for (let i = 0; i < parsed.length; i++) {
            const parsedHeader = parsed[i]!;
            const headerHashHex = toHex(parsedHeader.blockHeaderHash);
            this.candidates.observe(peerKey, { slot: parsedHeader.slot, hash: headerHashHex });

            if (this.pendingHeaders.has(headerHashHex) || await this.isAlreadyApplied(headerHashHex)) {
                skippedDuplicates++;
                expectedPrev = headerHashHex; // it is on our chain; the next header must chain onto it
                if (parsedHeader.isByron) {
                    prevByronHashInBatch = headerHashHex;
                    this.lastPrimaryByronHeaderHash = headerHashHex;
                }
                continue;
            }

            // Contiguity: the primary's stream must chain onto what we have. A promoted
            // verifier or a peer that skipped ahead would otherwise leave a hole in the
            // DB that strict validation only notices much later.
            if (!parsedHeader.isByron && parsedHeader.prevHashHex) {
                if (expectedPrev === undefined) expectedPrev = await this.dbTipHash();
                if (expectedPrev && parsedHeader.prevHashHex.toLowerCase() !== expectedPrev.toLowerCase()) {
                    logger.warn(
                        `Primary ${peerKey} header at slot ${parsedHeader.slot} does not chain onto our tip (prev ${parsedHeader.prevHashHex.slice(0, 12)}… ≠ ${expectedPrev.slice(0, 12)}…); restarting its ChainSync from the DB tip`,
                    );
                    this.lastAccepted = null;
                    void peer.restartChainSync("stream not contiguous with DB tip");
                    return;
                }
            }
            expectedPrev = headerHashHex;

            if (parsedHeader.isByron) {
                await this.assertByronContinuity(
                    parsedHeader,
                    prevByronHashInBatch ?? this.lastPrimaryByronHeaderHash,
                );
                prevByronHashInBatch = headerHashHex;
                this.lastPrimaryByronHeaderHash = headerHashHex;
                if (!parsedHeader.isEbb) {
                    const obft = await this.ensureByronObft();
                    if (obft) {
                        const check = obft.validateMainHeader(parsedHeader.rawHeaderBytes, parsedHeader.slot);
                        if (!check.ok) {
                            this.terminateMalicious(
                                peer,
                                `Byron OBFT check failed at slot ${parsedHeader.slot} hash=${headerHashHex}: ${check.reason}`,
                            );
                        }
                    }
                }
            }

            this.pendingHeaders.set(headerHashHex, { item: items[i]!, parsedHeader, nonce: nonces[i]! });
            points.push({ slot: parsedHeader.slot, hash: headerHashHex });
            this.lastAccepted = { slot: parsedHeader.slot, hash: headerHashHex };
        }

        if (skippedDuplicates > 0) {
            logger.debug(`Skipped ${skippedDuplicates} already-applied/pending header(s) from ${peerKey}`);
        }
        if (points.length === 0) return;

        const { scheduled, applied } = this.ensureScheduler().submit(points);
        applied.catch(() => undefined); // surfaced via onFatal
        try {
            await scheduled; // back-pressure: at most N ranges downloading
        } catch (err) {
            // A rollback / primary switch dropped this range on purpose; the peer
            // is fine and will resend from the new point. Not a peer failure.
            if (err instanceof SchedulerReset) {
                logger.debug(`Range from ${peerKey} dropped: ${err.message}`);
                return;
            }
            throw err;
        }
    }

    // ───────────────────────────── apply stage ─────────────────────────────

    /** Apply one verified range, strictly in chain order. */
    private async applyRange(points: RangePt[], blocks: BlockFetchBlock[], fetchedFrom: string): Promise<void> {
        const bodyPolicy = this.resolveBodyPolicy();
        for (let i = 0; i < points.length; i++) {
            const pt = points[i]!;
            const blockMessage = blocks[i]!;
            const pending = this.pendingHeaders.get(pt.hash);
            // Headers from a primary switch were validated as verifier headers; no pending entry.
            const tParse = performance.now();
            const multiEraBlock = await blockParser(blockMessage);
            if (!multiEraBlock || !(multiEraBlock instanceof MultiEraBlock)) {
                throw new Error(`Block parse failed at slot ${pt.slot} hash=${pt.hash}`);
            }
            const blockHeader = multiEraBlock.block.header;
            const identity = headerIdentityOfBlock(blockMessage.blockData);
            this.profile.add("blk.parse", performance.now() - tParse);
            const isByron = identity.era <= 1;
            const isEbb = identity.era === 0;
            const headerBytes = identity.rawHeaderBytes;
            const blockHeaderHash = identity.hash;
            const blockHash = toHex(blockHeaderHash);
            const blockSlot = BigInt(getHeaderSlot(blockHeader));
            if (blockSlot !== pt.slot || blockHash.toLowerCase() !== pt.hash.toLowerCase()) {
                throw new RangeMismatch(`block ${blockHash}@${blockSlot} does not match advertised ${pt.hash}@${pt.slot}`);
            }
            const blockEpoch = Number(calculatePreProdCardanoEpoch(Number(blockSlot)));

            if (await this.profile.timeAsync("blk.dedupe", () => this.isAlreadyApplied(blockHash))) {
                this.pendingHeaders.delete(pt.hash);
                continue;
            }

            // Ledger body rules (per-epoch parameters when available).
            let epochParams: EpochBodyParams | null = null;
            if (!isByron) {
                epochParams = await this.profile.timeAsync("blk.params", () => getEpochBodyParams(this.config, blockEpoch));
            }
            const valid = await this.profile.timeAsync("blk.validate", () => validateBlock(multiEraBlock, this.config, epochParams));
            if (!valid && bodyPolicy === "strict") {
                throw new BodyValidationFailure(blockSlot, blockHash, `params=${epochParams ? "epoch " + epochParams.epoch : "genesis"}`);
            }
            if (!valid) {
                logger.warn(`Block body validation failed at slot ${blockSlot} hash=${blockHash} (soft: applying)`);
            }

            await this.profile.timeAsync("blk.apply", () => applyBlock(multiEraBlock.block as MultiEraBlock["block"], blockSlot, blockHeaderHash));
            logger.debug(`Applied Block: ${blockHash}${fetchedFrom ? ` (from ${fetchedFrom})` : ""}`);
            this.rememberApplied(blockHash);
            this.blocksApplied++;
            this.applyTimestamps.push(Date.now());
            this.profile.noteBlock();
            if (this.blocksApplied % ConsensusOrchestrator.PROFILE_LOG_EVERY === 0) {
                logger.info(`Sync profile: ${this.profile.summary()}`);
            }

            // Nonce for Shelley+: prefer the header-stage lookup; fall back to a fresh lookup after a primary switch.
            let nonce = pending?.nonce ?? "";
            if (!isByron && !nonce) nonce = (await this.getEpochNonce(blockEpoch)) ?? "";
            const tNonce = performance.now();

            if (isByron) {
                this.lastByronTipHash = blockHash;
                if (!isEbb && this.byronObft) {
                    try {
                        this.byronObft.noteApplied(headerBytes, blockSlot, ConsensusOrchestrator.byronRawBody(blockMessage.blockData));
                    } catch (err: unknown) {
                        logger.warn(`Byron OBFT noteApplied failed at slot ${blockSlot}:`, err);
                    }
                }
            } else if (nonce) {
                await this.feedNonceEvolver(blockSlot, blockHeader, blockEpoch, nonce);
            }
            this.profile.add("blk.nonce", performance.now() - tNonce);

            // volatile_headers is keyed by slot; a Byron EBB shares its slot with the
            // epoch's first main block, so keep only the main block there.
            if (!isEbb && pending) {
                this.batchHeaderRecords.set(blockHash, {
                    slot: blockSlot,
                    headerHash: blockHash,
                    rollforward_header_cbor: pending.item.rollForwardCborBytes.slice(),
                });
            }
            const tEnc = performance.now();
            this.batchBlockRecords.set(blockHash, {
                slot: blockSlot,
                blockHash,
                prevHash: getHeaderPrevHashHex(blockHeader),
                headerData: headerBytes,
                blockData: multiEraBlock.block.toCborBytes(),
                block_fetch_RawCbor: blockMessage.toCborBytes(),
            });
            this.profile.add("blk.encode", performance.now() - tEnc);
            const tIns = performance.now();
            await insertBlockBatchVolatile(Array.from(this.batchBlockRecords.values()));
            await insertHeaderBatchVolatile(Array.from(this.batchHeaderRecords.values()));
            this.profile.add("blk.insert", performance.now() - tIns);
            this.batchBlockRecords.clear();
            this.batchHeaderRecords.clear();
            this.pendingHeaders.delete(pt.hash);
            if (++this.volatileDbGcCounter % ConsensusOrchestrator.VOLATILE_GC_EVERY_BLOCKS === 0) {
                const gc = await this.profile.timeAsync("blk.gc", () => gcVolatile());
                if (gc.blocks || gc.headers) logger.debug(`Volatile GC removed ${gc.blocks} block(s), ${gc.headers} header(s)`);
            }

            const tEmit = performance.now();
            emitTip({
                slot: String(blockSlot),
                hash: blockHash,
                epoch: Number.isFinite(blockEpoch) ? blockEpoch : null,
                era: multiEraBlock.era,
            });

            this.config.tuiEnabled &&
                prettyBlockValidationLog(
                    multiEraBlock.era,
                    blockEpoch,
                    blockHeaderHash,
                    Number(blockSlot),
                    Number(pending?.item.tip ?? blockSlot),
                    this.volatileDbGcCounter,
                    this.batchBlockRecords.size,
                );
            this.profile.add("blk.emit", performance.now() - tEmit);
        }
    }

    /** Security parameter k (blocks): a rollback deeper than this is not a fork, it is an attack or a broken peer. */
    private async securityParamK(): Promise<number> {
        try {
            const g = await getShelleyGenesisConfig(this.config);
            const k = Number((g as { securityParam?: number } | null)?.securityParam);
            if (Number.isFinite(k) && k > 0) return k;
        } catch {
            /* fall through */
        }
        return 2160;
    }

    async handleRollBack(
        point: RollbackPoint,
        candidate?: ChainCandidate,
        fromPeerId?: string,
    ): Promise<
        {
            rolledBack: boolean;
            fromSlot?: bigint;
            toSlot?: bigint;
            counts?: {
                blocksDeleted: number;
                headersDeleted: number;
                deltasDeleted: number;
            };
        }
    > {
        try {
            // Only the primary drives our chain. A verifier's RollBackward moves
            // *its* read pointer (typically right after its FindIntersect); it must
            // never rewind our database. Drop its fragment so comparison restarts.
            const fromPeer = fromPeerId ? this.peers.getPeer(fromPeerId) : null;
            if (fromPeer && this.candidates.roleOf(fromPeer.peerKey) === "verifier") {
                this.candidates.removePeer(fromPeer.peerKey);
                this.candidates.addPeer(fromPeer.peerKey, "verifier");
                logger.debug(`Verifier ${fromPeer.peerKey} rolled back to slot ${point.blockHeader?.slotNumber}; fragment reset, DB untouched`);
                return { rolledBack: false };
            }
            const currentTip = await this.getCurrentTip();
            const pointSlot = point.blockHeader!.slotNumber;
            logger.rollback(
                `handleRollBack: current tip slot=${currentTip.slotNumber.toString()} (~${currentTip.blockNumber} blocks), point slot=${pointSlot.toString()}${
                    candidate
                        ? `, candidate slot=${candidate.slotNumber.toString()} block#${candidate.blockNumber}`
                        : ""
                }`,
            );

            if (candidate) {
                const evalResult = await evaluateChains(
                    [candidate],
                );
                const comparison = evalResult.comparison;
                logger.rollback(
                    `Praos eval: preferred='${comparison.preferred}', intersectionBlock=${comparison.intersectionBlock}, rollbackDistance=${comparison.rollbackDistance}`,
                );

                if (comparison.preferred === "candidate") {
                    const rollbackSlot = point.blockHeader!.slotNumber;
                    const counts = await rollbackChainTo(rollbackSlot);
                    logger.rollback(
                        `Praos-approved rollback to slot ${rollbackSlot}: ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`,
                    );
                    this.nonceEvolver?.reset();
                    this.epochNonceCache.clear();
                    this.lastByronTipHash = null;
                    this.forgetApplied();
                    this.byronObft = null;
                    this.byronObftInit = null;
                    this.afterRollback();
                    return {
                        rolledBack: true,
                        fromSlot: currentTip.slotNumber,
                        toSlot: rollbackSlot,
                        counts,
                    };
                } else {
                    logger.rollback(
                        `Rollback rejected by Praos: current preferred over candidate at slot ${candidate.slotNumber}`,
                    );
                    return { rolledBack: false };
                }
            } else {
                // cardano-node disconnects a peer whose intersection is more than k
                // blocks behind our tip (ForkTooDeep); never rewind past k on one
                // peer's say-so.
                const depth = await countBlocksAfterSlot(pointSlot);
                const k = await this.securityParamK();
                if (depth > k) {
                    const who = fromPeerId ? this.peers.getPeer(fromPeerId) : null;
                    const reason = `rollback to slot ${pointSlot} would discard ${depth} blocks (> k=${k})`;
                    logger.error(`Refusing ${reason}${who ? `; peer ${who.peerKey} held as malicious` : ""}`);
                    if (who) {
                        try {
                            who.terminate(`malicious: ${reason}`);
                        } catch {
                            /* already gone */
                        }
                    }
                    return { rolledBack: false };
                }
                const counts = await rollbackChainTo(pointSlot);
                logger.rollback(
                    `Unconditional tip rollback to slot ${pointSlot}: ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`,
                );
                this.nonceEvolver?.reset();
                this.epochNonceCache.clear();
                this.lastByronTipHash = null;
                this.forgetApplied();
                this.byronObft = null;
                this.byronObftInit = null;
                this.afterRollback();
                return {
                    rolledBack: true,
                    fromSlot: currentTip.slotNumber,
                    toSlot: pointSlot,
                    counts,
                };
            }
        } catch (error) {
            logger.error("Error in handleRollBack:", error);
            return { rolledBack: false };
        }
    }
}
