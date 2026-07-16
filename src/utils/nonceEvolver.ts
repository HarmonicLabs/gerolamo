/**
 * Continuous UPDN+TICKN state machine (cardano-ledger TPraos).
 *
 * Verified vs preprod snapshots + external η0 (epochs 4–7):
 *   bnonce = blake2b_256(proofHash)
 *   ηv' = ηv ⋆ bnonce
 *   ηc' = ηv' if s + StabilityWindow < firstSlotNext else ηc
 *   TICKN: η0' = ηc ⋆ ηh  (ηe Neutral = identity)
 *   ηh for next boundary = prevHash of last block of ended epoch (csLabNonce)
 *   ηv/ηc NEVER re-equalized to η0
 *
 * Mid-chain: bootstrap only when ηv/ηc are known (DB evolving/candidate, or
 * epoch-start with η0). Otherwise header VRF still uses getEpochNonce path.
 */
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import {
    seedCombine,
    blockNonceFromVrfProofHash,
    prevHashToNonce,
    ticknNewEpochNonce,
    stabilityWindowSlots,
    isBeforeNonceFreeze,
} from "./calcEpochNonce";
import {
    calculatePreProdCardanoEpoch,
    getFirstSlotOfEpoch,
} from "./epochFromSlotCalculations";
import type { ShelleyGenesisConfig } from "../types/ShelleyGenesisTypes";
import { logger } from "./logger";

export type NonceEvolverSnapshot = {
    etaVHex: string;
    etaCHex: string;
    /** ηh carried into current epoch (null/empty = NeutralNonce) */
    etaHHex: string | null;
    epoch: number;
    nBlocksInEpoch: number;
    nBeforeFreeze: number;
};

export type TicknResult = {
    /** Epoch whose η0 was just produced (the NEW epoch) */
    epoch: number;
    eta0Hex: string;
    etaVHex: string;
    etaCHex: string;
    etaHUsedHex: string | null;
    nBlocksPrev: number;
    nBeforeFreeze: number;
};

export class NonceEvolver {
    private etaV: Uint8Array;
    private etaC: Uint8Array;
    /** Carried into current epoch; Neutral at HF / after bootstrap without lab */
    private etaH: Uint8Array | null;
    private epoch: number;
    private nBlocksInEpoch = 0;
    private nBeforeFreeze = 0;
    private lastPrevHash: Uint8Array | null = null;
    private readonly stabilityWindow: number;
    private readonly genesis: ShelleyGenesisConfig;
    private active = false;

    constructor(genesis: ShelleyGenesisConfig) {
        this.genesis = genesis;
        this.stabilityWindow = stabilityWindowSlots(
            Number(genesis.securityParam ?? 2160),
            Number(genesis.activeSlotsCoeff ?? 0.05),
        );
        this.etaV = new Uint8Array(32);
        this.etaC = new Uint8Array(32);
        this.etaH = null;
        this.epoch = 0;
    }

    isActive(): boolean {
        return this.active;
    }

    getEpoch(): number {
        return this.epoch;
    }

    getStabilityWindow(): number {
        return this.stabilityWindow;
    }

    /**
     * Start continuous tracking from a known epoch-start state.
     * ηv = ηc = η0 (initNonce); ηh Neutral unless restored.
     */
    bootstrap(
        epoch: number,
        eta0Hex: string,
        opts?: {
            etaVHex?: string | null;
            etaCHex?: string | null;
            etaHHex?: string | null;
            nBlocksInEpoch?: number;
        },
    ): void {
        const eta0 = fromHex(eta0Hex);
        if (eta0.length !== 32) {
            throw new Error(`bootstrap: η0 must be 32 bytes, got ${eta0.length}`);
        }
        this.epoch = epoch;
        this.etaV = opts?.etaVHex ? fromHex(opts.etaVHex) : new Uint8Array(eta0);
        this.etaC = opts?.etaCHex ? fromHex(opts.etaCHex) : new Uint8Array(eta0);
        if (opts?.etaHHex && opts.etaHHex.length > 0) {
            this.etaH = fromHex(opts.etaHHex);
        } else {
            this.etaH = null;
        }
        this.nBlocksInEpoch = opts?.nBlocksInEpoch ?? 0;
        this.nBeforeFreeze = 0;
        this.lastPrevHash = null;
        this.active = true;
        logger.debug(
            `NonceEvolver bootstrap epoch=${epoch} η0=${eta0Hex.slice(0, 16)}…` +
                (opts?.etaVHex ? " (restored ηv/ηc)" : " (ηv=ηc=η0)"),
        );
    }

