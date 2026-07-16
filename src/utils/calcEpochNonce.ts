/**
 * Epoch nonce (η) helpers — Shelley ledger formal spec (SL-D5) + cardano-ledger TPraos.
 *
 * Verified against preprod immutable snapshots + external η0 (epochs 4–7):
 *
 *   ⋆ = blake2b_256(x || y)   (Appendix A.6); NeutralNonce is left/right identity
 *   bnonce = mkNonceFromOutputVRF(certifiedOutput)
 *          = blake2b_256(64-byte VRF output) = blake2b_256(proofHash)
 *          (NOT ledger-ts getNonceVrfOutput / sha2_256 of proofHash)
 *
 *   UPDN (continuous — ηv/ηc NEVER reset to η0 at epoch boundaries):
 *     ηv' = ηv ⋆ bnonce
 *     ηc' = ηv' if s + StabilityWindow < firstSlotNextEpoch else ηc
 *     StabilityWindow = floor(3 * securityParam / activeSlotsCoeff)  // preprod 129600
 *
 *   TICKN New-Epoch (updates TicknState only, not Prtcl ηv/ηc):
 *     η0' = ηc ⋆ ηh ⋆ ηe
 *     ηh  = hashHeaderToNonce(csLabNonce) at boundary
 *         = prevHash of the last applied block of the ended epoch
 *           (raw 32-byte HashHeader cast — NOT blake2b of header CBOR)
 *     ηe  = NeutralNonce (preprod extraEntropy) → identity
 *
 *   initialChainDepState: ηv=ηc=initNonce; TicknState(initNonce, NeutralNonce)
 *   → first Shelley epoch η0 = initNonce; first TICKN uses ηh=Neutral
 *
 * Phase 1: pure seed ops + TICKN helpers + DB store via storeEpochNonce.
 * Phase 2: continuous UPDN over block history (see scripts/verify-epoch-nonce-snapshots-v4.ts).
 * Mid-chain: bootstrap η0 from external once, then serve from epoch_nonces.
 */

import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "./logger";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

/** Seed combine ⋆ : blake2b_256(x || y). Empty y is NeutralNonce (identity). */
export function seedCombine(x: Uint8Array, y: Uint8Array): Uint8Array {
    if (y.length === 0) return new Uint8Array(x);
    if (x.length === 0) return new Uint8Array(y);
    const out = new Uint8Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return blake2b_256(out);
}

/**
 * Haskell: hashHeaderToNonce (HashHeader h) = Nonce (castHash h)
 * Raw 32-byte header hash as Nonce — do NOT re-hash.
 */
export function hashHeaderToNonce(headerHash: Uint8Array): Uint8Array {
    if (headerHash.length !== 32) {
        throw new Error(
            `hashHeaderToNonce: expected 32 bytes, got ${headerHash.length}`,
        );
    }
    return new Uint8Array(headerHash);
}

/**
 * Haskell: prevHashToNonce (BlockHash h) = hashHeaderToNonce h
 *          prevHashToNonce GenesisHash   = NeutralNonce (empty)
 *
 * Verified: ηh for TICKN is prevHash of the *last* block of the ended epoch
 * (csLabNonce after last apply), not blake2b(headerCbor) of that block.
 */
export function prevHashToNonce(prevHash: Uint8Array | null | undefined): Uint8Array {
    if (!prevHash || prevHash.length === 0) return new Uint8Array(0); // NeutralNonce
    return hashHeaderToNonce(prevHash);
}

/**
 * @deprecated Misnamed: used blake2b(headerCbor). Prefer hashHeaderToNonce(raw32)
 * or prevHashToNonce(lastBlock.prevHash). Kept for any external callers.
 */
export function prevHeaderHashNonce(headerCbor: Uint8Array): Uint8Array {
    return blake2b_256(headerCbor);
}

/**
 * bnonce = mkNonceFromOutputVRF(certifiedOutput)
 * proofHash (64 B in CDDL) is the certified VRF output.
 */
export function blockNonceFromVrfProofHash(proofHash: Uint8Array): Uint8Array {
    return blake2b_256(proofHash);
}

/**
 * TICKN New-Epoch: η0 = ηc ⋆ ηh ⋆ ηe
 * NeutralNonce ηe (empty) → η0 = ηc ⋆ ηh; if ηh also Neutral → η0 = ηc.
 */
