import { MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";

/**
 * Represents a candidate chain for selection
 */
export interface ChainCandidate {
    /** The tip header of the chain */
    tip: MultiEraHeader;
    /** The stake backing this chain (from pool distribution) */
    stake: bigint;
    /** Chain length (number of blocks) */
    length: number;
}

/**
 * Compare two chain candidates and return the better one
 * Based on Ouroboros Praos chain selection: prefer higher stake density, then longer chains, then higher slot
 */
export function compareChains(
    chainA: ChainCandidate,
    chainB: ChainCandidate,
): ChainCandidate {
    // Primary: Stake density (stake per length, approximating chain quality)
    const densityA = chainA.length > 0
        ? Number(chainA.stake) / chainA.length
        : 0;
    const densityB = chainB.length > 0
        ? Number(chainB.stake) / chainB.length
        : 0;
    if (densityA > densityB) {
        return chainA;
    }
    if (densityA < densityB) {
        return chainB;
    }

    // Secondary: Chain length
    if (chainA.length > chainB.length) {
        return chainA;
    }
    if (chainA.length < chainB.length) {
        return chainB;
    }

    // Tiebreaker: Slot number (prefer more recent)
    if (chainA.tip.header.body.slot > chainB.tip.header.body.slot) {
        return chainA;
    }

    return chainB;
}

/**
 * Select the best chain from a list of candidates
 */
export function selectBestChain(
    candidates: ChainCandidate[],
): ChainCandidate | null {
    if (candidates.length === 0) return null;

    return candidates.reduce((best, current) => compareChains(best, current));
}

/**
 * Calculate stake for a chain candidate
 */
export async function calculateStake(
    _candidate: ChainCandidate,
): Promise<bigint> {
    // Query total active stake from database
    const poolDistrRows =
        await sql`SELECT total_active_stake FROM pool_distr WHERE id = 1`
            .values() as [bigint][];
    if (poolDistrRows.length === 0) {
        return 0n;
    }
    return poolDistrRows[0][0];
}

/**
 * Evaluate and select the best chain from peers
 * TODO: Integrate with PeerManager
 */
export async function evaluateChains(
    peerChains: ChainCandidate[],
): Promise<ChainCandidate | null> {
    // Calculate stake for each chain in parallel
    await Promise.all(
        peerChains.map((chain) =>
            calculateStake(chain).then((stake) => {
                chain.stake = stake;
            })
        ),
    );

    return selectBestChain(peerChains);
}
