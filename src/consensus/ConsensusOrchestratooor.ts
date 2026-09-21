import type { BlockWitnessResult, HeaderValidationResult } from "./workers/validationJob";
import type { TicknResult } from "../utils/nonceEvolver";
import { nonceFactsOf } from "../utils/nonceReplay";
import { logger } from "../utils/logger";
import type { BlockStore } from "../storage/blockStore";
import { blockStoreMode, noteSelectedTip } from "../storage/nodeBlockStore";
import { getSelectedTipHash, rollbackSelectedTip, setSelectedTipHash, tipHashes } from "../storage/blockReads";
import { ledgerAbortRange, ledgerAfterRange, ledgerBeginBlock, ledgerGovReads, ledgerStoreBroken, ledgerCommitBlock, ledgerDualVerify, ledgerRollbackTo, ledgerStoreMode } from "../ledger/nodeLedgerStore";
import { sql } from "../sql";
import { SerializedMutationQueue } from "./SerializedMutationQueue";
import {
    blockFetchHeaderIdentity as headerIdentityOfBlock,
    blockParser,
    headerParser,
    type HeaderSummary,
    type ParsedHeader,
    localRollForwardMessage,
} from "./blockHeaderParser";
import { validateBlock, recordPlutusShadow } from "./BlockBodyValidator";
import { validateHeader } from "./BlockHeaderValidator";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import {
    BlockFetchBlock,
    ChainPoint,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { prettyBlockValidationLog } from "../tui";
import { getEpochNetwork, calculatePreProdCardanoEpoch, epochForSlot, epochLengthSlots } from "../utils/epochFromSlotCalculations";
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
    blockExists,
    getBlockByHash,
    getBlockBySlot,
    getBlockListRowByHash,
    getLastBlockBefore,
    getEpochNonceStart,
    storeEpochNonceStart,
    storedBlocksInSlotRange,
    setStrictUtxoApply,
    getEpochNonce as dbGetEpochNonce,
    getEpochNonceState,
    getMaxSlot,
    getMaxBlockNo,
    blockAtSlot,
    blockHashesAbove,
    VOLATILE_GC_K,
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
    discardPendingUtxoWrites,
    resetRecentOutputs, dropPointerStakeForConway, getChainTip } from "../db";
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
import { LeaderChecker, type LeaderVerdict } from "./rules/leaderCheck";
import { applyPendingMir, noteBlockMade, poolsMissingFromSnapshot, promotePendingPoolParams, refreshPotSnapshot, creditRegisteredAccounts, refundPoolDeposits, retirePoolsAtEpochDetailed, seedGenesisDelegs, setOpcertCounter, takeStakeSnapshot } from "../db/leaderState";
import { deriveNextEpochParams } from "./pparams";
import { runEpochRewards } from "./epochRewards";
import { enactPending, ratifyForNext, seedGovernance } from "./governance/state";
import { applyEraGenesis, diffRawParams, eraGenesisFilesFor, repairLocalEpochParams } from "./pparams";
import { creditRewards, resetOpcertCounterCache, updateRewardPots } from "../db/leaderState";
import { epochParamsFromGenesis, readEpochParamsRaw, readEpochParamsSource, storeEpochParams } from "./epochParams";
import { firstSlotOfEpoch, shelleyStartEpoch } from "../utils/epochFromSlotCalculations";
import { prevHashToNonce } from "../utils/calcEpochNonce";
import { mergeCostModels, type RawCostModels } from "./governance/costModelUpdate";
import { SHADOW_SAMPLE_EVERY } from "./rules/plutusEval";
import type { UtxoRow } from "../db/rulesQueries";
import { pruneLedgerJournal, setApplyBlock, withJournalingOff } from "../db/ledgerJournal";
import { blake2b_224 } from "@harmoniclabs/crypto";
import { assertBlockRangeMatches } from "./blockRange";
import { splitEraBlock } from "./bodyHash";
import { clampMaxRangeBlocks, rangeSizeFor } from "./rangeSizing";
import { ByronObftState } from "./byron/ByronOBFT";
import { getByronGenesisConfig } from "../utils/paths";
import { Cbor, CborArray, CborBytes, CborTag, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { CandidateSet, type PeerAgreement, type PeerRole } from "./CandidateSet";
import { RangeMismatch, RangeScheduler, type RangeSchedulerStats } from "./RangeScheduler";
import { ValidationPool, resolveWorkerCount } from "./workers/ValidationPool";
import { getEpochBodyParams, type EpochBodyParams } from "./epochParams";
import { applyOverlays, gatherShelleyBlockInputs, shelleyBlockOverlay, shelleyBlockReads, type BlockOverlay, type BlockRuleOutcome } from "./rules/blockRules";
import type { BlockRulesResult } from "./workers/validationJob";
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
    /** Epoch η0 hex; empty for Byron, and empty while the VRF check is deferred. */
    nonce: string;
    /** VRF proofs / leader rule not verified yet: `verifyDeferredVrf` clears it before the block applies. */
    vrfDeferred?: boolean;
}

/** A header accepted with its VRF check postponed until its epoch's nonce is derivable. */
interface DeferredVrfHeader {
    item: RollForwardBatchItem;
    peerKey: string;
    slot: bigint;
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

/**
 * A block our libraries cannot decode. It already passed the header-hash, body-hash and
 * peer-agreement checks, i.e. it is the block the network accepted and the Haskell
 * nodes decoded — so this is OUR decoder's bug (e.g. bug 52: duplicate mint policy
 * keys), never bad data from the peer. Halts the sync like a strict rule failure.
 */
export class BlockDecodeFailure extends BodyValidationFailure {
    constructor(slot: bigint, hash: string, readonly cause: string) {
        super(slot, hash, `undecodable by our ledger library: ${cause}`);
        this.name = "BlockDecodeFailure";
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
    /** Worker-thread heaps (bytes, heapUsed per worker) from the last sampling, for memory diagnostics. */
    workerHeaps: number[] | null;
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
    private static readonly LEADER_VERDICT_LRU = 16384;
    /** Longest a header batch waits for the applier to make the next epoch's nonce derivable. */
    private static readonly NONCE_HOLD_MAX_MS = 15 * 60_000;
    private readonly nonceHoldWarnedAt = new Map<number, number>();
    /**
     * Headers of an epoch whose nonce is not derivable yet are accepted with their VRF /
     * leader checks deferred (KES, op-cert and chaining verified now), so bodies keep
     * flowing to the applier instead of the header stream stalling at every boundary
     * (bug 69: ~30 s per epoch). Opt-out: GEROLAMO_DEFER_VRF=0 falls back to holding.
     */
    private static readonly DEFER_VRF = process.env.GEROLAMO_DEFER_VRF !== "0";
    private readonly deferredVrf = new Map<number, Map<string, DeferredVrfHeader>>(); // epoch → header hash → header
    private readonly deferredVrfRuns = new Map<number, Promise<void>>();
    private readonly deferredVrfFailed = new Set<string>();
    private readonly deferredVrfLogged = new Set<number>();
    private lastDeferredVrfKick = 0;
    /** Leader-rule verdicts by header hash (see processRollForwardBatch). */
    private readonly leaderVerdicts = new Map<string, Awaited<ReturnType<LeaderChecker["check"]>>>();
    private readonly leaderVerdictOrder: string[] = [];
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
    private haltDropLogged = false;
    /** Last header accepted from the primary (hash hex); null = re-anchor on the DB tip. */
    private lastAccepted: { slot: bigint; hash: string } | null = null;
    /** Main-thread header rules with ledger state (overlay schedule, pool registration, stake). */
    private leaderChecker: LeaderChecker | null = null;
    private leaderCheckerInit: Promise<LeaderChecker | null> | null = null;
    private leaderReports = 0;
    private readonly peekLogged = new Set<number>();
    /** Epoch of the last applied Shelley+ block; a higher epoch triggers the boundary work. */
    private lastAppliedEpoch: number | null = null;
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
    /** Witness verdicts per fetched block, started when the range arrives so the apply loop never waits on the pool per block. */
    private readonly preWitness = new WeakMap<BlockFetchBlock, Promise<BlockWitnessResult>>();

    constructor(
        config: GerolamoConfig,
        peers: PeerAccessor,
    ) {
        this.config = config;
        this.peers = peers;
        this.pool = new ValidationPool(resolveWorkerCount(config.validation?.workers));
        this.startWorkerHeapSampling();
        // A complete ledger has every input a block spends; a missing one is a bug or a
        // fork, never something to skip. Tip sync keeps the tolerant apply.
        setStrictUtxoApply(resolveValidationPolicy(config).ledgerComplete);
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
            const tipRow = await getLastBlockBefore(Number.MAX_SAFE_INTEGER);
            const tipSlot = tipRow?.slot ?? -1;
            const shelleyStart = Number(shelleyStartEpoch());
            const start = epoch > shelleyStart ? await getEpochNonceStart(epoch) : null;
            if (start) {
                // ηh carried into this epoch: the previous hash of the last block of epoch − 1.
                const firstSlot = Number(firstSlotOfEpoch(epoch));
                // A snapshot-imported state (import-state) is the evolver's state at start_slot,
                // with ηh recorded: replay only the headers after it.
                const fromSlot = start.startSlot != null ? start.startSlot + 1 : firstSlot;
                let etaHHex = start.startSlot != null ? start.labHex : null;
                if (etaHHex == null) {
                    const last = await getLastBlockBefore(firstSlot);
                    etaHHex = last?.prevHash ? toHex(prevHashToNonce(fromHex(last.prevHash))) : null;
                }
                evolver.bootstrap(epoch, eta0Hex, { etaVHex: start.etaVHex, etaCHex: start.etaCHex, etaHHex });
                const n = await this.replayStoredHeaders(evolver, fromSlot, tipSlot);
                logger.info(`NonceEvolver restored from the epoch ${epoch} start state and ${n} stored header(s)${etaHHex ? " (ηh from the previous epoch's last block)" : ""}`);
            } else {
                // No epoch-start state (DB from before it was recorded, or the first Shelley
                // epoch): replay from the Shelley start, where ηv = ηc = η0.
                const eta0Start = epoch === shelleyStart ? eta0Hex : await dbGetEpochNonce(shelleyStart).catch(() => null);
                if (!eta0Start) {
                    evolver.bootstrap(epoch, eta0Hex);
                    logger.warn(`NonceEvolver bootstrapped ηv=ηc=η0 for epoch ${epoch} (no epoch-start state and no η0 for epoch ${shelleyStart})`);
                    return;
                }
                evolver.bootstrap(shelleyStart, eta0Start);
                const firstSlot = Number(firstSlotOfEpoch(shelleyStart));
                const t0 = performance.now();
                const n = await this.replayStoredHeaders(evolver, firstSlot, tipSlot);
                logger.info(`NonceEvolver rebuilt from the Shelley start: ${n} stored header(s) replayed in ${((performance.now() - t0) / 1000).toFixed(1)}s (now epoch ${evolver.getEpoch()})`);
            }
        } catch (err: unknown) {
            logger.warn(
                `NonceEvolver bootstrap failed for epoch ${epoch}:`,
                err,
            );
        }
    }

    /** UPDN every stored Shelley+ block in [fromSlot, toSlot] into `evolver`; TICKNs on the way persist their η0 and start state. */
    private readonly protocolMajorCache = new Map<number, number>();
    /** Withdrawals and deposit refunds decided at this boundary, credited after its snapshot (bug 95). */
    private pendingBoundaryCredits: { withdrawals: Map<string, bigint>; refunds: Map<string, bigint> } | null = null;

    /**
     * Bug 91: payouts reach registered accounts only; the unclaimed part stays in (withdrawals)
     * or goes to (deposit refunds) the treasury, as in the Conway EPOCH rule.
     */
    private async applyBoundaryCredits(epoch: number): Promise<void> {
        const credits = this.pendingBoundaryCredits;
        this.pendingBoundaryCredits = null;
        if (!credits) return;
        try {
            if (credits.withdrawals.size) {
                const w = await creditRegisteredAccounts(sql, credits.withdrawals);
                if (w.credited > 0n) await updateRewardPots(sql, { reserves: 0n, treasury: -w.credited, resetFees: false });
                if (w.unclaimed > 0n) logger.info(`Epoch ${epoch} governance: ${w.unclaimed} lovelace of treasury withdrawals unclaimed (account(s) not registered: ${w.unregistered.map((a) => a.slice(0, 12) + "…").join(", ")})`);
            }
            if (credits.refunds.size) {
                const r = await creditRegisteredAccounts(sql, credits.refunds);
                if (r.unclaimed > 0n) {
                    await updateRewardPots(sql, { reserves: 0n, treasury: r.unclaimed, resetFees: false });
                    logger.info(`Epoch ${epoch} governance: ${r.unclaimed} lovelace of deposits to the treasury (return account(s) not registered: ${r.unregistered.map((a) => a.slice(0, 12) + "…").join(", ")})`);
                }
            }
            // The epoch's pot record must show the treasury after these moves (Koios' epoch
            // treasury includes the EPOCH rule's withdrawals and unclaimed deposits).
            if (credits.withdrawals.size || credits.refunds.size) await refreshPotSnapshot(sql, epoch);
        } catch (err) {
            logger.warn(`Epoch ${epoch}: boundary credits failed:`, err);
        }
    }

