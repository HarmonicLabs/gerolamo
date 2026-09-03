import { logger } from "../utils/logger";
import { sql } from "../sql";
import { SerializedMutationQueue } from "./SerializedMutationQueue";
import {
    blockFetchHeaderIdentity as headerIdentityOfBlock,
    blockParser,
    headerParser,
    type HeaderSummary,
} from "./blockHeaderParser";
import { validateBlock } from "./BlockBodyValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import {
    BlockFetchBlock,
    ChainPoint,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../tui";
import { calculatePreProdCardanoEpoch, epochForSlot, epochLengthSlots } from "../utils/epochFromSlotCalculations";
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
    getMaxBlockNo,
    setBulkSyncIndexSkip,
    getRecentBlockHeaders,
    getValidBlocksBefore,
    getValidHeadersBefore,
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
import { splitEraBlock } from "./bodyHash";
import { clampMaxRangeBlocks, rangeSizeFor } from "./rangeSizing";
import { ByronObftState } from "./byron/ByronOBFT";
import { getByronGenesisConfig } from "../utils/paths";
import { Cbor, LazyCborArray } from "@harmoniclabs/cbor";
import { CandidateSet, type PeerAgreement, type PeerRole } from "./CandidateSet";
import { RangeMismatch, RangeScheduler, type RangeSchedulerStats } from "./RangeScheduler";
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
    parsedHeader: HeaderSummary;
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

interface RollbackPoint {
    blockHeader?: {
        slotNumber: bigint;
    };
}

export class ConsensusOrchestrator {
    readonly config: GerolamoConfig;
    readonly peers!: PeerAccessor;
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
     * One promise chain per peer keeps that peer's batches in order while letting
     * peers parse/validate concurrently (verifier work used to sit on the primary's
     * critical path). Only adoption — candidate compare, outvote, accepting primary
     * headers — is serialised across peers, through `adoption`.
     */
    private readonly peerChains = new Map<string, Promise<void>>();
    private readonly adoption = new SerializedMutationQueue();
    /** Accepted primary points not yet handed to the scheduler (ranges are cut from here). */
    private readonly rangeBuffer: RangePt[] = [];
    private rangeFlushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set by stop(): no new ranges are started or accepted; the in-flight range finishes its transaction. */
    private stopping = false;
    /** Chain height of the last applied main block (Byron EBBs do not count); loaded from the DB on first use. */
    private lastBlockNo: number | null = null;
    /**
     * Serialises the two DB writers that open their own transaction, `applyRange`
     * and `rollbackChainTo`: SQLite allows one open transaction per connection.
     */
    private readonly dbMutations = new SerializedMutationQueue();
    /** Header identity computed while verifying a fetched range, reused by the applier (decode once). */
    private readonly verifiedIdentities = new WeakMap<BlockFetchBlock, ReturnType<typeof headerIdentityOfBlock>>();

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

    private nonceSnapshotDue: { eta0Hex: string } | null = null;

