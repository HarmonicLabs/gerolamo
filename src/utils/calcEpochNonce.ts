/**
 * Epoch nonce (η) helpers from Shelley ledger formal spec (SL-D5).
 *
 * Seed op ⋆ :  blake2b_256(x || y)   (Appendix A.6)
 * TICKN New-Epoch:  η0 := ηc ⋆ ηh ⋆ ηe ,  ηh' := ηph
 * UPDN Update-Both: ηv' = ηc' = ηv ⋆ η
 * UPDN Only-Evolve: ηv' = ηv ⋆ η , ηc frozen
 *
 * Phase 1: pure seed ops + TICKN for epoch boundary.
 * Full UPDN over every block VRF needs continuous header history (phase 2).
 * Mid-chain sync still bootstraps η0 from external (Blockfrost/onchainapps)
 * and persists it locally via db.storeEpochNonce.
 */

import { blake2b_256 } from "@harmoniclabs/crypto";
import { logger } from "./logger";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";

/** Seed combine ⋆ : blake2b_256(x || y). Empty y is allowed (NeutralNonce). */
export function seedCombine(x: Uint8Array, y: Uint8Array): Uint8Array {
    const out = new Uint8Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return blake2b_256(out);
}

/** ηh from last block header of previous epoch (header hash as seed). */
export function prevHeaderHashNonce(headerCbor: Uint8Array): Uint8Array {
    return blake2b_256(headerCbor);
}

/**
 * TICKN New-Epoch: η0 = ηc ⋆ ηh ⋆ ηe
 * NeutralNonce → ηe is empty; still apply ⋆ so η0 = blake2b(ηc||ηh) when ηe empty.
 */
export function ticknNewEpochNonce(
    candidateNonce: Uint8Array,
    prevHashNonce: Uint8Array,
    extraEntropy: Uint8Array = new Uint8Array(0),
): Uint8Array {
    const cStarH = seedCombine(candidateNonce, prevHashNonce);
    if (extraEntropy.length === 0) return cStarH;
    return seedCombine(cStarH, extraEntropy);
}

/** UPDN: η' = ηv ⋆ η  (block nonce η from VRF output). */
export function evolveNonce(evolving: Uint8Array, blockNonce: Uint8Array): Uint8Array {
    return seedCombine(evolving, blockNonce);
}

/**
 * Preprod/mainnet activeSlotsCoeff=0.05, k=securityParam → StabilityWindow ≈ 3k/f.
 * Preprod: 3*2160/0.05 = 129600 slots.
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

/** True when slot is still before freeze: s < firstSlot(e+1) − StabilityWindow. */
export function isBeforeNonceFreeze(
    slot: bigint | number,
    firstSlotNextEpoch: bigint | number,
    stabilityWindow: number,
): boolean {
    const s = BigInt(slot);
    const freezeAt = BigInt(firstSlotNextEpoch) - BigInt(stabilityWindow);
    return s < freezeAt;
}

/**
 * Compute next-epoch η0 when we have ηc (frozen candidate) and last header of ended epoch.
 * Returns hex nonce for storage / VRF input.
 */
export function computeNextEpochNonceHex(
    candidateNonce: Uint8Array,
    lastHeaderCbor: Uint8Array,
    extraEntropy: Uint8Array = new Uint8Array(0),
): string {
    const etaH = prevHeaderHashNonce(lastHeaderCbor);
    const eta0 = ticknNewEpochNonce(candidateNonce, etaH, extraEntropy);
    return toHex(eta0);
}

/**
 * Legacy stub entry (kept for call sites). Prefer pure helpers above + DB storage.
 * @deprecated use computeNextEpochNonceHex + storeEpochNonce
 */
export async function calcEpochNonce(
    endedEpoch: number,
    slot: number,
    opts?: {
        candidateNonce?: Uint8Array;
        lastHeaderCbor?: Uint8Array;
        extraEntropy?: Uint8Array;
    },
): Promise<string | null> {
    logger.debug(
        `Calculating nonce for epoch ${endedEpoch} ending at slot ${slot}`,
    );
    const newEpoch = endedEpoch + 1;
    const candidate = opts?.candidateNonce;
    const lastHdr = opts?.lastHeaderCbor;
    if (!candidate || !lastHdr) {
        logger.debug(
            `calcEpochNonce: missing candidate/header for epoch ${newEpoch} (need full history or external bootstrap)`,
        );
        return null;
    }
    const hex = computeNextEpochNonceHex(
        candidate,
        lastHdr,
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