export function ticknNewEpochNonce(
    candidateNonce: Uint8Array,
    prevHashNonce: Uint8Array,
    extraEntropy: Uint8Array = new Uint8Array(0),
): Uint8Array {
    let eta0 = seedCombine(candidateNonce, prevHashNonce);
    if (extraEntropy.length > 0) {
        eta0 = seedCombine(eta0, extraEntropy);
    }
    return eta0;
}

/** UPDN: η' = ηv ⋆ bnonce */
export function evolveNonce(
    evolving: Uint8Array,
    blockNonce: Uint8Array,
): Uint8Array {
    return seedCombine(evolving, blockNonce);
}

/**
 * Preprod/mainnet activeSlotsCoeff=0.05, k=securityParam → StabilityWindow = floor(3k/f).
 * Preprod: floor(3*2160/0.05) = 129600 slots.
 */
export function stabilityWindowSlots(
    securityParam: number,
    activeSlotsCoeff: number,
): number {
    if (!(securityParam > 0) || !(activeSlotsCoeff > 0)) {
        return 129_600;
    }
    return Math.floor((3 * securityParam) / activeSlotsCoeff);
}

/**
 * UPDN freeze: s + StabilityWindow < firstSlotNextEpoch (Haskell Updn.hs).
 * Equivalent: s < firstSlotNext − StabilityWindow.
 */
export function isBeforeNonceFreeze(
    slot: bigint | number,
    firstSlotNextEpoch: bigint | number,
    stabilityWindow: number,
): boolean {
    const s = BigInt(slot);
    const firstNext = BigInt(firstSlotNextEpoch);
    return s + BigInt(stabilityWindow) < firstNext;
}

/**
 * Next-epoch η0 from frozen candidate ηc and lab nonce ηh.
 *
 * @param candidateNonce ηc after UPDN through ended epoch
 * @param labPrevHash    prevHash of last block of ended epoch (32 B), or null/empty = Neutral
 * @param extraEntropy   ηe (preprod Neutral = empty)
 */
export function computeNextEpochNonceHex(
    candidateNonce: Uint8Array,
    labPrevHash: Uint8Array | null,
    extraEntropy: Uint8Array = new Uint8Array(0),
): string {
    const etaH = prevHashToNonce(labPrevHash);
    const eta0 = ticknNewEpochNonce(candidateNonce, etaH, extraEntropy);
    return toHex(eta0);
}

/**
 * @deprecated Prefer computeNextEpochNonceHex(candidate, lastBlockPrevHash).
 * opts.lastHeaderCbor is treated as raw 32-byte hash if length===32, else blake2b(cbor)
 * for backward compatibility only.
 */
export async function calcEpochNonce(
    endedEpoch: number,
    slot: number,
    opts?: {
        candidateNonce?: Uint8Array;
        /** Prefer last block's prevHash (32 B). If CBOR header bytes, hashed (legacy). */
        lastHeaderCbor?: Uint8Array;
        lastBlockPrevHash?: Uint8Array | null;
        extraEntropy?: Uint8Array;
    },
): Promise<string | null> {
    logger.debug(
        `Calculating nonce for epoch ${endedEpoch} ending at slot ${slot}`,
    );
    const newEpoch = endedEpoch + 1;
    const candidate = opts?.candidateNonce;
    if (!candidate) {
        logger.debug(
            `calcEpochNonce: missing candidate for epoch ${newEpoch}`,
        );
        return null;
    }

    let lab: Uint8Array | null = null;
    if (opts?.lastBlockPrevHash != null) {
        lab = opts.lastBlockPrevHash;
    } else if (opts?.lastHeaderCbor) {
        // 32-byte hash: use raw; longer: legacy blake2b(headerCbor)
        lab =
            opts.lastHeaderCbor.length === 32
                ? opts.lastHeaderCbor
                : blake2b_256(opts.lastHeaderCbor);
    } else {
        logger.debug(
            `calcEpochNonce: missing lab prevHash for epoch ${newEpoch}`,
        );
        return null;
    }

    const hex = computeNextEpochNonceHex(
        candidate,
        lab,
        opts?.extraEntropy ?? new Uint8Array(0),
    );
    logger.debug(`epoch ${newEpoch} nonce (TICKN)`, hex);
    return hex;
}

/** Parse hex nonce to 32-byte seed (pad/truncate safely). */
export function nonceHexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = fromHex(clean);
    if (bytes.length === 32) return bytes;
    const out = new Uint8Array(32);
    out.set(bytes.subarray(0, Math.min(32, bytes.length)));
    return out;
}