    /** Persist the evolver's ηv/ηc once per applied range (inside its transaction). */
    private async persistNonceSnapshot(): Promise<void> {
        const due = this.nonceSnapshotDue;
        if (!due) return;
        this.nonceSnapshotDue = null;
        const evolver = this.nonceEvolver;
        if (!evolver?.isActive()) return;
        const snap = evolver.snapshot();
        try {
            await storeEpochNonce(snap.epoch, due.eta0Hex, "local", snap.etaVHex, snap.etaCHex);
        } catch {
            // non-fatal; the next TICKN persists η0 regardless
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

            // ηv/ηc for mid-chain resume are persisted once per range (persistNonceSnapshot),
            // not per block: a range commits atomically, so the two are equivalent.
            if (tickns.length === 0) this.nonceSnapshotDue = { eta0Hex };
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
        this.lastBlockNo = null; // heights past the rollback point are gone
        this.lastAccepted = null;
        this.pendingHeaders.clear();
        this.discardRangeBuffer();
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
        parsed: HeaderSummary,
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
        const prev = this.peerChains.get(peerId) ?? Promise.resolve();
        const run = prev.then(() => this.processRollForwardBatch(items, peerId));
        const settled = run.then(() => undefined, () => undefined);
        this.peerChains.set(peerId, settled);
        void settled.then(() => {
            if (this.peerChains.get(peerId) === settled) this.peerChains.delete(peerId);
        });
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
        if (wasPrimary && !this.stopping) { // during shutdown peers leave in bulk: no successors, no restarts
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

    /** The peer whose ChainSync drives our chain; the governor must not demote it. */
    primaryPeerKey(): string | null {
        return this.candidates.primary();
    }

    /**
     * Graceful stop: drop queued/downloading ranges, let the range currently being
     * applied finish its SQLite transaction (commit or roll back — never a half-applied
     * range), then close the validation workers. Idempotent.
     */
    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        this.discardRangeBuffer();
        this.scheduler?.reset("shutdown");
        try {
            await this.dbMutations.drain();
        } catch {
            /* a failed range already logged itself */
        }
        this.pool?.close();
        this.pool = null;
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
                this.discardRangeBuffer();
                this.lastPrimaryByronHeaderHash = null;
                this.scheduler?.reset("range pipeline failed");
                primary?.terminate("range pipeline failed");
            },
        });
        return this.scheduler;
    }

    /**
     * Peers that may serve bodies for a range ending at `endSlot`.
     *
     * Any hot peer may serve any range of the primary's validated fragment: every
     * fetched block is bound to its validated header by the body-hash check in
     * `verifyFetchedRange`, so a lying peer is caught on its first block and held
     * as malicious before anything is applied. Agreement (`agreesThrough`) is the
     * rule for choosing a primary and for outvoting, not for serving bodies; using
     * it here collapsed `parallelRanges` to one range on the primary's socket
     * during a genesis catch-up, when verifier streams trail the primary by
     * thousands of headers. Divergent peers are skipped: they follow another
     * chain and would mostly answer MsgNoBlocks.
     *
     * Ordering: primary and agreeing verifiers first, then the rest. The scheduler
     * tries untried peers first per range, so a peer that answers MsgNoBlocks
     * (behind, not lying) costs one retry and the range moves on.
     */
    private eligibleFetchPeers(endSlot: bigint): string[] {
        const agreeing: string[] = [];
        const rest: string[] = [];
        for (const a of this.candidates.snapshot().peers) {
            if (a.divergence) continue;
            if (!this.peerByKey(a.key)) continue;
            if (a.role === "primary" || this.candidates.agreesThrough(a.key, endSlot)) agreeing.push(a.key);
            else rest.push(a.key);
        }
        return agreeing.concat(rest);
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

    /**
     * Identity + body integrity of a fetched range, on the validation pool (pure over
     * bytes, so it runs off the main thread). Throws RangeMismatch when the peer lied.
     * The identities are kept for the applier so each block is decoded once.
     */
    private async verifyFetchedRange(points: RangePt[], blocks: BlockFetchBlock[], peerKey: string): Promise<void> {
        if (blocks.length !== points.length) {
            throw new RangeMismatch(`peer ${peerKey} returned ${blocks.length} blocks for ${points.length} points`);
        }
        const t0 = performance.now();
        const pool = this.pool;
        if (!pool) throw new Error("shutting down");
        const r = await pool.verifyRange({
            kind: "range",
            blocks: blocks.map((b) => b.blockData),
            expectedHashes: points.map((p) => p.hash),
        });
        this.profile.add("rng.verify", performance.now() - t0);
        if (!r.ok) {
            const i = r.index ?? 0;
            const want = points[i];
            throw new RangeMismatch(
                `peer ${peerKey} block ${i} (slot ${want?.slot} hash=${want?.hash}): ${r.reason ?? "verification failed"}`,
            );
        }
        for (let i = 0; i < blocks.length; i++) {
            const id = r.identities[i]!;
            this.verifiedIdentities.set(blocks[i]!, { era: id.era, hash: fromHex(id.hashHex), rawHeaderBytes: id.rawHeader });
        }
    }

    // ───────────────────────────── header stage ─────────────────────────────

    private async processRollForwardBatch(
        items: RollForwardBatchItem[],
        peerId: string,
    ): Promise<void> {
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

            // 1) epoch range from the first and last header only (two parses per batch instead
            //    of one per header; the workers parse each header once, for validation).
            const tParse = performance.now();
            const first = await headerParser(items[0]!.rollForwardCborBytes);
            const last = items.length > 1 ? await headerParser(items[items.length - 1]!.rollForwardCborBytes) : first;
            if (!first || !last) throw new Error(`Header parse failed for peer ${peerId}`);
            this.profile.add("hdr.parse", performance.now() - tParse);

            // 2) nonces (main thread: DB / network) — one lookup per epoch the batch spans
            const tNonce = performance.now();
            const noncesByEpoch: Record<string, string> = {};
            const shelleyEpochs = [first, last].filter((p) => !p.isByron).map((p) => p.epoch);
            if (shelleyEpochs.length > 0) {
                const lo = Math.min(...shelleyEpochs);
                const hi = Math.max(...shelleyEpochs);
                for (let e = lo; e <= hi; e++) {
                    const eta0 = await this.getEpochNonce(e);
                    if (!eta0) {
                        throw new Error(
                            `Missing epoch nonce for epoch ${e} (headers ${first.slot}..${last.slot} from ${peerId})`,
                        );
                    }
                    noncesByEpoch[String(e)] = eta0;
                }
            }
            this.profile.add("hdr.nonce", performance.now() - tNonce);

            // 3) parse + era validation (KES/VRF/op-cert or Byron structural) — worker pool
            const pool = this.pool;
            if (!pool) return; // shutting down
            const tVal = performance.now();
            if (this.stopping) return;
            const results = await pool.validateAll(
                items.map((item) => ({
                    rollForward: item.rollForwardCborBytes,
                    nonceHex: "",
                    noncesByEpoch,
                    // Byron block signatures verify on the workers when OBFT is configured;
                    // Byron protocolMagic equals the network magic on every Cardano network.
                    byronProtocolMagic: this.config.byronGenesisFile ? Number(this.config.networkMagic) : undefined,
                    config: {
                        networkMagic: this.config.networkMagic,
                        shelleyGenesisFile: this.config.shelleyGenesisFile,
                        network: String(this.config.network),
                    },
                })),
            );
            this.profile.add("hdr.validate", performance.now() - tVal);
            const parsed: HeaderSummary[] = [];
            const nonces: string[] = [];
            for (const r of results) {
                if (!r.ok) {
                    const msg = `Header validation failed at slot ${r.slot} hash=${r.hashHex}: ${r.reason ?? "invalid"}`;
                    if (role === "verifier") this.terminateMalicious(peer, msg);
                    throw new Error(msg);
                }
                parsed.push({
                    slot: BigInt(r.slot),
                    blockHeaderHash: fromHex(r.hashHex),
                    era: r.era,
                    epoch: r.epoch,
                    isByron: r.isByron,
                    isEbb: r.isEbb,
                    rawHeaderBytes: r.rawHeader,
                    prevHashHex: r.prevHashHex,
                    ...(r.byron?.ok && r.byron.issuerKeyHash && r.byron.signerKeyHash
                        ? { byronSig: { issuerKeyHash: r.byron.issuerKeyHash, signerKeyHash: r.byron.signerKeyHash } }
                        : {}),
                });
                nonces.push(r.isByron ? "" : noncesByEpoch[String(r.epoch)] ?? "");
            }

            // 4) adoption — the only cross-peer critical section. The role is re-read
            //    under the lock: a primary switch may have happened while validating.
            const adoptedAsPrimary = await this.adoption.run(async () => {
                const roleNow = this.candidates.roleOf(peerKey);
                if (!roleNow) {
                    logger.debug(`Peer ${peerKey} left before its ${items.length} header(s) were adopted; dropping`);
                    return false;
                }
                const gen = items[0]!.generation;
                if (gen != null && gen !== peer.chainSyncGeneration) {
                    logger.debug(`Peer ${peerKey}: ${items.length} header(s) from a restarted ChainSync stream (gen ${gen} ≠ ${peer.chainSyncGeneration}); dropping`);
                    return false;
                }
                if (roleNow === "verifier") {
                    await this.observeVerifierHeaders(peer, parsed);
                    return false;
                }
                await this.acceptPrimaryHeaders(peer, items, parsed, nonces);
                return true;
            });
            // 5) back-pressure: the primary may run up to `headerLookahead` validated
            //    headers ahead of the applier (the header fragment, §3 of the sync plan),
            //    not merely one download slot. Waited outside the lock so verifiers keep
            //    comparing while the applier catches up. A verifier is paused once it is
            //    far ahead of the primary: its pending comparisons are what bounds memory.
            if (adoptedAsPrimary) await this.waitForHeaderRoom(peerKey);
            else await this.waitForVerifierRoom(peerKey);
        } catch (error: unknown) {
            if (this.stopping) return; // pool closed / peers terminating: not an error worth a stack trace
            logger.error(
                `Error processing rollForward batch for peer ${peerId}:`,
                error,
            );
            throw error;
        }
    }

    /** Verifier headers: compare against the primary; act on divergence. */
    private async observeVerifierHeaders(peer: PeerClient, parsed: HeaderSummary[]): Promise<void> {
        const peerKey = peer.peerKey;
        for (const p of parsed) {
            const verdict = this.candidates.observe(peerKey, { slot: p.slot, hash: toHex(p.blockHeaderHash), ebb: p.isEbb });
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
        this.maybePromoteFasterVerifier();
    }

    /** Validated headers a verifier must lead the primary by before it is promoted for throughput. */
    private static readonly SPEED_PROMOTION_LEAD = 1024;
    private static readonly SPEED_PROMOTION_COOLDOWN_MS = 60_000;
    private lastSpeedPromotionAt = 0;

    /**
     * Header rate is per connection, so the primary's relay caps the whole sync (plan
     * §3.3). A verifier that agrees with the primary through the primary's tip and has
     * validated ≥ SPEED_PROMOTION_LEAD headers beyond it is a faster source of the same
     * chain: make it primary. The old primary stays hot as a verifier. The new primary
     * re-streams from the DB tip so every header still goes through
     * acceptPrimaryHeaders (contiguity, Byron OBFT state, range bookkeeping); nothing is
     * adopted from its verifier fragment directly. Runs under the adoption lock.
     */
    private maybePromoteFasterVerifier(): void {
        if (this.halted) return;
        // Only when the header side is what starves the applier. A primary blocked on
        // the header cap (bodies are the bottleneck) is not slow, and verifiers are not
        // subject to that cap, so any of them would look "ahead" of it.
        if (this.pendingHeaders.size >= this.headerLookahead() / 2) return;
        const now = Date.now();
        if (now - this.lastSpeedPromotionAt < ConsensusOrchestrator.SPEED_PROMOTION_COOLDOWN_MS) return;
        const oldKey = this.candidates.primary();
        const pick = this.candidates.fasterAgreeingVerifier(ConsensusOrchestrator.SPEED_PROMOTION_LEAD);
        if (!oldKey || !pick) return;
        const next = this.peerByKey(pick.key);
        if (!next) return;
        this.lastSpeedPromotionAt = now;
        logger.warn(
            `Verifier ${pick.key} agrees with primary ${oldKey} through slot ${pick.primaryTipSlot} and is ${pick.lead} validated headers ahead; promoting it to primary for throughput`,
        );
        this.candidates.setPrimary(pick.key);
        this.lastAccepted = null; // re-anchor the contiguity check on the DB tip
        this.lastPrimaryByronHeaderHash = null;
        // Pending headers / queued ranges from the old primary stay valid (same chain);
        // the new primary's re-stream skips them as duplicates and continues past them.
        void next.restartChainSync("promoted to primary for throughput; re-anchor on DB tip");
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
        this.discardRangeBuffer();
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
        const rangeBlocks = this.maxRangeBlocks();
        for (let i = 0; i < points.length; i += rangeBlocks) {
            const chunk = points.slice(i, i + rangeBlocks).map((p) => ({ slot: p.slot, hash: p.hash }));
            // These headers were validated when observed; bodies are verified on fetch.
            this.ensureScheduler().submit(chunk).applied.catch(() => undefined);
        }
    }

    /** Primary headers: dedupe, Byron chaining/OBFT, then hand ranges to the scheduler. */
    private async acceptPrimaryHeaders(
        peer: PeerClient,
        items: RollForwardBatchItem[],
        parsed: HeaderSummary[],
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
            this.candidates.observe(peerKey, { slot: parsedHeader.slot, hash: headerHashHex, ebb: parsedHeader.isEbb });

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
                try {
                    await this.assertByronContinuity(
                        parsedHeader,
                        prevByronHashInBatch ?? this.lastPrimaryByronHeaderHash,
                    );
                } catch (err) {
                    // The header extends a block we do not hold: the stream is not contiguous
                    // with our chain (seen right after a ChainSync restart, when a stale
                    // pipelined reply slips into the new stream). Same handling as the
                    // Shelley path: re-anchor on the DB tip. Not a fork, not malicious.
                    logger.warn(
                        `Primary ${peerKey} Byron stream not contiguous at slot ${parsedHeader.slot}: ${err instanceof Error ? err.message : String(err)}; restarting its ChainSync from the DB tip`,
                    );
                    this.lastAccepted = null;
                    this.lastPrimaryByronHeaderHash = null;
                    void peer.restartChainSync("Byron stream not contiguous with DB tip");
                    return;
                }
                prevByronHashInBatch = headerHashHex;
                this.lastPrimaryByronHeaderHash = headerHashHex;
                if (!parsedHeader.isEbb) {
                    const obft = await this.ensureByronObft();
                    if (obft) {
                        // Signature + certificate were verified on a worker (byronSig); only the
                        // stateful checks run here. Without a worker verdict, do the full check.
                        const sig = parsedHeader.byronSig;
                        const check = this.profile.time("hdr.obft", () =>
                            sig
                                ? obft.validateSignedMainHeader(parsedHeader.slot, sig.issuerKeyHash, sig.signerKeyHash)
                                : obft.validateMainHeader(parsedHeader.rawHeaderBytes, parsedHeader.slot));
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

        // Ranges are cut from a buffer so their size follows the distance to the tip
        // (large far behind, single blocks at the tip) instead of the header batch size.
        const lastItem = items[items.length - 1]!;
        const lastPoint = points[points.length - 1]!;
        const lastParsed = parsed[parsed.length - 1]!;
        this.rangeBuffer.push(...points);
        this.flushRanges(rangeSizeFor(lastItem.tip, lastPoint.slot, lastParsed.isByron, this.maxRangeBlocks()));
    }

    private maxRangeBlocks(): number {
        return clampMaxRangeBlocks(this.config.blockFetchBatch?.maxRangeBlocks);
    }

    private headerLookahead(): number {
        const n = Number(this.config.blockFetchBatch?.headerLookahead ?? this.securityParamKSync());
        return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 2160;
    }

    /**
     * Hand full ranges of `size` points to the scheduler. A partial tail stays buffered
     * for the next batch; the idle timer flushes it with `size = 1` (a slow header
     * stream must never leave bodies undownloaded).
     */
    private flushRanges(size: number): void {
        if (this.stopping) return;
        const n = Math.max(1, size);
        while (this.rangeBuffer.length >= n) {
            const chunk = this.rangeBuffer.splice(0, n);
            this.ensureScheduler().submit(chunk).applied.catch(() => undefined); // surfaced via onFatal
        }
        if (this.rangeFlushTimer) clearTimeout(this.rangeFlushTimer);
        this.rangeFlushTimer = null;
        if (this.rangeBuffer.length > 0) {
            // Far behind the tip (large target range) a partial range is only worth
            // flushing after a real stall; near the tip flush quickly for latency.
            const flushMs = n >= 16 ? 1000 : Math.max(20, Number(this.config.blockFetchBatch?.flushMs ?? 25) * 8);
            this.rangeFlushTimer = setTimeout(() => {
                this.rangeFlushTimer = null;
                if (this.rangeBuffer.length > 0) this.flushRanges(1);
            }, flushMs);
        }
    }

    private discardRangeBuffer(): void {
        this.rangeBuffer.length = 0;
        if (this.rangeFlushTimer) clearTimeout(this.rangeFlushTimer);
        this.rangeFlushTimer = null;
    }

    /** Pause a verifier's stream while it has more than ¾·k headers waiting for the primary to catch up. */
    private async waitForVerifierRoom(peerKey: string): Promise<void> {
        const cap = Math.floor(this.candidates.fragmentDepth * 0.75);
        while (this.candidates.pendingCount(peerKey) > cap) {
            if (this.halted || this.stopping || !this.peerByKey(peerKey) || this.candidates.roleOf(peerKey) !== "verifier") return;
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    /**
     * Block the primary's header stream while `headerLookahead` validated headers await
     * bodies. With hysteresis: once the cap is hit, wait until two full ranges of room
     * exist, otherwise headers trickle in as single ranges apply and every range cut
     * from the buffer ends up small (seen as ~27-block ranges at a 128 target).
     */
    private async waitForHeaderRoom(peerKey: string): Promise<void> {
        const cap = this.headerLookahead();
        if (this.pendingHeaders.size < cap) return;
        const resumeBelow = Math.max(1, cap - 2 * this.maxRangeBlocks());
        while (this.pendingHeaders.size > resumeBelow) {
            if (this.halted || this.stopping || this.candidates.primary() !== peerKey || !this.peerByKey(peerKey)) return;
            await new Promise((r) => setTimeout(r, 25));
        }
    }

    // ───────────────────────────── apply stage ─────────────────────────────

    /**
     * Apply one verified range, strictly in chain order, as ONE SQLite transaction.
     *
     * Every ledger write of the range (UTxO, certificates, indexes, nonces, block and
     * header rows) commits together: a range is either fully applied or absent from
     * the DB. The hundreds of implicit autocommits per block were the largest
     * per-block cost on dense chains. Bun's SQLite adapter runs statements issued on
     * the shared `sql` handle inside the open transaction, so apply* need no handle
     * threading; the price is that a second `sql.begin` on that connection throws,
     * hence `dbMutations` serialises this with `rollbackChainTo`.
     */
    private async applyRange(points: RangePt[], blocks: BlockFetchBlock[], fetchedFrom: string): Promise<void> {
        if (this.stopping) return; // shutdown: nothing new is applied
        await this.dbMutations.run(async () => {
            if (this.stopping) return;
            this.batchHeaderRecords.clear();
            try {
                await sql.begin(async () => {
                    await this.applyRangeBlocks(points, blocks, fetchedFrom);
                    await this.persistNonceSnapshot();
                    const tIns = performance.now();
                    await insertHeaderBatchVolatile(Array.from(this.batchHeaderRecords.values()));
                    this.profile.add("blk.insert", performance.now() - tIns);
                });
            } catch (err) {
                // The transaction rolled back: nothing from this range is in the DB. In-memory
                // state that advanced with it must follow, exactly as after a chain rollback,
                // or a retry would skip blocks (dedupe LRU) or evolve the nonce twice.
                this.afterFailedRange();
                throw err;
            } finally {
                this.batchHeaderRecords.clear();
            }
        });
    }

    /**
     * sync.skipIndexWhileBehind: keep the MiniBF forward index off the hot path while
     * more than one epoch (per-network epoch length) behind the primary's tip; back on
     * near the tip. The db module owns the flag; its setter reports transitions.
     */
    private updateIndexSkip(first: RangePt): void {
        if (!this.config.sync?.skipIndexWhileBehind) return;
        const tip = this.pendingHeaders.get(first.hash)?.item.tip;
        if (tip == null) return;
        const behind = tip > first.slot ? tip - first.slot : 0n;
        const shouldSkip = behind > epochLengthSlots(epochForSlot(first.slot));
        if (setBulkSyncIndexSkip(shouldSkip)) {
            logger.warn(
                shouldSkip
                    ? `Forward index (MiniBF) paused: ${behind} slots behind the tip; run scripts/backfill-minibf.mjs after catch-up`
                    : `Forward index (MiniBF) resumed: ${behind} slots behind the tip`,
            );
        }
    }

    /** Drop in-memory state derived from applied blocks after a range's transaction rolled back. */
    private afterFailedRange(): void {
        this.lastBlockNo = null; // re-read from the DB
        this.nonceSnapshotDue = null;
        this.nonceEvolver?.reset();
        this.epochNonceCache.clear();
        this.lastByronTipHash = null;
        this.forgetApplied();
        this.byronObft = null;
        this.byronObftInit = null;
    }

    /** The per-block loop of `applyRange`; runs inside the range's transaction. */
    private async applyRangeBlocks(points: RangePt[], blocks: BlockFetchBlock[], fetchedFrom: string): Promise<void> {
        const bodyPolicy = this.resolveBodyPolicy();
        this.updateIndexSkip(points[0]!);
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
            const identity = this.verifiedIdentities.get(blockMessage) ?? headerIdentityOfBlock(blockMessage.blockData);
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

            if (this.lastBlockNo == null) this.lastBlockNo = await getMaxBlockNo();
            const blockNo = isEbb ? null : ++this.lastBlockNo;
            await this.profile.timeAsync("blk.apply", () => applyBlock(multiEraBlock.block as MultiEraBlock["block"], blockSlot, blockHeaderHash, undefined, blockNo));
            this.rememberApplied(blockHash);
            this.blocksApplied++;
            const nowTs = Date.now();
            this.applyTimestamps.push(nowTs);
            while (this.applyTimestamps.length && nowTs - this.applyTimestamps[0]! > 10_000) this.applyTimestamps.shift();
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
                        const issuerKh = pending?.parsedHeader.byronSig?.issuerKeyHash;
                        this.profile.time("blk.obft", () => {
                            const body = ConsensusOrchestrator.byronRawBody(blockMessage.blockData);
                            if (issuerKh) this.byronObft!.noteAppliedIssuer(issuerKh, blockSlot, body);
                            else this.byronObft!.noteApplied(headerBytes, blockSlot, body);
                        });
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
            // One row per block, the bytes as received (`[era, block]`), written inside the
            // range's transaction so tip queries during the range already see it.
            await insertBlockVolatile({
                slot: blockSlot,
                blockHash,
                prevHash: getHeaderPrevHashHex(blockHeader),
                blockNo,
                headerData: headerBytes,
                blockData: blockMessage.blockData,
            });
            this.profile.add("blk.insert", performance.now() - tEnc);
            // Header rows are flushed once per range by applyRange (same transaction).
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
                    points.length,
                );
            this.profile.add("blk.emit", performance.now() - tEmit);
        }
    }

    /** Security parameter k (blocks): a rollback deeper than this is not a fork, it is an attack or a broken peer. */
    private async securityParamK(): Promise<number> {
        if (this.kCached != null) return this.kCached;
        try {
            const g = await getShelleyGenesisConfig(this.config);
            const k = Number((g as { securityParam?: number } | null)?.securityParam);
            if (Number.isFinite(k) && k > 0) {
                this.kCached = k;
                return k;
            }
        } catch {
            /* fall through */
        }
        this.kCached = 2160;
        return 2160;
    }

    private kCached: number | null = null;

    /** k when already known (the genesis file is read once at startup); 2160 otherwise. */
    private securityParamKSync(): number {
        if (this.kCached == null) void this.securityParamK();
        return this.kCached ?? 2160;
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
                    const counts = await this.dbMutations.run(() => rollbackChainTo(rollbackSlot));
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
                const counts = await this.dbMutations.run(() => rollbackChainTo(pointSlot));
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