    /** Protocol major version in force during `epoch` (stored epoch parameters), or null when not yet known. */
    private async protocolMajorForEpoch(epoch: number): Promise<number | null> {
        const cached = this.protocolMajorCache.get(epoch);
        if (cached !== undefined) return cached;
        try {
            const raw = await readEpochParamsRaw(epoch);
            const major = raw?.protocol_major_ver;
            if (major == null || !Number.isFinite(Number(major))) return null;
            this.protocolMajorCache.set(epoch, Number(major));
            return Number(major);
        } catch {
            return null;
        }
    }

    /** Tell the evolver which protocol version `epoch` runs (Conway freezes the candidate nonce at 4k/f, not 3k/f). */
    private async primeEvolverProtocol(evolver: NonceEvolver, epoch: number): Promise<void> {
        evolver.setProtocolMajor(epoch, await this.protocolMajorForEpoch(epoch));
    }

    private async replayStoredHeaders(evolver: NonceEvolver, fromSlot: number, toSlot: number): Promise<number> {
        let n = 0;
        if (toSlot < fromSlot) return 0;
        let pvEpoch = -1;
        for await (const row of storedBlocksInSlotRange(fromSlot, toSlot)) {
            const f = nonceFactsOf(row);
            if (!f) continue;
            const e = Number(epochForSlot(f.slot));
            if (e !== pvEpoch) {
                pvEpoch = e;
                await this.primeEvolverProtocol(evolver, e);
            }
            const tickns = evolver.processBlock(f.slot, f.bnonce, f.prevHash);
            for (const t of tickns) await this.recordTickn(t);
            n++;
        }
        return n;
    }

    /** Persist a TICKN result (η0, source local, and the epoch-start ηv/ηc for later replays). */
    private async recordTickn(t: TicknResult): Promise<void> {
        const known = this.epochNonceCache.get(t.epoch) ?? (await dbGetEpochNonce(t.epoch).catch(() => null));
        if (known && known.toLowerCase() !== t.eta0Hex.toLowerCase()) {
            logger.error(`NonceEvolver disagrees for epoch ${t.epoch}: computed ${t.eta0Hex.slice(0, 16)}…, known ${known.slice(0, 16)}…; keeping the known value (evolver state suspect)`);
            this.nonceEvolver?.reset();
            return;
        }
        this.epochNonceCache.set(t.epoch, t.eta0Hex);
        try {
            await storeEpochNonce(t.epoch, t.eta0Hex, "local", t.etaVHex, t.etaCHex);
            await storeEpochNonceStart(t.epoch, t.etaVHex, t.etaCHex);
            logger.info(`TICKN η0_${t.epoch}=${t.eta0Hex.slice(0, 16)}… (blocks=${t.nBlocksPrev} freeze=${t.nBeforeFreeze})`);
        } catch (storeErr: unknown) {
            logger.warn(`Failed to persist TICKN η0 for epoch ${t.epoch}:`, storeErr);
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
            await this.primeEvolverProtocol(evolver, epoch);
            const tickns = evolver.processBlock(slot, bnonce, prevHash);
            for (const t of tickns) await this.recordTickn(t);

            // ηv/ηc for mid-chain resume are persisted once per range (persistNonceSnapshot),
            // not per block: a range commits atomically, so the two are equivalent.
            if (tickns.length === 0) this.nonceSnapshotDue = { eta0Hex };
        } catch (err: unknown) {
            logger.warn("NonceEvolver feed failed:", err);
        }
    }

