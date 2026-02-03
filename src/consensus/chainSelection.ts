import { sql } from "bun";
import { logger } from "../utils/logger";

const chainLogger = logger.child("chainSelection");
/**
 * Represents a candidate chain for selection
 */
export interface ChainCandidate {
    /** The tip header of the chain */
    // tip: MultiEraHeader;  // Not needed for slot-simplified selection
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
    preferred: "current" | "candidate";
    /** Intersection point between chains (block number) */
    intersectionBlock: number;
    /** Distance from current tip to intersection (in blocks) */
    rollbackDistance: number;
}

/**
 * Chain selection mode - only Praos supported
 */
export type ChainSelectionMode = "praos";

/**
 * Calculate intersection point between current chain and candidate chain
 * Uses block hash chains to find the actual common ancestor
 */
export async function findIntersection(
    candidate: ChainCandidate,
): Promise<{ intersectionBlock: number; rollbackDistance: number }> {
    // Query current chain blocks from database
    const currentSlots = await sql`
        SELECT slot FROM blocks ORDER BY slot ASC
    `.values() as number[];

    if (currentSlots.length === 0) {
        // No current chain, intersection at genesis
        chainLogger.info(
            "No current chain blocks in DB; intersection at genesis",
        );

        return { intersectionBlock: 0, rollbackDistance: 0 };
    }

    const currentBlockCount = currentSlots.length;
    const candidateSlot = Number(candidate.slotNumber);

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

    chainLogger.debug("Chain intersection calculated", {
        candidateSlot,
        intersectionIndex,
        rollbackDistance,
        currentBlockCount,
    });

    chainLogger.rollback(
        `findIntersection: candidate slot ${candidateSlot}, intersection at block ${intersectionIndex} (rollback distance ${rollbackDistance})`,
    );

    return {
        intersectionBlock: intersectionIndex,
        rollbackDistance,
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
        candidate,
    );

    // Check if intersection is within k blocks of current tip
    if (rollbackDistance > securityParamK) {
        // Intersection too far back - cannot switch chains
        chainLogger.debug("Candidate rejected: rollback distance exceeds k", {
            rollbackDistance,
            securityParamK,
            intersectionBlock,
        });

        return {
            preferred: "current",
            intersectionBlock,
            rollbackDistance,
        };
    }

    // Check if candidate chain is longer
    if (candidate.blockNumber > currentTip.blockNumber) {
        return {
            preferred: "candidate",
            intersectionBlock,
            rollbackDistance,
        };
    }

    // Current chain is preferred (same length or longer with valid intersection)
    return {
        preferred: "current",
        intersectionBlock,
        rollbackDistance,
    };
}

/**
 * Select best chain using specified selection mode
 */
export async function selectBestChain(
    candidates: ChainCandidate[],
    mode: ChainSelectionMode = "praos",
    securityParamK: number = 2160,
): Promise<
    { candidate: ChainCandidate | null; comparison: ChainComparison | null }
> {
    if (candidates.length === 0) return { candidate: null, comparison: null };

    // Get current chain tip
    const currentSlots = await sql`
        SELECT slot FROM blocks ORDER BY slot ASC
    `.values() as number[];

    const currentBlockCount = currentSlots.length;
    const currentTipSlot = currentSlots.length > 0
        ? currentSlots[currentSlots.length - 1] as number
        : 0;

    const currentTip = {
        blockNumber: currentBlockCount,
        slotNumber: BigInt(currentTipSlot),
    };

    chainLogger.info("Starting chain selection", {
        numCandidates: candidates.length,
        currentTip: {
            blockNumber: currentTip.blockNumber,
            slotNumber: currentTip.slotNumber.toString(),
        },
    });

    chainLogger.rollback(
        `selectBestChain start: ${candidates.length} candidates, current tip blocks=${currentTip.blockNumber} slot=${currentTip.slotNumber}`,
    );

    chainLogger.debug("Current chain tip determined from DB", {
        blockNumber: currentTip.blockNumber,
        slotNumber: currentTip.slotNumber.toString(),
        dbBlockCount: currentSlots.length,
    });

    let bestCandidate: ChainCandidate | null = null;
    let bestComparison: ChainComparison | null = null;

    for (const candidate of candidates) {
        const comparison = await compareChainsPraos(
            currentTip,
            candidate,
            securityParamK,
        );

        chainLogger.debug(
            `Candidate evaluation: preferred=${comparison.preferred}`,
            {
                candidateSlot: candidate.slotNumber.toString(),
                candidateBlockNumber: candidate.blockNumber,
                rollbackDistance: comparison.rollbackDistance,
            },
        );

        chainLogger.rollback(
            `Candidate ${candidate.slotNumber}: preferred=${comparison.preferred}, rollbackDistance=${comparison.rollbackDistance}`,
        );

        if (comparison.preferred === "candidate") {
            bestCandidate = candidate;
            bestComparison = comparison;
        }
    }

    chainLogger.info(
        `Chain selection complete: ${
            bestCandidate
                ? `candidate slot ${bestCandidate.slotNumber} (rollback ${
                    bestComparison!.rollbackDistance
                })`
                : "current chain preferred"
        }`,
    );

    chainLogger.rollback(
        `selectBestChain complete: ${
            bestCandidate
                ? `prefer candidate slot ${bestCandidate.slotNumber.toString()} (rollback ${
                    bestComparison!.rollbackDistance
                })`
                : "current preferred"
        }`,
    );

    return { candidate: bestCandidate, comparison: bestComparison };
}

/**
 * Evaluate chains and return the best candidate with comparison details
 * Throws an error if no chains are available or no better chain is found
 */
export async function evaluateChains(
    peerChains: ChainCandidate[],
    mode: ChainSelectionMode = "praos",
    securityParamK: number = 2160,
): Promise<{ chainCandidate: ChainCandidate; comparison: ChainComparison }> {
    const result = await selectBestChain(peerChains, mode, securityParamK);

    if (!result.candidate || !result.comparison) {
        chainLogger.warn("evaluateChains: no suitable candidate found", {
            numCandidates: peerChains.length,
            mode,
            securityParamK,
        });

        throw new Error("No suitable chain candidate found for switching");
    }

    return {
        chainCandidate: result.candidate,
        comparison: result.comparison,
    };
}