    snapshot(): NonceEvolverSnapshot {
        return {
            etaVHex: toHex(this.etaV),
            etaCHex: toHex(this.etaC),
            etaHHex: this.etaH && this.etaH.length ? toHex(this.etaH) : null,
            epoch: this.epoch,
            nBlocksInEpoch: this.nBlocksInEpoch,
            nBeforeFreeze: this.nBeforeFreeze,
        };
    }

    /**
     * Extract bnonce from MultiEra header body (Shelley–Alonzo nonce VRF or
     * Babbage+ single VRF). Returns null if Byron / missing.
     */
    static extractBlockNonce(header: unknown): Uint8Array | null {
        const body = (header as any)?.body ?? header;
        if (!body) return null;
        const proofHash =
            (body.nonceVrfResult?.proofHash as Uint8Array | undefined) ??
            (body.vrfResult?.proofHash as Uint8Array | undefined);
        if (!proofHash || !(proofHash instanceof Uint8Array)) return null;
        return blockNonceFromVrfProofHash(proofHash);
    }

    /**
     * UPDN one block. If slot belongs to a later epoch, runs TICKN first for each
     * crossed boundary, then applies UPDN in the new epoch.
     *
     * @returns TicknResult[] for any boundaries crossed (usually 0 or 1)
     */
    processBlock(
        slot: bigint | number,
        bnonce: Uint8Array,
        prevHash: Uint8Array | null,
    ): TicknResult[] {
        if (!this.active) {
            throw new Error("NonceEvolver.processBlock: not bootstrapped");
        }
        const s = BigInt(slot);
        const tickns: TicknResult[] = [];

        // Cross epoch boundaries before applying this block
        let blockEpoch = Number(calculatePreProdCardanoEpoch(s));
        while (blockEpoch > this.epoch) {
            tickns.push(this.tickn());
        }

        const firstNext = BigInt(
            getFirstSlotOfEpoch(this.epoch + 1, this.genesis),
        );
        // UPDN
        this.etaV = seedCombine(this.etaV, bnonce);
        if (isBeforeNonceFreeze(s, firstNext, this.stabilityWindow)) {
            this.etaC = new Uint8Array(this.etaV);
            this.nBeforeFreeze++;
        }
        this.lastPrevHash = prevHash ? new Uint8Array(prevHash) : null;
        this.nBlocksInEpoch++;
        return tickns;
    }

    /**
     * Force TICKN for current epoch → next (e.g. end of known range).
     * ηh for THIS tickn is the carried ηh; after tickn, ηh becomes lastPrevHash.
     */
    tickn(): TicknResult {
        if (!this.active) {
            throw new Error("NonceEvolver.tickn: not bootstrapped");
        }
        const nextEpoch = this.epoch + 1;
        const etaH = this.etaH ?? new Uint8Array(0);
        const eta0 = ticknNewEpochNonce(this.etaC, etaH);
        const result: TicknResult = {
            epoch: nextEpoch,
            eta0Hex: toHex(eta0),
            etaVHex: toHex(this.etaV),
            etaCHex: toHex(this.etaC),
            etaHUsedHex: etaH.length ? toHex(etaH) : null,
            nBlocksPrev: this.nBlocksInEpoch,
            nBeforeFreeze: this.nBeforeFreeze,
        };

        // Carry lab nonce for following boundary: prevHash of last block of ended epoch
        this.etaH =
            this.lastPrevHash && this.lastPrevHash.length
                ? prevHashToNonce(this.lastPrevHash)
                : null;
        this.epoch = nextEpoch;
        this.nBlocksInEpoch = 0;
        this.nBeforeFreeze = 0;
        // ηv/ηc continuous — do NOT reset to η0
        return result;
    }

    /** Invalidate continuous state (e.g. after rollback). */
    reset(): void {
        this.active = false;
        this.nBlocksInEpoch = 0;
        this.nBeforeFreeze = 0;
        this.lastPrevHash = null;
        this.etaH = null;
        logger.debug("NonceEvolver reset (inactive)");
    }
}