    /** Hashes (hex) at the DB tip slot: a Byron EBB shares its slot with the epoch's first block. */
    private async dbTipHashes(): Promise<string[] | null> {
        if (blockStoreMode() === "primary" && this.blockStore) return tipHashes(this.blockStore);
        const maxSlot = await getMaxSlot();
        if (maxSlot <= 0n) return null;
        const rows = (await sql`SELECT hash FROM blocks WHERE slot = ${maxSlot}`.values()) as unknown[];
        const hashes = rows.map((r: any) => {
            const h = Array.isArray(r) ? r[0] : r?.hash;
            return h instanceof Uint8Array ? toHex(h) : String(h ?? "").toLowerCase();
        }).filter((h) => h.length === 64);
        return hashes.length ? hashes : null;
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

    /** Nonce rows we derived ourselves; an external value never overrides them. */
    private static readonly LOCAL_NONCE_SOURCES = new Set(["local", "local-genesis", "tickn"]);

    /**
     * True when the local chain derivation is authoritative for `epoch`: we sync
     * from genesis, the evolver is live, or we derived η0 of the previous epoch.
     * An external value must then never be consulted: it may belong to another
     * network or another chain, and a wrong η0 rejects every header of the epoch
     * (preview epoch 9 was once served preprod's nonce by a fallback mirror).
     */
    private async localNonceAuthoritative(epoch: number): Promise<boolean> {
        if ((this.config as any).syncFromGenesis === true) return true;
        if (this.nonceEvolver?.isActive()) return true;
        try {
            const prev = await getEpochNonceState(epoch - 1);
            return !!prev && ConsensusOrchestrator.LOCAL_NONCE_SOURCES.has(prev.source);
        } catch {
            return false;
        }
    }

    /**
     * Re-activate the evolver at the applied tip's epoch after a rollback or a
     * primary switch reset it (the header stage may ask for the next epoch's
     * η0 before any block is applied again).
     */
    private async ensureEvolverAtTip(): Promise<void> {
        const evolver = await this.ensureNonceEvolver();
        if (!evolver || evolver.isActive()) return;
        const tipSlot = await getMaxSlot();
        const tipEpoch = Number(epochForSlot(tipSlot));
        if (tipSlot <= 0n || tipEpoch < Number(shelleyStartEpoch())) return;
        const eta0 = this.epochNonceCache.get(tipEpoch) ?? (await dbGetEpochNonce(tipEpoch).catch(() => null));
        if (!eta0) return;
        await this.ensureEvolverBootstrapped(tipEpoch, eta0);
    }

    /** η0 of `epoch` from the evolver's frozen candidate (headers ahead of the boundary block), or null. */
    /** Slot-leader rule for one validated header, memoised per hash (every verifier re-delivers every header). */
    private async leaderCheck(r: HeaderValidationResult, checker: Awaited<ReturnType<ConsensusOrchestrator["ensureLeaderChecker"]>>): Promise<LeaderVerdict> {
        const tLeader = performance.now();
        const leaderKey = r.hashHex.toLowerCase();
        let v = this.leaderVerdicts.get(leaderKey);
        if (!v) {
            v = await checker!.check({ era: r.era, slot: BigInt(r.slot), epoch: r.epoch, ...r.shelley! });
            this.leaderVerdicts.set(leaderKey, v);
            this.leaderVerdictOrder.push(leaderKey);
            while (this.leaderVerdictOrder.length > ConsensusOrchestrator.LEADER_VERDICT_LRU) {
                const old = this.leaderVerdictOrder.shift();
                if (old) this.leaderVerdicts.delete(old);
            }
            this.profile.add("hdr.leader", performance.now() - tLeader);
        } else {
            this.profile.add("hdr.leader.hit", performance.now() - tLeader);
        }
        if (v.ok && v.reports.length) {
            this.leaderReports += v.reports.length;
            if (this.leaderReports <= 20 || this.leaderReports % 500 === 0) {
                logger.info(`Leader rule report at slot ${r.slot}: ${v.reports.join(" | ")} (reports so far: ${this.leaderReports})`);
            }
        }
        return v;
    }

    /** Remember the headers of a batch whose VRF check was deferred, per epoch. */
    private noteDeferredVrf(peerKey: string, items: RollForwardBatchItem[], parsed: HeaderSummary[]): void {
        for (let i = 0; i < parsed.length; i++) {
            const p = parsed[i]!;
            if (!p.vrfDeferred) continue;
            let m = this.deferredVrf.get(p.epoch);
            if (!m) { m = new Map(); this.deferredVrf.set(p.epoch, m); }
            m.set(toHex(p.blockHeaderHash).toLowerCase(), { item: items[i]!, peerKey, slot: p.slot });
            if (!this.deferredVrfLogged.has(p.epoch)) {
                this.deferredVrfLogged.add(p.epoch);
                logger.info(`Epoch ${p.epoch} nonce not derivable yet: accepting its headers with the VRF / leader check deferred (KES, op-cert and chaining verified now)`);
            }
        }
    }

    /** Start verifying deferred headers as soon as their epoch's nonce can be derived (cheap check, at most every 500 ms). */
    private maybeKickDeferredVrf(): void {
        if (this.deferredVrf.size === 0) return;
        const now = Date.now();
        if (now - this.lastDeferredVrfKick < 500) return;
        this.lastDeferredVrfKick = now;
        for (const epoch of [...this.deferredVrf.keys()].sort((a, b) => a - b)) {
            if (this.deferredVrfRuns.has(epoch)) continue;
            void this.peekLocalNonce(epoch).then((eta0) => {
                if (eta0 && this.deferredVrf.has(epoch) && !this.deferredVrfRuns.has(epoch)) void this.verifyDeferredVrf(epoch).catch(() => undefined);
            }).catch(() => undefined);
            break; // one epoch at a time, in order
        }
    }

    /**
     * Verify the VRF proofs and the leader rule of every header of `epoch` accepted with the
     * check deferred. Memoised per epoch; waits (bounded) for the nonce when called early.
     * Failures mark the header (the applier refuses it) and terminate the peer that sent it.
     */
    private verifyDeferredVrf(epoch: number): Promise<void> {
        let run = this.deferredVrfRuns.get(epoch);
        if (run) return run;
        run = (async () => {
            const headers = this.deferredVrf.get(epoch);
            if (!headers || headers.size === 0) { this.deferredVrf.delete(epoch); return; }
            const t0 = performance.now();
            let eta0 = await this.getEpochNonce(epoch);
            while (!eta0 && !this.stopping && performance.now() - t0 < ConsensusOrchestrator.NONCE_HOLD_MAX_MS) {
                await new Promise<void>((r) => setTimeout(r, 250));
                eta0 = await this.getEpochNonce(epoch);
            }
            if (!eta0) throw new Error(`epoch ${epoch} nonce still not derivable after ${Math.round((performance.now() - t0) / 1000)} s; ${headers.size} deferred header(s) cannot be verified`);
            const pool = this.pool;
            if (!pool) return;
            const entries = [...headers.entries()];
            this.deferredVrf.delete(epoch);
            const checker = await this.ensureLeaderChecker();
            let failed = 0;
            const CHUNK = 256;
            for (let i = 0; i < entries.length; i += CHUNK) {
                const chunk = entries.slice(i, i + CHUNK);
                const results = await pool.validateAll(chunk.map(([, h]) => ({
                    rollForward: h.item.rollForwardCborBytes,
                    nonceHex: "",
                    noncesByEpoch: { [String(epoch)]: eta0! },
                    config: { networkMagic: this.config.networkMagic, shelleyGenesisFile: this.config.shelleyGenesisFile, network: getEpochNetwork() },
                })));
                for (let j = 0; j < results.length; j++) {
                    const r = results[j]!, [hash, h] = chunk[j]!;
                    let reason: string | null = r.ok ? null : (r.reason ?? "invalid");
                    if (!reason && r.shelley && checker) {
                        const v = await this.leaderCheck(r, checker);
                        if (!v.ok) reason = v.reason ?? "leader rule failed";
                    }
                    if (reason) {
                        failed++;
                        this.deferredVrfFailed.add(hash);
                        this.pendingHeaders.delete(hash);
                        const peer = this.peerByKey(h.peerKey);
                        const msg = `Deferred header check failed at slot ${h.slot} hash=${hash}: ${reason}`;
                        if (peer) { try { this.terminateMalicious(peer, msg); } catch { /* terminateMalicious throws to abort the caller's batch */ } }
                        else logger.error(`${msg} (peer ${h.peerKey} already gone)`);
                        continue;
                    }
                    const pending = this.pendingHeaders.get(hash);
                    if (pending) { pending.nonce = eta0!; pending.vrfDeferred = false; }
                }
            }
            logger.info(`Epoch ${epoch}: verified the VRF / leader rule of ${entries.length} deferred header(s) in ${Math.round(performance.now() - t0)} ms${failed ? `, ${failed} failed` : ""}`);
            this.profile.add("hdr.vrf.deferred", performance.now() - t0);
        })();
        this.deferredVrfRuns.set(epoch, run);
        run.catch((err) => logger.error(`Deferred VRF verification for epoch ${epoch} failed:`, err)).finally(() => {
            // keep the memo while headers of this epoch can still arrive deferred; drop it once none remain
            if (!this.deferredVrf.has(epoch)) setTimeout(() => this.deferredVrfRuns.delete(epoch), 60_000);
        });
        return run;
    }

    private async peekLocalNonce(epoch: number): Promise<string | null> {
        await this.ensureEvolverAtTip();
        const evolver = this.nonceEvolver;
        if (!evolver?.isActive() || epoch !== evolver.getEpoch() + 1) return null;
        return evolver.peekNextEpochNonceHex(await getMaxSlot());
    }

    /**
     * Resolve epoch η0 for header VRF: in-memory cache → locally derived SQLite
     * row (epoch_nonces) → the evolver's frozen candidate for the next epoch →
     * Shelley genesis hash for the first epoch → external (only when the local
     * derivation is not authoritative; reported).
     */
    private async getEpochNonce(epoch: number): Promise<string | null> {
        const cached = this.epochNonceCache.get(epoch);
        if (cached) return cached;

        let external: string | null = null;
        try {
            const row = await getEpochNonceState(epoch);
            if (row?.nonce_hex) {
                if (ConsensusOrchestrator.LOCAL_NONCE_SOURCES.has(row.source)) {
                    this.epochNonceCache.set(epoch, row.nonce_hex);
                    logger.debug(`DB hit for epoch nonce ${epoch}`);
                    return row.nonce_hex;
                }
                external = row.nonce_hex; // re-derived below whenever the evolver can
            }
        } catch (error: unknown) {
            logger.warn(`Local epoch nonce read failed for ${epoch}:`, error);
        }

        // Next epoch, headers ahead of the boundary block: the evolver already knows
        // η0 once the candidate nonce is frozen. Not cached: the boundary's TICKN
        // writes the final value (and would report a disagreement).
        const peek = await this.peekLocalNonce(epoch);
        if (peek) {
            if (!this.peekLogged.has(epoch)) {
                this.peekLogged.add(epoch);
                logger.info(`Epoch ${epoch} nonce derived ahead of the boundary from the local evolver`);
            }
            if (external) {
                if (external !== peek) {
                    logger.warn(
                        `Epoch ${epoch} nonce stored from an external source (${external.slice(0, 12)}…) disagrees with the local derivation (${peek.slice(0, 12)}…); using the local value`,
                    );
                }
                try {
                    await storeEpochNonce(epoch, peek, "local");
                } catch { /* the boundary TICKN persists it regardless */ }
            }
            return peek;
        }
        // First Shelley epoch: η0 is the Shelley genesis hash (checked against the
        // mainnet epoch 208 nonce). Later epochs come from the local evolver.
        const genesisHash = String((this.config as any).shelleyGenesisHash ?? "").toLowerCase();
        if (epoch === Number(shelleyStartEpoch()) && /^[0-9a-f]{64}$/.test(genesisHash)) {
            this.epochNonceCache.set(epoch, genesisHash);
            try {
                await storeEpochNonce(epoch, genesisHash, "local-genesis");
            } catch { /* cache is enough */ }
            return genesisHash;
        }
        if (await this.localNonceAuthoritative(epoch)) {
            const evolver = this.nonceEvolver;
            if (epoch === Number(shelleyStartEpoch())) {
                logger.error(`Epoch ${epoch} is the first Shelley epoch but the config carries no valid shelleyGenesisHash (η0 = Shelley genesis hash); from-genesis sync cannot proceed`);
                return null;
            }
            // held batches poll every 250 ms: say it once per 30 s per epoch
            const lastWarn = this.nonceHoldWarnedAt.get(epoch) ?? 0;
            if (Date.now() - lastWarn > 30_000) {
                this.nonceHoldWarnedAt.set(epoch, Date.now());
                logger.warn(
                    `Epoch ${epoch} nonce not derivable yet (applied tip slot ${await getMaxSlot()}, evolver ${evolver?.isActive() ? `epoch ${evolver.getEpoch()}` : "inactive"}); the header batch waits for the applier instead of an external value`,
                );
            }
            return null;
        }
        if (external) {
            this.epochNonceCache.set(epoch, external);
            return external;
        }
        try {
            const nonce = await blockFrostFetchEra(this.config, epoch);
            logger.warn(`Epoch ${epoch} nonce taken from an external source (the local evolver had no value); from-genesis sync derives it locally`);
            this.epochNonceCache.set(epoch, nonce);
            try {
                await storeEpochNonce(epoch, nonce, "external");
            } catch (storeErr: unknown) {
                logger.warn(`Failed to persist epoch ${epoch} nonce to DB:`, storeErr);
            }
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
        this.deferredRollback = null;
        resetOpcertCounterCache(); // the journal restored opcert_counters; the cache must follow
        resetRecentOutputs(); // outputs of the rolled-back blocks are gone from the database
        // ηv/ηc are only valid for the chain they were computed on: rebuild from stored headers.
        this.nonceEvolver?.reset();
        this.lastBlockNo = null; // heights past the rollback point are gone
        this.lastAccepted = null;
        this.pendingHeaders.clear();
        this.discardRangeBuffer();
        this.lastPrimaryByronHeaderHash = null;
        this.scheduler?.reset("rollback");
        this.candidates.reset();
        this.deferredVrf.clear();
        this.deferredVrfFailed.clear();
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
            if (await blockExists(h)) { // existence only: getBlockByHash fetched the whole block blob per header
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
                const anchored = this.candidates.agreement(next)?.status;
                this.candidates.setPrimary(next);
                logger.warn(`Primary ${peerKey} left; ${next} promoted to primary`);
                const succ = this.peerByKey(next);
                if (succ) void this.anchorPromotedPrimary(succ, next, anchored === "agrees" || anchored === "ahead", "promoted to primary; re-anchor on DB tip");
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

    private ensureLeaderChecker(): Promise<LeaderChecker | null> {
        if (this.leaderChecker) return Promise.resolve(this.leaderChecker);
        if (!this.leaderCheckerInit) {
            this.leaderCheckerInit = (async () => {
                try {
                    const genesis = await getShelleyGenesisConfig(this.config as any);
                    await seedGenesisDelegs((genesis as any)?.genDelegs ?? {});
                    await repairLocalEpochParams(eraGenesisFilesFor(this.config), genesis).catch((err) => logger.warn("epoch parameter repair skipped:", err));
                    this.leaderChecker = new LeaderChecker(this.config, genesis);
                    return this.leaderChecker;
                } catch (err) {
                    logger.warn("Leader rules unavailable (no Shelley genesis):", err);
                    return null;
                }
            })();
        }
        return this.leaderCheckerInit;
    }

    /**
     * First block of a Shelley+ epoch is about to be applied: retire pools whose
     * epoch arrived and take the stake snapshot that decides leaders one epoch
     * later. Runs inside the range's transaction.
     */
    private lastYieldAt = 0;

    /**
     * Give the event loop a real turn every ~25 ms of applying. SQLite queries
     * resolve as microtasks, so a range of blocks would otherwise run as one
     * unbroken chain and HTTP handlers (explorer, dashboards, mini-Blockfrost)
     * wait for the whole range; they read from their own connection, so running
     * them mid-transaction is safe.
     */
    private async yieldToEventLoop(): Promise<void> {
        const now = performance.now();
        if (now - this.lastYieldAt < 25) return;
        this.lastYieldAt = now;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private lastWorkerHeaps: number[] | null = null;
    private workerHeapTimer: ReturnType<typeof setInterval> | null = null;

    /** Log the worker-thread heaps every 5 minutes (memory diagnostics: an OOM at 24 GB RSS with a 90 MB main heap). */
    private startWorkerHeapSampling(): void {
        if (this.workerHeapTimer) return;
        this.workerHeapTimer = setInterval(async () => {
            try {
                const heaps = await this.pool?.memory();
                if (!heaps || heaps.length === 0) return;
                this.lastWorkerHeaps = heaps.map((h) => h.heapUsed);
                const total = heaps.reduce((a, h) => a + Math.max(0, h.heapUsed), 0);
                const totalExt = heaps.reduce((a, h) => a + Math.max(0, h.external), 0);
                const mu = process.memoryUsage();
                // rss minus every JS-visible number = native (allocator, sqlite, sockets); that is what grows toward an OOM
                const accounted = mu.heapTotal + mu.external + total + totalExt;
                logger.info(`Memory: rss ${(mu.rss / 2 ** 30).toFixed(2)} GB, main heap ${(mu.heapUsed / 2 ** 20).toFixed(0)} MB, external ${(mu.external / 2 ** 20).toFixed(0)} MB, ${heaps.length} worker heaps ${(total / 2 ** 20).toFixed(0)} MB (max ${(Math.max(...heaps.map((h) => h.heapUsed)) / 2 ** 20).toFixed(0)} MB), worker external ${(totalExt / 2 ** 20).toFixed(0)} MB, unaccounted native ${((mu.rss - accounted) / 2 ** 30).toFixed(2)} GB`);
            } catch { /* diagnostics only */ }
        }, 300_000);
    }

    private async onEpochStart(epoch: number): Promise<void> {
        if (this.lastAppliedEpoch == null) {
            const tipSlot = await getMaxSlot();
            this.lastAppliedEpoch = tipSlot > 0n ? Number(calculatePreProdCardanoEpoch(Number(tipSlot))) : -1;
        }
        if (epoch <= this.lastAppliedEpoch) return;
        const t0 = performance.now();
        const enacted = await this.governanceBoundary(epoch);
        await this.deriveLocalParams(epoch, enacted?.paramChanges ?? {});
        // Ledger order at the boundary: the reward update lands (applyRUpd), then the
        // snapshot is taken (SNAP) with the pool parameters in force during the ending
        // epoch, then pending re-registrations apply and retirements happen (POOLREAP).
        try {
            const genesis = await getShelleyGenesisConfig(this.config as any).catch(() => null);
            if (genesis) await runEpochRewards(epoch, genesis, Number(shelleyStartEpoch()), BigInt(Number((genesis as any).epochLength ?? 432_000)));
        } catch (err) {
            logger.warn(`epoch ${epoch} reward accounting failed:`, err);
        }
        try {
            const mir = await applyPendingMir(sql, epoch);
            if (mir.credited || mir.transferred || mir.dropped) logger.info(`Epoch ${epoch}: MIR applied — ${mir.credited} to reward accounts, ${mir.transferred} between pots, ${mir.dropped} entr(y|ies) dropped (pot too small)`);
        } catch (err) {
            logger.warn(`Epoch ${epoch}: MIR application failed:`, err);
        }
        try {
            // Bug 93: the Babbage→Conway translation drops pointer-address stake before the
            // hard-fork boundary's own snapshot (Koios: the snapshot taken at preview 646 already
            // excludes it; replay 4 dropped it after that snapshot and was 35 553 ADA high there).
            const major = await this.protocolMajorForEpoch(epoch), prevMajor = await this.protocolMajorForEpoch(epoch - 1);
            if (major != null && major >= 9 && prevMajor != null && prevMajor < 9) {
                const dropped = await dropPointerStakeForConway(sql);
                logger.info(`Epoch ${epoch}: Conway translation — pointer-address stake dropped (${dropped.outputs} output(s), ${dropped.lovelace} lovelace)`);
            }
        } catch (err) {
            logger.warn(`Epoch ${epoch}: pointer stake drop failed:`, err);
        }
        const snap = await takeStakeSnapshot(sql, epoch);
        try {
            const missing = await poolsMissingFromSnapshot(epoch);
            if (missing.length) {
                logger.warn(`Epoch ${epoch}: ${missing.length} registered pool(s) with delegations have no stake in the snapshot: ${missing.map((m) => `${m.poolId.slice(0, 12)}… (retiring ${m.retiringEpoch ?? "-"}, ${m.delegators} delegator(s))`).join(", ")}`);
            }
        } catch (err) {
            logger.debug("snapshot diagnostic failed:", err);
        }
        const promoted = await promotePendingPoolParams(sql);
        const retiredPools = await retirePoolsAtEpochDetailed(sql, epoch);
        const retired = retiredPools.length;
        if (retired) {
            // POOLREAP: the pool deposit returns to the reward account (or the treasury).
            try {
                const raw = (await readEpochParamsRaw(epoch)) ?? (await readEpochParamsRaw(epoch - 1)) ?? {};
                const deposit = BigInt(String((raw as any).pool_deposit ?? (raw as any).stakePoolDeposit ?? 0));
                const r = await refundPoolDeposits(sql, retiredPools, deposit);
                logger.info(`Epoch ${epoch}: ${retired} pool(s) retired (${retiredPools.reduce((n, p) => n + p.delegationsRemoved, 0)} delegation(s) removed); deposits ${r.refunded} refunded to reward accounts, ${r.toTreasury} to the treasury`);
            } catch (err) {
                logger.warn(`Epoch ${epoch}: pool deposit refund failed:`, err);
            }
        }
        if (promoted) logger.info(`Epoch ${epoch}: ${promoted} pool re-registration(s) took effect`);
        try {
            await refreshPotSnapshot(sql, epoch); // reserves/treasury as they stand after MIR and POOLREAP
        } catch (err) {
            logger.warn(`Epoch ${epoch}: pot snapshot refresh failed:`, err);
        }
        this.lastAppliedEpoch = epoch;
        this.leaderChecker?.invalidate();
        logger.info(`Epoch ${epoch} begins: stake snapshot taken (${snap.pools} pools, ${snap.total} lovelace active), ${retired} pool(s) retired, ${(performance.now() - t0).toFixed(0)} ms`);
        // The ledger sets up the epoch's DRep pulser here: this boundary's snapshot, this epoch's parameters.
        await this.governanceRatify(epoch);
        await this.applyBoundaryCredits(epoch);
    }

    /**
     * Protocol parameters for a new epoch, locally: the Shelley genesis for the
     * first Shelley epoch, otherwise the previous epoch's record plus any update
     * that reached the genesis-key quorum (Phase 4b). Conway governance changes
     * are not applied yet (Phase 4d); an external record, when one exists, wins.
     */
    private conwayGenesis: any | null | undefined;

    /**
     * Conway governance at the boundary (Phase 4d): seed from the Conway genesis
     * once the era is reached, then ratify and enact proposals using the
     * previous epoch's parameters and stake snapshot. Treasury withdrawals and
     * deposit refunds are credited to reward accounts immediately.
     */
    private async governanceBoundary(epoch: number): Promise<import("./governance/state").EnactmentResult | null> {
        try {
            const prev = await readEpochParamsRaw(epoch - 1);
            const major = Number(prev?.protocol_major_ver ?? 0);
            if (major < 9) return null; // pre-Conway
            if (this.conwayGenesis === undefined) {
                try {
                    const file = String(eraGenesisFilesFor(this.config).conway ?? "");
                    this.conwayGenesis = file ? JSON.parse(await Bun.file(file).text()) : null;
                } catch {
                    this.conwayGenesis = null;
                }
            }
            if (this.conwayGenesis) await seedGovernance(sql, this.conwayGenesis, epoch);
            const gr = ledgerGovReads();
            const already = gr ? (gr.enactedAt(epoch).length ? [[1]] : []) : (await sql`SELECT 1 FROM gov_enacted WHERE epoch = ${epoch}`.values()) as unknown[][];
            const result = await enactPending(sql, epoch);
            // Bug 95: the ledger takes this boundary's stake snapshot before crediting the
            // withdrawals and refunds (Conway EPOCH: SNAP on the old state, refunds in dState'),
            // so they are paid after the snapshot and the DRep tally (applyBoundaryCredits).
            this.pendingBoundaryCredits = { withdrawals: result.withdrawals, refunds: result.refunds };
            if (result.enacted.length || result.expired.length || result.dropped.length) {
                logger.info(`Epoch ${epoch} governance: enacted [${result.enacted.join(", ")}], expired ${result.expired.length}, dropped ${result.dropped.length}, withdrawals ${result.withdrawals.size}, refunds ${result.refunds.size}${already.length ? " (re-run)" : ""}`);
            }
            return result;
        } catch (err) {
            logger.warn(`epoch ${epoch} governance boundary failed:`, err);
            return null;
        }
    }

    private async governanceRatify(epoch: number): Promise<void> {
        try {
            const raw = await readEpochParamsRaw(epoch);
            if (!raw || Number(raw.protocol_major_ver ?? 0) < 9) return; // pre-Conway
            const gr = ledgerGovReads();
            const has = gr ? (gr.state() ? [[1]] : []) : (await sql`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][];
            if (!has.length) return;
            await ratifyForNext(sql, epoch, raw, epoch);
        } catch (err) {
            logger.warn(`epoch ${epoch} governance ratification failed:`, err);
        }
    }

    private async deriveLocalParams(epoch: number, enacted: Record<string, unknown> = {}): Promise<void> {
        try {
            const existingSource = await readEpochParamsSource(epoch);
            if (existingSource === "local" || existingSource === "genesis") return;
            const external = existingSource ? await readEpochParamsRaw(epoch) : null;
            const genesis = await getShelleyGenesisConfig(this.config as any).catch(() => null) as any;
            if (!genesis) return;
            const startEpoch = Number(shelleyStartEpoch());
            if (epoch <= startEpoch) {
                const g = epochParamsFromGenesis(epoch, genesis);
                const seeded: Record<string, unknown> = { ...g.raw, epoch };
                // A network whose Shelley genesis already sits in Alonzo or later (preview: 6) never
                // crosses the era transition that merges the Alonzo/Conway genesis files; merge them
                // here so every derived record is complete without the startup repair (bug 86).
                await applyEraGenesis(seeded, 0, eraGenesisFilesFor(this.config));
                await storeEpochParams(epoch, seeded, "genesis");
                logger.info(`Protocol parameters for epoch ${epoch} seeded from the Shelley genesis`);
                return;
            }
            const prev = await readEpochParamsRaw(epoch - 1);
            if (!prev) return; // no local chain of records; the reader falls back and reports
            const quorum = Number(genesis.updateQuorum ?? 5);
            const { raw } = await deriveNextEpochParams(prev, epoch, quorum);
            if (Object.keys(enacted).length) {
                const { cost_models: cmUpdate, ...rest } = enacted as Record<string, unknown> & { cost_models?: RawCostModels };
                Object.assign(raw, rest);
                // Conway replaces only the languages the action names; the others carry over.
                if (cmUpdate) raw.cost_models = mergeCostModels(raw.cost_models, cmUpdate);
                logger.info(`Protocol parameters for epoch ${epoch}: governance enactment applied (${Object.keys(enacted).join(", ")})`);
            }
            await applyEraGenesis(raw, Number(prev.protocol_major_ver ?? 0), eraGenesisFilesFor(this.config));
            if (external) {
                // A header-stage fetch got here first: the local derivation replaces it and any
                // disagreement is a verification finding.
                const diffs = diffRawParams(raw, external);
                if (diffs.length) logger.warn(`Protocol parameters for epoch ${epoch}: local derivation disagrees with the external record: ${diffs.join("; ")}`);
                else logger.info(`Protocol parameters for epoch ${epoch}: local derivation matches the external record`);
            }
            await storeEpochParams(epoch, raw, "local");
        } catch (err) {
            logger.warn(`local protocol parameters for epoch ${epoch} not derived:`, err);
        }
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
            workerHeaps: this.lastWorkerHeaps,
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
                    if (err instanceof BlockDecodeFailure) {
                        logger.error(
                            `SYNC HALTED: ${err.message}. The block's header and body hashes verified and peers agree on it, ` +
                                `so our ledger library cannot decode a real block. Peers are not at fault; the ledger is intact. ` +
                                `Fix the decoder (the block is in GEROLAMO_FAILED_BLOCK_DIR) and restart; no resync needed.`,
                        );
                    } else
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
            // A slot battle: the peer switched to the other block of that slot between our header
            // observation and the body fetch, and served the block it now holds. Not bad data — a
            // retryable range failure (open item 15: preview 2026-09-10, two honest relays held
            // cold for an hour each time).
            if (r.gotHash && want) {
                const inFragments = this.candidates.knownAtSlot(want.slot, r.gotHash);
                const ours = inFragments ? null : await blockAtSlot(want.slot);
                const known = inFragments || ours?.hash?.toLowerCase() === r.gotHash.toLowerCase() || this.recentlyRolledBack.has(r.gotHash.toLowerCase());
                if (known) throw new Error(`peer ${peerKey} served the competing block ${r.gotHash.slice(0, 12)}… of slot ${want.slot} (asked for ${want.hash.slice(0, 12)}…): branch switch, retrying elsewhere`);
                logger.warn(`Range from ${peerKey}: block ${r.gotHash.slice(0, 12)}… at slot ${want.slot} is unknown to every fragment (${this.candidates.snapshot().peers.map((p) => `${p.key}:${p.tipHash?.slice(0, 8) ?? "?"}@${p.tipSlot ?? "?"}`).join(" ")}), ours ${ours?.hash?.slice(0, 12) ?? "∅"}`);
            }
            throw new RangeMismatch(
                `peer ${peerKey} block ${i} (slot ${want?.slot} hash=${want?.hash}): ${r.reason ?? "verification failed"}`,
            );
        }
        for (let i = 0; i < blocks.length; i++) {
            const id = r.identities[i]!;
            this.verifiedIdentities.set(blocks[i]!, { era: id.era, hash: fromHex(id.hashHex), rawHeaderBytes: id.rawHeader });
            if (id.era >= 2) {
                // Shelley+: every witness signature of the block verified in parallel across the
                // pool while earlier ranges apply; the apply loop reads the verdicts (blk.prewit).
                this.preWitness.set(blocks[i]!, pool.verifyBlockWitnesses(blocks[i]!.blockData).catch((): BlockWitnessResult => ({ ok: null, count: 0, reason: "worker failed" })));
            }
        }
    }

    // ───────────────────────────── header stage ─────────────────────────────

    private async processRollForwardBatch(
        items: RollForwardBatchItem[],
        peerId: string,
    ): Promise<void> {
        if (this.halted) {
            // Strict validation stopped the applier: validating headers of a chain we will
            // never apply only burns the validation pool. Drop the batch.
            if (!this.haltDropLogged) {
                this.haltDropLogged = true;
                logger.warn(`Sync halted at slot ${this.halted.slot}: incoming headers are dropped until restart`);
            }
            return;
        }
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
            // The stream this batch came from: a ChainSync restart (promotion, re-anchor) makes
            // it stale, and a stale batch must not keep holding the peer's serialized queue.
            const generation = peer.chainSyncGeneration;

            // 1) epoch range from the first and last header only (two parses per batch instead
            //    of one per header; the workers parse each header once, for validation).
            const tParse = performance.now();
            let first = await headerParser(items[0]!.rollForwardCborBytes);
            let last = items.length > 1 ? await headerParser(items[items.length - 1]!.rollForwardCborBytes) : first;
            if (!first || !last) throw new Error(`Header parse failed for peer ${peerId}`);
            this.profile.add("hdr.parse", performance.now() - tParse);

            // A batch entirely behind our applied tip is a re-stream (a peer joining from an old
            // intersection): headers we already hold need no validation, and a header that
            // differs from ours at a slot deeper than k is a dead fork, not misbehaviour. Validating
            // them re-ran the leader check against the live pool registry (the epoch's snapshot is
            // pruned after three epochs) and held an honest verifier as malicious for a pool that
            // had retired since (bug 87, preview slot 18 687 204).
            const appliedTip = await getMaxSlot();
            if (last.slot <= appliedTip && appliedTip > 0n) {
                // height from the indexed tip row: MAX(block_no) scans the table (seconds), and at
                // the tip every re-anchored peer's first batch takes this path
                const tipBlockNo = (await blockAtSlot(appliedTip))?.blockNo ?? 0;
                const kept: RollForwardBatchItem[] = [];
                let held = 0, dead = 0;
                for (const it of items) {
                    const ph = await headerParser(it.rollForwardCborBytes);
                    if (!ph) { kept.push(it); continue; }
                    const ours = await blockAtSlot(ph.slot);
                    if (!ours) { kept.push(it); continue; }
                    if (ours.hash === toHex(ph.blockHeaderHash).toLowerCase()) { held++; continue; }
                    if (tipBlockNo - ours.blockNo >= VOLATILE_GC_K) { dead++; continue; }
                    kept.push(it);
                }
                if (held || dead) logger.debug(`${peerKey}: re-streamed batch behind our tip — ${held} header(s) we hold, ${dead} on a fork deeper than k, ${kept.length} to validate`);
                if (kept.length === 0) return;
                items = kept;
                first = (await headerParser(items[0]!.rollForwardCborBytes))!;
                last = items.length > 1 ? (await headerParser(items[items.length - 1]!.rollForwardCborBytes))! : first;
            }

            // 2) nonces (main thread: DB / network) — one lookup per epoch the batch spans
            const tNonce = performance.now();
            const noncesByEpoch: Record<string, string> = {};
            const deferEpochs = new Set<number>();
            const shelleyEpochs = [first, last].filter((p) => !p.isByron).map((p) => p.epoch);
            if (shelleyEpochs.length > 0) {
                const lo = Math.min(...shelleyEpochs);
                const hi = Math.max(...shelleyEpochs);
                for (let e = lo; e <= hi; e++) {
                    let eta0 = await this.getEpochNonce(e);
                    if (!eta0 && ConsensusOrchestrator.DEFER_VRF && await this.localNonceAuthoritative(e)) {
                        // Not derivable yet (applied tip more than 4k/f slots before the boundary):
                        // validate everything but the VRF now, verify the VRF once the nonce exists.
                        deferEpochs.add(e);
                        continue;
                    }
                    // The batch reaches into an epoch whose nonce the applier has not derived yet
                    // (candidate nonce not frozen: the applied tip is more than 4k/f slots before
                    // the boundary). Hold the batch — ChainSync back-pressure — instead of dropping
                    // the peer: on preview the drop cascaded into one hot peer and 2 blocks/s.
                    const tHold = performance.now();
                    while (!eta0 && !this.stopping && peer.chainSyncGeneration === generation && !peer.isTerminated && performance.now() - tHold < ConsensusOrchestrator.NONCE_HOLD_MAX_MS) {
                        await new Promise<void>((r) => setTimeout(r, 250));
                        eta0 = await this.getEpochNonce(e);
                    }
                    if (eta0 && performance.now() - tHold > 250) this.profile.add("hdr.nonce.hold", performance.now() - tHold);
                    if (!eta0 && (peer.chainSyncGeneration !== generation || peer.isTerminated)) {
                        // The stream restarted while we held its batch (a verifier promoted to
                        // primary re-anchors on the DB tip): the new stream re-sends what matters.
                        // Holding on would block the peer's queue — the restarted stream's headers
                        // wait behind this batch, the applier waits for those headers (preview
                        // epochs 1149 and 1170: the promoted primary went silent for good).
                        logger.info(`Held header batch from ${peerId} dropped: its ChainSync stream was ${peer.isTerminated ? "terminated" : "restarted"} while waiting for the epoch ${e} nonce`);
                        this.profile.add("hdr.nonce.hold", performance.now() - tHold);
                        return;
                    }
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
                    deferVrfWithoutNonce: deferEpochs.size > 0,
                    // Byron block signatures verify on the workers when OBFT is configured;
                    // Byron protocolMagic equals the network magic on every Cardano network.
                    byronProtocolMagic: this.config.byronGenesisFile ? Number(this.config.networkMagic) : undefined,
                    config: {
                        networkMagic: this.config.networkMagic,
                        shelleyGenesisFile: this.config.shelleyGenesisFile,
                        network: getEpochNetwork(), // workers pin their slot→epoch geometry to this
                    },
                })),
            );
            this.profile.add("hdr.validate", performance.now() - tVal);
            const parsed: HeaderSummary[] = [];
            const nonces: string[] = [];
            const checker = results.some((r) => r.ok && r.shelley) ? await this.ensureLeaderChecker() : null;
            for (const r of results) {
                if (!r.ok) {
                    const msg = `Header validation failed at slot ${r.slot} hash=${r.hashHex}: ${r.reason ?? "invalid"}`;
                    if (role === "verifier") this.terminateMalicious(peer, msg);
                    throw new Error(msg);
                }
                if (r.shelley && checker && !r.vrfDeferred) {
                    const v = await this.leaderCheck(r, checker);
                    if (!v.ok) {
                        const msg = `Header leader rule failed at slot ${r.slot} hash=${r.hashHex}: ${v.reason}`;
                        if (role === "verifier") this.terminateMalicious(peer, msg);
                        throw new Error(msg);
                    }
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
                    ...(r.shelley ? { shelley: r.shelley } : {}),
                    ...(r.vrfDeferred ? { vrfDeferred: true } : {}),
                });
                nonces.push(r.isByron ? "" : noncesByEpoch[String(r.epoch)] ?? "");
            }
            if (deferEpochs.size) this.noteDeferredVrf(peerKey, items, parsed);

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

    /** Every Nth header of a verifier that trails the comparison window is checked against the applied chain. */
    private static readonly BEHIND_CHECK_EVERY = 32;
    private readonly behindHeaders = new Map<string, number>();

    /**
     * A verifier point older than the primary's k-deep window cannot be compared
     * in memory, but the applied chain is right there: its hash either is one of
     * our blocks at that slot (late agreement) or it is not. Sampled, since a
     * lagging verifier stays lagging and a fork changes every hash after it.
     * Only the settled part of our chain (k blocks below the tip) can convict.
     */
    private async confirmBehindPoint(peer: PeerClient, slot: bigint, hash: string): Promise<void> {
        const key = peer.peerKey;
        const n = (this.behindHeaders.get(key) ?? 0) + 1;
        this.behindHeaders.set(key, n);
        if (n % ConsensusOrchestrator.BEHIND_CHECK_EVERY !== 1) return;
        const row = await getBlockListRowByHash(hash);
        if (row && BigInt(row.slot) === slot) {
            this.candidates.noteAgreedBehind(key, slot);
            return;
        }
        const settledBelow = (await getMaxSlot()) - BigInt(this.candidates.fragmentDepth);
        if (settledBelow < slot) return; // our chain may not have reached it yet
        this.terminateMalicious(peer, `diverges from the applied chain at slot ${slot}: peer=${hash} is not one of our blocks`);
    }

    /** Verifier headers: compare against the primary; act on divergence. */
    private async observeVerifierHeaders(peer: PeerClient, parsed: HeaderSummary[]): Promise<void> {
        const peerKey = peer.peerKey;
        for (const p of parsed) {
            const hash = toHex(p.blockHeaderHash);
            const verdict = this.candidates.observe(peerKey, { slot: p.slot, hash, ebb: p.isEbb });
            if (verdict.kind === "behind") {
                await this.confirmBehindPoint(peer, p.slot, hash);
                continue;
            }
            if (verdict.kind !== "divergent") continue;

            const outvote = this.candidates.primaryOutvoted(this.quorum());
            if (outvote.outvoted && outvote.by?.includes(peerKey)) {
                await this.switchPrimaryAfterOutvote(outvote.slot!, outvote.hash!, outvote.by!);
                return;
            }
            // A divergence inside the volatile window is a fork candidate, not misbehaviour: the
            // primary may be the outlier (preview slot 122 174 111: the primary served a losing
            // block after its own RollBackward, two verifiers carried the canonical one and were
            // each held cold before they could outvote it — bug 88). Hold the verifier; convict
            // only when the fork point is settled (k deep) and our chain does not carry its block.
            const settledBelow = (await getMaxSlot()) - BigInt(this.candidates.fragmentDepth);
            if (verdict.slot <= settledBelow) {
                const ours = await blockAtSlot(verdict.slot);
                if (ours && ours.hash === verdict.peerHash.toLowerCase()) { this.candidates.clearDivergence(peerKey); continue; } // the fork went its way; we followed
                this.terminateMalicious(
                    peer,
                    `diverges from the settled chain at slot ${verdict.slot}: peer=${verdict.peerHash} ours=${ours?.hash ?? "∅"}`,
                );
            }
            const heldKey = `${peerKey}@${verdict.slot}`;
            if (!this.heldDivergences.has(heldKey)) {
                this.heldDivergences.add(heldKey);
                logger.info(`Verifier ${peerKey} diverges from primary ${this.candidates.primary() ?? "?"} at slot ${verdict.slot} (peer=${verdict.peerHash.slice(0, 12)}… primary=${verdict.primaryHashes.map((h) => h.slice(0, 12) + "…").join("|") || "∅"}); held as a fork candidate until settled or outvoted`);
            }
            break; // nothing more to compare from this peer until the fork resolves
        }
        this.maybePromoteFasterVerifier();
    }

    /** Verifier@slot divergences already logged (held, not convicted). */
    private readonly heldDivergences = new Set<string>();
    /** Hashes of blocks our own rollbacks removed (a peer still serving one is on the other side of a fork, not lying). */
    private readonly recentlyRolledBack = new Set<string>();

    /** Validated headers a verifier must lead the primary by before it is promoted for throughput. */
    private static readonly SPEED_PROMOTION_LEAD = 1024;
    private static readonly SPEED_PROMOTION_COOLDOWN_MS = 300_000; // a re-anchored primary needs minutes to look fast again; 60 s ping-ponged two peers
    private lastSpeedPromotionAt = 0;
    private static readonly PRIMARY_IDLE_FOR_PROMOTION_MS = 5_000;
    /** Last time the primary delivered a header batch (speed promotion only when it goes quiet). */
    private lastPrimaryHeaderAt = Date.now();

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
        // A verifier is only "faster" if the primary has actually gone quiet: verifiers are not
        // subject to the header cap, so a lead alone is normal while the primary is throttled.
        if (now - this.lastPrimaryHeaderAt < ConsensusOrchestrator.PRIMARY_IDLE_FOR_PROMOTION_MS) return;
        const oldKey = this.candidates.primary();
        // A local root (a relay on this host, e.g. the Mithril block store) is never the slow side:
        // its stream is throttled by our own applier, and verifiers on the public network then look
        // "ahead". Keep it primary (preview replay 2026-09-07: promoted away three times in an hour).
        // Unless it has run dry: a block store serving a certified chain ends at the certificate's
        // tip (preview 2026-09-07: the node sat at slot 122 087 503 with public verifiers ahead).
        if (oldKey && this.peerByKey(oldKey)?.source === "localRoot" && now - this.lastPrimaryHeaderAt < ConsensusOrchestrator.LOCAL_ROOT_IDLE_FOR_PROMOTION_MS) return;
        const pick = this.candidates.fasterAgreeingVerifier(ConsensusOrchestrator.SPEED_PROMOTION_LEAD);
        if (!oldKey || !pick) return;
        const next = this.peerByKey(pick.key);
        if (!next) return;
        this.lastSpeedPromotionAt = now;
        logger.warn(
            `Verifier ${pick.key} agrees with primary ${oldKey} through slot ${pick.primaryTipSlot} and is ${pick.lead} validated headers ahead; promoting it to primary for throughput`,
        );
        const anchored = this.candidates.agreement(pick.key)?.status;
        this.candidates.setPrimary(pick.key);
        this.lastAccepted = null; // re-anchor the contiguity check on the DB tip
        this.lastPrimaryByronHeaderHash = null;
        // Pending headers / queued ranges from the old primary stay valid (same chain);
        // the new primary's re-stream skips them as duplicates and continues past them.
        void this.anchorPromotedPrimary(next, pick.key, anchored === "agrees" || anchored === "ahead", "promoted to primary for throughput; re-anchor on DB tip");
    }

    /**
     * Bring a verifier just promoted to primary into position. Its stream is wherever it got to
     * as a verifier. Restarting ChainSync from our DB tip is the general answer, but a restart
     * must first drain every pipelined RequestNext, and at the tip each of those is answered
     * only by the next block: a verifier resumed at our tip and promoted a second later had 29
     * outstanding (preview 2026-09-10 12:12 UTC) — ten minutes without a block applied, while
     * three other peers were ahead. When the verifier agreed with the chain we applied, its
     * fragment past our tip is exactly what the primary would re-stream: hand those points to
     * the scheduler and keep its stream (the outvote switch has done the same since bug 73).
     */
    private async anchorPromotedPrimary(peer: PeerClient, key: string, anchored: boolean, reason: string): Promise<void> {
        const outstanding = peer.chainSyncInFlight;
        // Only a stream with nothing outstanding can be re-anchored without the drain. A verifier
        // promoted seconds after it resumed at our DB tip has never agreed with anything yet
        // (2026-09-11 15:00 UTC, import node: 32 replies outstanding, ten minutes stalled) — its
        // stream is positioned at our tip all the same, and the contiguity check on primary
        // headers rejects a stream that does not chain onto it, so keep it either way.
        if (outstanding <= 1) { void peer.restartChainSync(reason); return; }
        const tipSlot = await getMaxSlot();
        const points = this.candidates.fragmentOf(key).filter((p) => p.slot > tipSlot);
        logger.info(`Primary ${key}: keeping its stream (${outstanding} replies outstanding, ${anchored ? "agreed" : "not yet agreed"}; ${points.length} header(s) past our tip ${tipSlot} handed to the scheduler)`);
        const rangeBlocks = this.maxRangeBlocks();
        for (let i = 0; i < points.length; i += rangeBlocks) {
            const chunk = points.slice(i, i + rangeBlocks).map((p) => ({ slot: p.slot, hash: p.hash }));
            this.ensureScheduler().submit(chunk).applied.catch(() => undefined);
        }
        // The stream continues after the last handed point, so the contiguity check must expect
        // that, not the DB tip (2026-09-11 23:43 UTC: "does not chain onto our tip" → restart → drain).
        const last = points[points.length - 1];
        if (last) this.lastAccepted = { slot: last.slot, hash: last.hash.toLowerCase() };
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
        // The outvoted primary stays connected as a verifier: in a slot battle it may have served
        // the block that wins (preview 2026-09-10 02:03 and 04:03 UTC, both times the "outvoted"
        // primary carried the canonical block). If its branch is really dead, the settled-chain
        // rule convicts it once the fork point is k deep; if ours was the dead one, it re-agrees.
        this.candidates.setPrimary(successor);
        if (oldKey) logger.warn(`Primary ${oldKey} demoted to verifier (served ${this.candidates.agreement(oldKey)?.tipHash?.slice(0, 12) ?? "?"}… at slot ${slot})`);
        // Undo everything from the fork slot on; the new primary's fragment refills it. The quorum
        // already proves the fork, so roll back now: handleRollBack without the fork point's hash
        // only *deferred* the rollback, the successor's range then failed the contiguity check
        // against our outvoted block, and the node sat on a dead one-block fork for hours
        // (preview slot 122 077 808, 2026-09-06 22:30 UTC).
        const rollbackTo = slot > 0n ? slot - 1n : 0n;
        await this.rollbackOurChainTo(rollbackTo, `primary outvoted at slot ${slot}`);
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
        this.lastPrimaryHeaderAt = Date.now();
        if (this.deferredRollback && parsed.length > 0) {
            const d = this.deferredRollback;
            const first = parsed[0]!;
            const firstHash = toHex(first.blockHeaderHash).toLowerCase();
            // "Ours" means applied. A header merely pending (accepted from some peer, body never
            // applied — e.g. the loser of a same-slot fork whose range failed) is not our chain; counting
            // it cancelled the rollback and left node 3036 five hours on a dead fork (bug 124, 2026-09-14).
            const ours = await this.isAlreadyApplied(firstHash);
            if (ours) {
                this.deferredRollback = null;
                logger.rollback(`Deferred rollback to slot ${d.slot} cancelled: the peer re-streams our own chain (slot ${first.slot})`);
            } else if (d.hash && first.prevHashHex && first.prevHashHex.toLowerCase() === d.hash && first.slot > d.slot) {
                // A block we do not hold extends the rollback point: the peer's chain forks off ours there.
                this.deferredRollback = null;
                await this.rollbackOurChainTo(d.slot, `fork confirmed by ${peerKey}`);
            } else if (first.slot > d.slot) {
                // Neither our block nor a child of the rollback point: leave the contiguity check to it.
                this.deferredRollback = null;
            }
        }
        const points: RangePt[] = [];
        let skippedDuplicates = 0;
        let prevByronHashInBatch: string | null = null;
        let expectedPrev: string | null | undefined = this.lastAccepted?.hash; // undefined = not yet anchored
        let expectedPrevSlot: bigint | null = this.lastAccepted?.slot ?? null;

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
                if (expectedPrev === undefined) {
                    expectedPrev = await this.dbTipHash();
                    expectedPrevSlot = expectedPrev ? await getMaxSlot() : null;
                }
                // Slots strictly increase along a chain (Shelley+; Byron shares the EBB slot).
                if (expectedPrevSlot != null && expectedPrevSlot > 0n && parsedHeader.slot <= expectedPrevSlot) {
                    // A header at or before our tip's slot whose parent is a block we hold is the other
                    // side of a fork (a lost slot battle: same slot, same parent, another hash). Our
                    // branch goes, k-guarded; the peer is honest. Preview slot 122 077 808 banned every
                    // peer here for hours because the fork's parent was never looked up.
                    const prevHex = parsedHeader.prevHashHex.toLowerCase();
                    const parent = this.lastAccepted?.hash?.toLowerCase() === prevHex ? null : await getBlockByHash(prevHex);
                    const parentSlot = parent ? BigInt(Array.isArray(parent) ? parent[2] : parent.slot) : null;
                    if (parentSlot != null && parentSlot < parsedHeader.slot && await this.rollbackOurChainTo(parentSlot, `fork at slot ${parsedHeader.slot} from ${peerKey} (parent ${prevHex.slice(0, 12)}…)`)) {
                        this.pendingHeaders.clear();
                        expectedPrev = prevHex;
                        expectedPrevSlot = parentSlot;
                    } else {
                        this.terminateMalicious(peer, `header at slot ${parsedHeader.slot} does not advance past its parent at slot ${expectedPrevSlot}`);
                    }
                }
                if (expectedPrev && parsedHeader.prevHashHex.toLowerCase() !== expectedPrev.toLowerCase()) {
                    // The header extends a block we already hold (pending or applied), just not the
                    // stream position: a late reply from before a ChainSync restart that slipped past
                    // the drain (seen at every promotion on preview, 2026-09-06). It is on our chain,
                    // so drop the rest of the batch; the new stream re-sends these headers in order.
                    // Restarting here looped: restart → late reply → restart, at 0 blocks/s.
                    const prevHex = parsedHeader.prevHashHex.toLowerCase();
                    // Far beyond the stream position (more than a lookahead of slots): a verifier-era
                    // header of a just-promoted peer, whose predecessor may lie past our pending window.
                    const anchorSlot = expectedPrevSlot ?? (await getMaxSlot());
                    const farAhead = parsedHeader.slot > anchorSlot + BigInt(this.headerLookahead()) * 20n;
                    if (!farAhead && !this.pendingHeaders.has(prevHex) && await this.isAlreadyApplied(prevHex)) {
                        // The header extends an applied block BELOW our tip and is newer than the tip:
                        // a competing block at our height (2026-09-13 02:35 UTC: the network built on
                        // the block before the one we forged; dropped as a late reply, the fork was
                        // only noticed one header later and the producer sat on its orphan for two
                        // minutes). Follow the peer's chain now; if ours wins, its headers come back.
                        const tip = await getChainTip();
                        if (tip && tip.hashHex.toLowerCase() !== prevHex && parsedHeader.slot >= tip.slot) { // ≥: a competing block in the SAME slot as our tip is a fork too (bug 127)
                            logger.warn(`Primary ${peerKey}: header at slot ${parsedHeader.slot} forks from ${prevHex.slice(0, 12)}… below our tip ${tip.hashHex.slice(0, 12)}…@${tip.slot} (a competing block at our height); restarting its ChainSync to follow the peer's chain`);
                            this.lastAccepted = null;
                            void peer.restartChainSync("fork below our tip", 3_000);
                            return;
                        }
                    }
                    if (farAhead || this.pendingHeaders.has(prevHex) || await this.isAlreadyApplied(prevHex)) {
                        this.profile.add("hdr.late.drop", parsed.length - i);
                        logger.debug(`Primary ${peerKey}: header at slot ${parsedHeader.slot} ${farAhead ? "is far beyond the stream position" : "chains onto a block we hold but not onto the stream position"}; dropping ${parsed.length - i} late header(s)`);
                        break;
                    }
                    logger.warn(
                        `Primary ${peerKey} header at slot ${parsedHeader.slot} does not chain onto our tip (prev ${parsedHeader.prevHashHex.slice(0, 12)}… ≠ ${expectedPrev.slice(0, 12)}…); restarting its ChainSync from the DB tip`,
                    );
                    this.lastAccepted = null;
                    void peer.restartChainSync("stream not contiguous with DB tip");
                    return;
                }
            }
            expectedPrev = headerHashHex;
            expectedPrevSlot = parsedHeader.slot;

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

            this.pendingHeaders.set(headerHashHex, { item: items[i]!, parsedHeader, nonce: nonces[i]!, ...(parsedHeader.vrfDeferred ? { vrfDeferred: true } : {}) });
            points.push({ slot: parsedHeader.slot, hash: headerHashHex });
            this.lastAccepted = { slot: parsedHeader.slot, hash: headerHashHex };
        }

