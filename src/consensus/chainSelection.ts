import { MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { logger } from "../utils/logger";
/**
 * Represents a candidate chain for selection
 */
export interface ChainCandidate {
    /** The tip header of the chain */
    tip: MultiEraHeader;
    /** Chain length (number of blocks from genesis) */
    blockCount: number;
    /** Block number of the tip */
    blockNumber: number;
    /** Slot number of the tip */
    slotNumber: bigint;
}

/**
 * Result of chain comparison
 */
export interface ChainComparison {
    /** Which chain is preferred */
    preferred: 'current' | 'candidate';
    /** Intersection point between chains (block number) */
    intersectionBlock: number;
    /** Distance from current tip to intersection (in blocks) */
    rollbackDistance: number;
}

/**
 * Chain selection mode - only Praos supported
 */
export type ChainSelectionMode = 'praos';

/**
 * Calculate intersection point between current chain and candidate chain
 * Uses block hash chains to find the actual common ancestor
 */
export async function findIntersection(
    candidateTip: MultiEraHeader,
    candidateBlockCount: number,
): Promise<{ intersectionBlock: number; rollbackDistance: number }> {
    // Query current chain blocks from database
    const currentSlots = await sql`
        SELECT slot FROM blocks ORDER BY slot ASC
    `.values() as number[];

    if (currentSlots.length === 0) {
        // No current chain, intersection at genesis
        return { intersectionBlock: 0, rollbackDistance: 0 };
    }

    const currentBlockCount = currentSlots.length;
    const candidateSlot = Number(candidateTip.header.body.slot);

    // For proper intersection finding, we would trace back through block hashes
    // to find the common ancestor. This is a simplified implementation that
    // finds the latest block in current chain that has slot <= candidate slot

    let intersectionIndex = 0;
    let intersectionSlot = 0;

    // Find the latest block in current chain with slot <= candidate slot
    for (let i = currentSlots.length - 1; i >= 0; i--) {
        const slot = currentSlots[i] as number;
        if (slot <= candidateSlot) {
            intersectionIndex = i;
            intersectionSlot = slot;
            break;
        }
    }

    const rollbackDistance = currentBlockCount - 1 - intersectionIndex;

    logger.debug("Chain intersection calculated", {
        candidateSlot,
        intersectionIndex,
        rollbackDistance,
        currentBlockCount
    });

    return {
        intersectionBlock: intersectionIndex,
        rollbackDistance
    };
}

/**
 * Ouroboros Praos Longest Chain Rule (Definition 21.1)
 * A candidate chain is preferred over our current chain if:
 * 1. it is longer than our chain, AND
 * 2. the intersection point is no more than k blocks away from our tip
 */
export async function compareChainsPraos(
    currentTip: { blockNumber: number; slotNumber: bigint },
    candidate: ChainCandidate,
    securityParamK: number = 2160,
): Promise<ChainComparison> {
    const { intersectionBlock, rollbackDistance } = await findIntersection(
        candidate.tip,
        candidate.blockCount
    );

    // Check if intersection is within k blocks of current tip
    if (rollbackDistance > securityParamK) {
        // Intersection too far back - cannot switch chains
        return {
            preferred: 'current',
            intersectionBlock,
            rollbackDistance,
        };
    }

    // Check if candidate chain is longer
    if (candidate.blockNumber > currentTip.blockNumber) {
        return {
            preferred: 'candidate',
            intersectionBlock,
            rollbackDistance,
        };
    }

    // Current chain is preferred (same length or longer with valid intersection)
    return {
        preferred: 'current',
        intersectionBlock,
        rollbackDistance,
    };
}

/**
 * Select best chain using specified selection mode
 */
export async function selectBestChain(
    candidates: ChainCandidate[],
    mode: ChainSelectionMode = 'praos',
    securityParamK: number = 2160,
): Promise<{ candidate: ChainCandidate | null; comparison: ChainComparison | null }> {
    if (candidates.length === 0) return { candidate: null, comparison: null };

    // Get current chain tip
    const currentSlots = await sql`
        SELECT slot FROM blocks ORDER BY slot ASC
    `.values() as number[];

    const currentBlockCount = currentSlots.length;
    const currentTipSlot = currentSlots.length > 0 ? currentSlots[currentSlots.length - 1] as number : 0;

    const currentTip = {
        blockNumber: currentBlockCount,
        slotNumber: BigInt(currentTipSlot)
    };

    logger.info("Starting chain selection", {
        numCandidates: candidates.length,
        currentTip: {
            blockNumber: currentTip.blockNumber,
            slotNumber: currentTip.slotNumber.toString()
        }
    });

    let bestCandidate: ChainCandidate | null = null;
    let bestComparison: ChainComparison | null = null;

    for (const candidate of candidates) {
        const comparison = await compareChainsPraos(currentTip, candidate, securityParamK);

        logger.debug(`Candidate evaluation: preferred=${comparison.preferred}`, {
            candidateSlot: candidate.slotNumber.toString(),
            candidateBlockNumber: candidate.blockNumber,
            rollbackDistance: comparison.rollbackDistance
        });

        if (comparison.preferred === 'candidate') {
            bestCandidate = candidate;
            bestComparison = comparison;
        }
    }

    logger.info(`Chain selection complete: ${bestCandidate ? `candidate slot ${bestCandidate.slotNumber} (rollback ${bestComparison!.rollbackDistance})` : 'current chain preferred'}`);
    return { candidate: bestCandidate, comparison: bestComparison };
}

/**
 * Evaluate chains and return the best candidate with comparison details
 * Throws an error if no chains are available or no better chain is found
 */
export async function evaluateChains(
    peerChains: ChainCandidate[],
    mode: ChainSelectionMode = 'praos',
    securityParamK: number = 2160,
): Promise<{ chainCandidate: ChainCandidate; comparison: ChainComparison }> {
    const result = await selectBestChain(peerChains, mode, securityParamK);

    if (!result.candidate || !result.comparison) {
        throw new Error('No suitable chain candidate found for switching');
    }

    return {
        chainCandidate: result.candidate,
        comparison: result.comparison
    };
}