        if (skippedDuplicates > 0) {
            logger.debug(`Skipped ${skippedDuplicates} already-applied/pending header(s) from ${peerKey}`);
        }
        if (points.length === 0) {
            if (skippedDuplicates === parsed.length && parsed.length > 0 && this.scheduler?.stats().queued === 0 && this.scheduler?.stats().inFlight === 0) {
                logger.info(`Primary ${peerKey} re-streamed ${parsed.length} header(s) we already hold (slots ${parsed[0]!.slot}..${parsed[parsed.length - 1]!.slot}); pending ${this.pendingHeaders.size}, range buffer ${this.rangeBuffer.length}, scheduler idle`);
            }
            return;
        }

        // Ranges are cut from a buffer so their size follows the distance to the tip
        // (large far behind, single blocks at the tip) instead of the header batch size.
        const lastItem = items[items.length - 1]!;
        const lastPoint = points[points.length - 1]!;
        const lastParsed = parsed[parsed.length - 1]!;
        this.rangeBuffer.push(...points);
        const targetSize = rangeSizeFor(lastItem.tip, lastPoint.slot, lastParsed.isByron, this.maxRangeBlocks());
        this.profile.add("rng.target", targetSize); // per-block average of the sizer's output (diagnostic)
        if (targetSize !== this.lastRangeTarget) {
            this.lastRangeTarget = targetSize;
            logger.info(`Range target ${targetSize} blocks (peer tip ${lastItem.tip}, header slot ${lastPoint.slot}, buffered ${this.rangeBuffer.length})`);
        }
        this.flushRanges(targetSize);
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
            const arm = () => {
                this.rangeFlushTimer = setTimeout(() => {
                    this.rangeFlushTimer = null;
                    if (this.rangeBuffer.length === 0) return;
                    // A quiet buffer while we throttle the stream is not a stall: the tail
                    // fills as soon as room opens, so keep waiting rather than cut a small range.
                    if (n >= 16 && this.throttlingHeaders()) { arm(); return; }
                    // Flush the tail as one range, not one range per block: every range costs a
                    // verify job, a transaction commit and a rules-pipeline restart (preview: 680
                    // single-block ranges next to 150 full ones in four minutes).
                    this.flushRanges(this.rangeBuffer.length);
                }, flushMs);
            };
            arm();
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
     * Header-stream throttle: below this many pending headers the primary's stream
     * resumes. One batch of hysteresis (not two ranges): with two ranges the workers
     * validated ~250 headers in a 2 s burst every 6 s and idled in between (CPU
     * sawtooth, 2026-09-05); one batch keeps the stream and the pool busy evenly.
     * Range sizes are protected separately: partial ranges are not flushed while
     * the pause is ours (see flushRanges).
     */
    private headerResumeBelow(): number {
        const batch = Math.max(1, Number(this.config.blockFetchBatch?.maxBlocks ?? 32));
        return Math.max(1, this.headerLookahead() - Math.max(batch, Math.floor(this.maxRangeBlocks() / 4)));
    }

    /** True while we hold the header stream back (buffer near the cap), as opposed to a peer stall. */
    private throttlingHeaders(): boolean {
        return this.pendingHeaders.size >= this.headerResumeBelow();
    }

    /**
     * Block the primary's header stream while `headerLookahead` validated headers await
     * bodies; resume once a batch of room exists (`headerResumeBelow`).
     */
    private async waitForHeaderRoom(peerKey: string): Promise<void> {
        const cap = this.headerLookahead();
        if (this.pendingHeaders.size < cap) return;
        const resumeBelow = this.headerResumeBelow();
        while (this.pendingHeaders.size > resumeBelow) {
            if (this.halted || this.stopping || this.candidates.primary() !== peerKey || !this.peerByKey(peerKey)) return;
            await new Promise((r) => setTimeout(r, 25));
        }
    }

    /** Write a block we could not parse or validate to GEROLAMO_FAILED_BLOCK_DIR for offline replay. */
    private dumpFailedBlock(bytes: Uint8Array, slot: bigint, why: string): void {
        try {
            const dir = process.env.GEROLAMO_FAILED_BLOCK_DIR ?? "./logs";
            const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}/failed-block-${slot}.hex`, toHex(bytes));
            logger.error(`Offending block (${why}) written to ${dir}/failed-block-${slot}.hex`);
        } catch { /* best effort */ }
    }

    // ───────────────────── rules ahead of apply (pipelining) ─────────────────────

    /** How many blocks ahead of the one being applied get their rules evaluated on workers. */
    private static readonly RULES_AHEAD_DEPTH = 16;
    /** A local root stays primary through applier back-pressure; only this long without a header means it has nothing more. */
    private static readonly LOCAL_ROOT_IDLE_FOR_PROMOTION_MS = 60_000;
    /** Blocks parsed ahead of time (reused by the loop's parse step). */
    private readonly parsedAheadMap = new WeakMap<BlockFetchBlock, MultiEraBlock>();
    /** Ledger effects of parsed blocks (for the overlay of blocks not yet applied). */
    private readonly overlayCache = new WeakMap<BlockFetchBlock, BlockOverlay>();
    /** Rule outcomes running on workers, by block. */
    private readonly rulesAheadMap = new WeakMap<BlockFetchBlock, Promise<BlockRulesResult>>();
    /** Stored UTxO rows the rules stage read for a block; the applier spends from them (blk.apply reads fewer rows). */
    private readonly spentRowsAheadMap = new WeakMap<BlockFetchBlock, Map<string, UtxoRow>>();
    /** Blocks that will never be evaluated ahead (epoch boundary): evaluated inline. */
    private readonly rulesAheadNever = new WeakSet<BlockFetchBlock>();
    private rulesAheadFailureLogged = false;
    private shelleyGenesisCache: unknown | null = null;

    private overlayOf(message: BlockFetchBlock, block: MultiEraBlock): BlockOverlay {
        let o = this.overlayCache.get(message);
        if (!o) { o = shelleyBlockOverlay(block); this.overlayCache.set(message, o); }
        return o;
    }

    /**
     * Evaluate the rules of blocks i+1 … i+DEPTH on workers while block i applies.
     * Block j's ledger reads are resolved from the database now and adjusted with
     * the effects of the not-yet-applied blocks i … j−1 (`shelleyBlockOverlay`:
     * outputs created and spent, pools registered), so a worker sees the state
     * the ledger will have (created and spent outputs, registered pools, emptied
     * reward accounts). A block is left to inline evaluation when it starts a new
     * epoch (rewards/params change at apply time).
     */
    private async scheduleRulesAhead(blocks: BlockFetchBlock[], i: number, current: MultiEraBlock, currentEpoch: number, params: EpochBodyParams): Promise<void> {
        const pool = this.pool;
        if (!pool || pool.workerCount === 0) return;
        // Opt-in (GEROLAMO_RULES_AHEAD=1). Measured 2026-09-06 on preview (light Babbage
        // blocks, rules ≈ 1.9 ms/block): main-thread cost rose from 9.8 to 11.4 ms/block
        // (structured-clone of the resolved inputs + result hand-off outweighed the
        // rules moved out), 76.7 → 65.9 blocks/s. Worth it only once workers resolve
        // inputs themselves through a read-only connection; kept for that step.
        if (process.env.GEROLAMO_RULES_AHEAD === "0") return; // opt-out: on by default since the 2026-09-06 A/B (37 → 89 blocks/s on preview Conway blocks)
        const last = Math.min(i + ConsensusOrchestrator.RULES_AHEAD_DEPTH, blocks.length - 1);
        for (let j = i + 1; j <= last; j++) {
            const msg = blocks[j]!;
            if (this.rulesAheadMap.has(msg)) continue;
            if (this.rulesAheadNever.has(msg)) { this.profile.add("rules.skip.never", 1); continue; }
            try {
                const identity = this.verifiedIdentities.get(msg);
                if (!identity || identity.era < 2) { this.profile.add("rules.skip.identity", 1); this.rulesAheadNever.add(msg); continue; }
                let next = this.parsedAheadMap.get(msg);
                if (!next) {
                    let parsed: MultiEraBlock | null = null;
                    const tP = performance.now();
                    try { parsed = (await blockParser(msg)) ?? null; } catch { /* the apply loop reports and dumps it */ }
                    this.profile.add("blk.rules.prep.parse", performance.now() - tP);
                    if (!parsed || !(parsed instanceof MultiEraBlock)) { this.profile.add("rules.skip.parse", 1); this.rulesAheadNever.add(msg); break; }
                    next = parsed;
                    this.parsedAheadMap.set(msg, next);
                }
                const nextSlot = BigInt(getHeaderSlot(next.block.header));
                if (Number(calculatePreProdCardanoEpoch(Number(nextSlot))) !== currentEpoch) { this.profile.add("rules.skip.epoch", 1); this.rulesAheadNever.add(msg); break; }
                // effects of blocks i … j−1, in order
                const overlays: BlockOverlay[] = [this.overlayOf(blocks[i]!, current)];
                let complete = true;
                for (let k = i + 1; k < j; k++) {
                    const pk = this.parsedAheadMap.get(blocks[k]!);
                    if (!pk) { complete = false; break; }
                    overlays.push(this.overlayOf(blocks[k]!, pk));
                }
                if (!complete) { this.profile.add("rules.skip.incomplete", 1); break; }
                // Withdrawals from an account an in-flight block also withdraws from are handled by
                // the overlay (the balance is exactly zero afterwards); preview epochs 890–905 had
                // 17 % of blocks falling back to inline evaluation over this.
                const tG = performance.now();
                let inputs = await gatherShelleyBlockInputs(next);
                inputs = applyOverlays(inputs, overlays);
                if (inputs.rows) this.spentRowsAheadMap.set(msg, inputs.rows);
                this.profile.add("blk.rules.prep.gather", performance.now() - tG);
                // The witness verdict comes from a worker; waiting for it here cost the applier
                // 4 ms per block (2026-09-06). Post the rules job when it lands instead — the
                // result still arrives far ahead of the applier (deliver lead ~130 ms).
                const pre = this.preWitness.get(msg);
                if (this.shelleyGenesisCache == null) this.shelleyGenesisCache = await getShelleyGenesisConfig(this.config);
                const tPost = performance.now();
                const job = {
                    kind: "blockRules" as const,
                    block: msg.blockData,
                    slot: nextSlot.toString(),
                    params,
                    genesis: this.shelleyGenesisCache,
                    config: { network: this.config.network, networkMagic: Number(this.config.networkMagic), byronGenesisFile: this.config.byronGenesisFile },
                    resolved: inputs.resolved,
                    pools: inputs.pools,
                    rewardBalances: inputs.rewardBalances ?? null,
                    preVerified: null as boolean[] | null,
                    postedAt: Date.now(),
                };
                const verdict: Promise<boolean[] | null> = pre ? pre.then((r) => r.ok, () => null) : Promise.resolve(null);
                this.rulesAheadMap.set(msg, verdict
                    .then((preVerified) => pool.evaluateBlockRules({ ...job, preVerified, postedAt: Date.now(), phase: "rules" }))
                    .catch((err): BlockRulesResult => ({ outcome: null, reason: err instanceof Error ? err.message : String(err) })));
                this.profile.add("blk.rules.prep.post", performance.now() - tPost);
                // Plutus shadow evaluation is diagnostics nobody waits on: its own job on a general
                // worker, results folded into the running totals when they arrive.
                // Sampled here (one block in SHADOW_SAMPLE_EVERY) so unsampled blocks cost no second
                // structured clone of the inputs; the job then evaluates every redeemer it carries.
                const hasRedeemers = ((next.block as any).transactionWitnessSets ?? []).some((w: any) => (w?.redeemers?.length ?? 0) > 0);
                if (hasRedeemers && Number(next.era) >= 5 && (this.shadowBlockCounter++ % SHADOW_SAMPLE_EVERY) === 0) {
                    pool.evaluateBlockRules({ ...job, preVerified: null, phase: "shadow" })
                        .then((r) => { if (r.outcome) { recordPlutusShadow(r.outcome); for (const rep of r.outcome.reports) if (rep.includes("plutus shadow:")) logger.warn(`Plutus shadow at slot ${nextSlot}: ${rep}`); } })
                        .catch(() => undefined);
                }
            } catch (err) {
                if (!this.rulesAheadFailureLogged) { this.rulesAheadFailureLogged = true; logger.warn("Block rules ahead-of-time scheduling failed; evaluating inline:", err); }
                return;
            }
        }
    }

    // ───────────────────────────── block producer ─────────────────────────────

    /** η0 of `epoch` (hex) from the local evolver / DB, or null when not yet known. */
    async epochNonceFor(epoch: number): Promise<string | null> {
        return this.getEpochNonce(epoch);
    }

    /**
     * Apply a block this node forged (`[era, block]` bytes) through the same
     * strict path a fetched range takes: identity, continuity with the DB tip,
     * body rules, ledger apply, header row. Throws when our own block would not
     * pass — the producer then must not publish it.
     */
    async adoptLocalBlock(blockFetchBytes: Uint8Array): Promise<{ slot: bigint; hashHex: string }> {
        if (this.halted) throw new Error("sync halted: not adopting a local block");
        const identity = headerIdentityOfBlock(blockFetchBytes);
        // The parser and the header row want the full MsgRollForward, as a peer would send it.
        const local = localRollForwardMessage(blockFetchBytes);
        let parsed: ParsedHeader | null = null;
        try { parsed = await headerParser(local.bytes); } catch (err) { throw new Error(`adoptLocalBlock: header does not parse: ${(err as Error)?.message ?? err}`); }
        if (!parsed) throw new Error("adoptLocalBlock: header does not parse");
        const slot = parsed.slot;
        const hashHex = toHex(identity.hash).toLowerCase();
        // Our own header through the same rules a peer's header gets (VRF proof, leader value,
        // KES signature at the slot's evolution, operational certificate): a block that would
        // fail them at every other node must never be published.
        const nonceHex = await this.getEpochNonce(parsed.epoch);
        if (!nonceHex) throw new Error(`adoptLocalBlock: no η0 for epoch ${parsed.epoch}`);
        const headerOk = await validateHeader(parsed.multiEraHeader, fromHex(nonceHex), this.config).catch((err) => { throw new Error(`adoptLocalBlock: header validation threw: ${(err as Error)?.message ?? err}`); });
        if (!headerOk) throw new Error("adoptLocalBlock: header fails our own header rules (VRF / KES / opcert)");
        const block = new BlockFetchBlock({ blockData: blockFetchBytes });
        this.verifiedIdentities.set(block, identity);
        // A pending entry like a peer header's, so the applier writes the volatile header row
        // (what the ChainSync hosts serve to peers pulling this block).
        const { multiEraHeader: _meh, ...summary } = parsed;
        this.pendingHeaders.set(hashHex, { item: { rollForwardCborBytes: local.bytes, tip: local.blockNo }, parsedHeader: summary as HeaderSummary, nonce: nonceHex });
        try {
            await this.applyRange([{ slot, hash: hashHex }], [block], "self");
        } finally {
            this.pendingHeaders.delete(hashHex);
        }
        // Our block is the new stream position: the network's next header chains onto it. Left
        // at the previous header, that header "chains onto a block we hold but not onto the
        // stream position", was dropped, the one after it forced a ChainSync restart and the
        // producer sat 55 s behind the tip (2026-09-12 06:33 UTC, the first accepted block).
        this.lastAccepted = { slot, hash: hashHex };
        return { slot, hashHex };
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
            const tipBeforeRange = getSelectedTipHash();
            try {
                await sql.begin(async () => {
                    await this.applyRangeBlocks(points, blocks, fetchedFrom);
                    await this.persistNonceSnapshot();
                    const tIns = performance.now();
                    await insertHeaderBatchVolatile(Array.from(this.batchHeaderRecords.values()));
                    this.profile.add("blk.insert", performance.now() - tIns);
                });
                await this.mirrorToBlockStore(points, blocks);
                if (ledgerStoreMode() !== "sqlite") {
                    const v = await ledgerDualVerify();
                    if (ledgerStoreBroken() && !v.differences.length) v.differences.push(`ledger store unusable: ${ledgerStoreBroken()}`);
                    if (v.differences.length) {
                        logger.error(`LEDGER STORE DIVERGENCE (dual run): ${v.differences.length} of ${v.checked} touched UTxO refs differ, e.g. ${v.differences.slice(0, 3).join(" | ")}`);
                        const tipPt = points[points.length - 1]!;
                        this.halted = { slot: tipPt.slot.toString(), hash: tipPt.hash, reason: `ledger store dual-run divergence: ${v.differences[0]}`, since: Date.now() }; // stop applying: the two stores disagree
                    }
                    await ledgerAfterRange(await this.securityParamK());
                }
            } catch (err) {
                // The transaction rolled back: nothing from this range is in the DB. In-memory
                // state that advanced with it must follow, exactly as after a chain rollback,
                // or a retry would skip blocks (dedupe LRU) or evolve the nonce twice.
                this.afterFailedRange();
                if (blockStoreMode() === "primary") setSelectedTipHash(tipBeforeRange); // the range's volatile blocks stay as a dead branch
                ledgerAbortRange();
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
                    ? `Forward index (MiniBF) paused: ${behind} slots behind the tip; run scripts/explorer-backfill.ts over the paused range after catch-up`
                    : `Forward index (MiniBF) resumed: ${behind} slots behind the tip`,
            );
        }
    }

    /** Drop in-memory state derived from applied blocks after a range's transaction rolled back. */
    private afterFailedRange(): void {
        discardPendingUtxoWrites(); // queued rows belonged to the rolled-back transaction
        // The range's headers were accepted but their bodies never applied; the primary's ChainSync is
        // restarted from the DB tip and re-streams them. Left in place they masqueraded as "our chain"
        // in the deferred-rollback check (bug 124).
        this.pendingHeaders.clear();
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
    private lastRangeTarget = -1;
    /**
     * Roll our chain back to `slot` (every block after it is deleted) and reset the caches that
     * mirror the applied chain. Refuses, and reports, a rollback deeper than k.
     */
    private async rollbackOurChainTo(slot: bigint, why: string): Promise<boolean> {
        const depth = await countBlocksAfterSlot(slot);
        if (depth === 0) return true;
        const k = await this.securityParamK();
        if (depth > k) {
            logger.error(`Refusing rollback to slot ${slot} (${why}): it would discard ${depth} blocks (> k=${k})`);
            return false;
        }
        for (const h of await blockHashesAbove(slot)) { this.recentlyRolledBack.add(h); if (this.recentlyRolledBack.size > 256) this.recentlyRolledBack.delete(this.recentlyRolledBack.values().next().value!); }
        const counts = await this.dbMutations.run(() => rollbackChainTo(slot));
        if (blockStoreMode() === "primary" && this.blockStore) await rollbackSelectedTip(this.blockStore, slot);
        if (ledgerStoreMode() !== "sqlite") { const row = await getBlockBySlot(slot); ledgerRollbackTo(Number(slot), row ? fromHex(String(Array.isArray(row) ? row[3] : row.block_hash)) : null); }
        logger.rollback(`Rollback to slot ${slot} (${why}): ${counts.blocksDeleted} blocks, ${counts.headersDeleted} headers, ${counts.deltasDeleted} deltas deleted`);
        this.nonceEvolver?.reset();
        this.epochNonceCache.clear();
        this.lastByronTipHash = null;
        this.forgetApplied();
        this.byronObft = null;
        this.byronObftInit = null;
        this.afterRollback();
        return true;
    }

    /** A primary's RollBackward waiting for its next headers to show whether our chain must move (see handleRollBack). */
    private deferredRollback: { slot: bigint; hash: string | null; peerKey: string | null; depth: number } | null = null;
    private shadowBlockCounter = 0;
    private lookaheadCache: { base: BlockFetchBlock[]; next: BlockFetchBlock[]; joined: BlockFetchBlock[] } | null = null;

    /** `blocks` extended with the next downloaded range when the rules window would otherwise run past the end. */
    private lookaheadBlocks(blocks: BlockFetchBlock[], i: number): BlockFetchBlock[] {
        if (i + ConsensusOrchestrator.RULES_AHEAD_DEPTH < blocks.length) return blocks;
        const next = this.scheduler?.peekNextBlocks() ?? null;
        if (!next || next.length === 0) return blocks;
        const c = this.lookaheadCache;
        if (c && c.base === blocks && c.next === next) return c.joined;
        const joined = blocks.concat(next);
        this.lookaheadCache = { base: blocks, next, joined };
        return joined;
    }

    private async applyRangeBlocks(points: RangePt[], blocks: BlockFetchBlock[], fetchedFrom: string): Promise<void> {
        this.profile.add("rng.blocks", blocks.length); // average = blocks per range
        const bodyPolicy = this.resolveBodyPolicy();
        this.updateIndexSkip(points[0]!);
        // Chain continuity: every applied block must extend the applied chain (the DB tip
        // for the first one, then the previous block of the range). A range applied over
        // a hole would leave the ledger without the hole's UTxOs and look exactly like a
        // rule bug; undefined = not yet anchored on the DB tip.
        let expectedPrev: string[] | null | undefined = undefined;
        for (let i = 0; i < points.length; i++) {
            await this.yieldToEventLoop();
            const pt = points[i]!;
            const blockMessage = blocks[i]!;
            let pending = this.pendingHeaders.get(pt.hash);
            if (pending?.vrfDeferred) {
                // Its epoch's nonce is derivable by now (the applier is at or past the freeze point):
                // verify the VRF proofs and the leader rule of every deferred header of that epoch.
                await this.profile.timeAsync("blk.vrf.deferred", () => this.verifyDeferredVrf(pending!.parsedHeader.epoch));
                pending = this.pendingHeaders.get(pt.hash);
                if (!pending || pending.vrfDeferred || this.deferredVrfFailed.has(pt.hash.toLowerCase())) {
                    throw new Error(`block ${pt.hash.slice(0, 12)}…@${pt.slot}: header VRF / leader check ${this.deferredVrfFailed.has(pt.hash.toLowerCase()) ? "failed" : "still pending"} after the epoch nonce became known; re-anchoring on the DB tip`);
                }
            }
            // Headers from a primary switch were validated as verifier headers; no pending entry.
            const tParse = performance.now();
            let multiEraBlock: MultiEraBlock | null | undefined = this.parsedAheadMap.get(blockMessage);
            this.parsedAheadMap.delete(blockMessage);
            if (!multiEraBlock) {
                try {
                    multiEraBlock = await blockParser(blockMessage);
                } catch (err) {
                    // Identity and body hash already checked: the bytes are the real block, so a
                    // decode failure is our library's. Keep the bytes and halt (never blame the peer).
                    this.dumpFailedBlock(blockMessage.blockData, pt.slot, "decode");
                    throw new BlockDecodeFailure(pt.slot, pt.hash, err instanceof Error ? err.message : String(err));
                }
            }
            if (!multiEraBlock || !(multiEraBlock instanceof MultiEraBlock)) {
                this.dumpFailedBlock(blockMessage.blockData, pt.slot, "decode");
                throw new BlockDecodeFailure(pt.slot, pt.hash, "parser returned no block");
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

            // A block with a pending header was not applied when its header was accepted, and only
            // this loop applies blocks: the DB lookup is needed only for headerless ranges (primary switch).
            if (!pending && await this.profile.timeAsync("blk.dedupe", () => this.isAlreadyApplied(blockHash))) {
                this.pendingHeaders.delete(pt.hash);
                // Bug 127: the skipped block may sit BELOW our tip (a slot battle: we hold the losing block
                // at the same height). The next block must then extend our real tip, not the skipped
                // block, or it would be validated on top of the loser (preview 123032202: the winner's
                // transaction spent the same inputs and the node halted on a "double spend").
                const tips = await this.dbTipHashes();
                expectedPrev = tips && !tips.includes(blockHash.toLowerCase()) ? tips : [blockHash.toLowerCase()];
                continue;
            }
            if (expectedPrev === undefined) expectedPrev = await this.dbTipHashes();
            if (expectedPrev) {
                let prevHex = "";
                try {
                    prevHex = getHeaderPrevHashHex(blockHeader as any).toLowerCase();
                } catch { /* unknown header shape: the body-hash binding still holds */ }
                if (prevHex && !expectedPrev.includes(prevHex)) {
                    throw new Error(
                        `range from ${fetchedFrom} does not extend the applied chain: block ${blockHash.slice(0, 12)}…@${blockSlot} has prev ${prevHex.slice(0, 12)}… but the tip is ${expectedPrev.map((h) => h.slice(0, 12) + "…").join("/")}; nothing applied, re-anchoring on the DB tip`,
                    );
                }
            }

            // Ledger body rules (per-epoch parameters when available).
            let epochParams: EpochBodyParams | null = null;
            // LMDB ledger diff for this block: opened before the boundary work so the epoch transition
            // is part of the epoch's first block (docs/PLAN_LMDB_LEDGER.md §1).
            ledgerBeginBlock(blockHeaderHash, (() => { try { const p = getHeaderPrevHashHex(blockHeader as any); return p ? fromHex(p) : null; } catch { return null; } })(), Number(blockSlot));
            if (!isByron) {
                // Boundary work is not journaled (see ledgerJournal.ts): rollbacks never cross it.
                await this.profile.timeAsync("blk.epoch", () => withJournalingOff(sql as any, () => this.onEpochStart(blockEpoch)));
                epochParams = await this.profile.timeAsync("blk.params", () => getEpochBodyParams(this.config, blockEpoch));
            }
            const pre = this.preWitness.get(blockMessage);
            const preVerified = pre ? (await this.profile.timeAsync("blk.prewit", () => pre)).ok : null;
            // Rules of this block, if a worker evaluated them while the previous block applied.
            let ruleOutcome: BlockRuleOutcome | null = null;
            const aheadPromise = this.rulesAheadMap.get(blockMessage);
            if (!aheadPromise && !isByron) this.profile.add("blk.rules.inline", 1); // count of blocks evaluated on the main thread
            if (aheadPromise) {
                this.rulesAheadMap.delete(blockMessage);
                const tWait = performance.now();
                const r = await this.profile.timeAsync("blk.rules.wait", () => aheadPromise);
                const waited = performance.now() - tWait;
                if (waited > 10) this.profile.add("blk.rules.wait.gt10", waited); // how much of the wait is a few slow results
                else if (waited > 1) this.profile.add("blk.rules.wait.1to10", waited);
                if (r.parseMs != null) this.profile.add("blk.rules.wparse", r.parseMs);
                if (r.evalMs != null) this.profile.add("blk.rules.weval", r.evalMs);
                if (r.queueMs != null) this.profile.add("blk.rules.queue", r.queueMs);
                if (r.finishedAt != null) this.profile.add("blk.rules.deliver", Math.max(0, Date.now() - r.finishedAt));
                if (r.outcome) ruleOutcome = r.outcome;
                else if (r.reason && r.reason !== "byron" && !this.rulesAheadFailureLogged) { this.rulesAheadFailureLogged = true; logger.warn(`Block rules ahead-of-time failed (${r.reason}); evaluating inline`); }
            }
            // Start the rules of the next blocks on workers now (overlapping this block's apply).
            // Near the end of the range the window continues into the next downloaded range,
            // so the pipeline no longer drains at every range boundary (ranges are 32–256 blocks).
            const lookahead = this.lookaheadBlocks(blocks, i);
            if (i + 1 < lookahead.length && !isByron && epochParams) {
                await this.profile.timeAsync("blk.rules.prep", () => this.scheduleRulesAhead(lookahead, i, multiEraBlock, blockEpoch, epochParams!));
            }
            const vctx: any = { slot: blockSlot, pool: this.pool, preVerified, ruleOutcome };
            const valid = await this.profile.timeAsync("blk.validate", () => validateBlock(multiEraBlock, this.config, epochParams, vctx));
            if (!valid && bodyPolicy === "strict") {
                // Keep the offending block for offline replay (scripts/validate-stored-block.ts).
                try {
                    const dir = process.env.GEROLAMO_FAILED_BLOCK_DIR ?? "./logs";
                    const { mkdirSync, writeFileSync } = await import("node:fs");
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(`${dir}/failed-block-${blockSlot}.hex`, toHex(blockMessage.blockData));
                    logger.error(`Offending block written to ${dir}/failed-block-${blockSlot}.hex`);
                } catch { /* best effort */ }
                const reports: string[] = Array.isArray(vctx.failures) ? vctx.failures : [];
                throw new BodyValidationFailure(blockSlot, blockHash, `params=${epochParams ? "epoch " + epochParams.epoch : "genesis"}${reports.length ? "; " + reports.slice(0, 12).join(" | ").slice(0, 2000) : ""}`);
            }
            if (!valid) {
                logger.warn(`Block body validation failed at slot ${blockSlot} hash=${blockHash} (soft: applying)`);
            }

            if (this.lastBlockNo == null) this.lastBlockNo = await getMaxBlockNo();
            const blockNo = isEbb ? null : ++this.lastBlockNo;
            const knownInputs = this.spentRowsAheadMap.get(blockMessage);
            this.spentRowsAheadMap.delete(blockMessage);
            await setApplyBlock(sql as any, blockHeaderHash); // journal this block's state writes
            await this.profile.timeAsync("blk.apply", () => applyBlock(multiEraBlock.block as MultiEraBlock["block"], blockSlot, blockHeaderHash, undefined, blockNo, {
                epoch: blockEpoch,
                era: multiEraBlock.era,
                knownInputs,
                govActionLifetime: epochParams?.raw?.gov_action_lifetime != null ? Number(epochParams.raw.gov_action_lifetime) : undefined,
            }));
            if (!isByron) {
                // Operational certificate counters and the leader's block count follow the applied
                // chain — inside the journal scope, so a rollback undoes them (bug 104: the tables
                // were journaled but these writes ran after `setApplyBlock(null)`, and preview
                // epoch 1416 still ended with 24 phantom blocks on both nodes).
                try {
                    const body: any = (blockHeader as any)?.body;
                    const issuer = body?.issuerPubKey;
                    const seq = body?.opCert?.sequenceNumber;
                    if (issuer && seq != null) {
                        const issuerBytes = issuer instanceof Uint8Array ? issuer : new Uint8Array(issuer.toBuffer?.() ?? []);
                        if (issuerBytes.length === 32) {
                            const issuerHash = toHex(blake2b_224(issuerBytes));
                            await setOpcertCounter(sql, issuerHash, Number(seq), Number(blockSlot));
                            await noteBlockMade(sql, issuerHash, blockEpoch);
                        }
                    }
                } catch (err) {
                    logger.debug("opcert counter update skipped:", err);
                }
            }
            await setApplyBlock(sql as any, null);
            this.rememberApplied(blockHash);
            expectedPrev = [blockHash.toLowerCase()];
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
            ledgerCommitBlock();
            // Header rows are flushed once per range by applyRange (same transaction).
            this.pendingHeaders.delete(pt.hash);
            if (++this.volatileDbGcCounter % ConsensusOrchestrator.VOLATILE_GC_EVERY_BLOCKS === 0) {
                const gc = await this.profile.timeAsync("blk.gc", () => gcVolatile());
                await pruneLedgerJournal(sql as any, undefined, blockStoreMode() === "primary" && this.blockStore ? await this.journalSlotResolver() : undefined).catch(() => 0);
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
            this.maybeKickDeferredVrf();
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

    /** Primary mode: the journal pruner learns block slots from the store, not the frozen `blocks` table. */
    private async journalSlotResolver(): Promise<{ tipSlot: number; slotOf: (hashHex: string) => Promise<number | null> }> {
        const store = this.blockStore!;
        const tip = Number(await getMaxSlot());
        return { tipSlot: tip, slotOf: async (h) => (await store.byHash(fromHex(h)))?.slot ?? null };
    }

    /** cardano-node-format block store mirrored beside SQLite (docs/PLAN_CHUNK_STORE.md phase 3). */
    private blockStore: BlockStore | null = null;

    attachBlockStore(store: BlockStore | null): void {
        this.blockStore = store;
    }

    /**
     * After a range committed to SQLite: the same `[era, block]` bytes go into the volatile set,
     * then the selected chain is promoted k deep into the chunk files. Never fails the range:
     * SQLite is still the primary store and `catchUpFromSqlite` repairs any gap on the next start.
     */
    private async mirrorToBlockStore(points: RangePt[], blocks: BlockFetchBlock[]): Promise<void> {
        const store = this.blockStore;
        if (!store || points.length === 0) return;
        try {
            const t0 = performance.now();
            if (blockStoreMode() !== "primary") { // primary mode wrote the volatile blocks inside the range (insertBlockVolatile)
                for (let i = 0; i < points.length && i < blocks.length; i++) {
                    const hash = fromHex(points[i]!.hash);
                    if (!store.volatile.has(hash)) await store.put(blocks[i]!.blockData, hash);
                }
            }
            const tip = points[points.length - 1]!;
            noteSelectedTip(fromHex(tip.hash));
            const r = await store.promote(fromHex(tip.hash), await this.securityParamK());
            this.profile.add("blk.store", performance.now() - t0);
            if (r.promoted) logger.debug(`Block store: ${r.promoted} block(s) promoted into chunks, immutable slot ${r.immutableSlot}`);
        } catch (err) {
            logger.warn(`Block store mirror failed (SQLite is primary; catch-up repairs it on restart): ${(err as Error).message}`);
        }
    }

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
                    if (blockStoreMode() === "primary" && this.blockStore) await rollbackSelectedTip(this.blockStore, rollbackSlot, (() => { const h = (point.blockHeader as { hash?: unknown } | undefined)?.hash; return h instanceof Uint8Array ? toHex(h) : null; })());
                    if (ledgerStoreMode() !== "sqlite") { const row = await getBlockBySlot(rollbackSlot); ledgerRollbackTo(Number(rollbackSlot), row ? fromHex(String(Array.isArray(row) ? row[3] : row.block_hash)) : null); }
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
                // A RollBackward only moves the peer's read pointer. Whether *our* chain has to
                // move is decided by what follows: headers that are our own blocks mean the
                // peer is re-streaming our chain (a positioning rollback that slipped past the
                // intersect check — two restarts in one second did that on preview and 164 valid
                // blocks were deleted, then re-applied onto certificate state that rollbacks do
                // not revert); a header extending the rollback point with a block we do not
                // hold is a fork, and the rollback runs then (acceptPrimaryHeaders).
                const rawHash: unknown = (point.blockHeader as { hash?: unknown } | undefined)?.hash;
                const pointHash = rawHash instanceof Uint8Array ? toHex(rawHash).toLowerCase()
                    : typeof (rawHash as { toBuffer?: () => Uint8Array } | undefined)?.toBuffer === "function" ? toHex((rawHash as { toBuffer: () => Uint8Array }).toBuffer()).toLowerCase()
                    : typeof rawHash === "string" ? rawHash.toLowerCase() : null;
                this.deferredRollback = { slot: pointSlot, hash: pointHash, peerKey: fromPeer?.peerKey ?? null, depth };
                logger.rollback(`Primary RollBackward to slot ${pointSlot} (${depth} block(s) behind our tip) deferred until its next headers show a fork`);
                return { rolledBack: false };
            }
        } catch (error) {
            logger.error("Error in handleRollBack:", error);
            return { rolledBack: false };
        }
    }
}
