import {
    ChainCandidate,
    ChainComparison,
    ChainSelectionMode,
    evaluateChains,
} from "../consensus/chainSelection";
import { MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { logger } from "../utils/logger";

/**
 * Manages chain candidates from multiple peers and selects the best chain
 */
export class ChainManager {
    private candidates = new Map<string, ChainCandidate>();
    private rollbackPoints = new Map<number, { hash: Uint8Array; ledgerState: any }>();

    /**
     * Add or update a chain candidate from a peer
     */
    async addChainCandidate(
        peerId: string,
        tip: MultiEraHeader,
        blockCount: number,
        blockNumber: number,
    ) {
        const candidate: ChainCandidate = {
            tip,
            blockCount,
            blockNumber,
            slotNumber: tip.header.body.slot,
        };
        this.candidates.set(peerId, candidate);

        logger.debug(
            `Added chain candidate from ${peerId}: blocks=${blockCount}, blockNo=${blockNumber}, slot=${tip.header.body.slot}`,
        );
    }

    /**
     * Remove a chain candidate (when peer disconnects)
     */
    removeChainCandidate(peerId: string) {
        this.candidates.delete(peerId);
        logger.debug(`Removed chain candidate for ${peerId}`);
    }

    /**
     * Evaluate all chain candidates and return the best one
     */
    async getBestChain(
        mode: ChainSelectionMode = 'praos',
        securityParamK: number = 2160,
    ): Promise<{ candidate: ChainCandidate | null; comparison: ChainComparison | null }> {
        if (this.candidates.size === 0) return { candidate: null, comparison: null };

        try {
            const candidates = Array.from(this.candidates.values());
            const result = await evaluateChains(candidates, mode, securityParamK);
            return { candidate: result.chainCandidate, comparison: result.comparison };
        } catch (error) {
            // No suitable chain found
            return { candidate: null, comparison: null };
        }
    }

    /**
     * Check if the current tip should be updated
     */
    async shouldSwitchChain(
        mode: ChainSelectionMode = 'praos',
        securityParamK: number = 2160,
    ): Promise<boolean> {
        try {
            const candidates = Array.from(this.candidates.values());
            await evaluateChains(candidates, mode, securityParamK);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Apply the best chain by updating the database tip and rolling back if necessary
     */
    async applyBestChain(
        mode: ChainSelectionMode = 'praos',
        securityParamK: number = 2160,
    ) {
        const candidates = Array.from(this.candidates.values());
        const { chainCandidate: candidate, comparison } = await evaluateChains(candidates, mode, securityParamK);

        // Check rollback distance for security
        if (comparison.rollbackDistance > securityParamK) {
            logger.error(`Cannot switch chains: rollback distance ${comparison.rollbackDistance} exceeds security parameter ${securityParamK}`);
            return;
        }

        logger.info(`Switching to best chain: rollback=${comparison.rollbackDistance} blocks, intersection=${comparison.intersectionBlock}`);

        // If rollback is needed, restore to intersection point
        if (comparison.rollbackDistance > 0) {
            const rollbackSuccess = await this.rollbackToBlock(comparison.intersectionBlock);
            if (!rollbackSuccess) {
                logger.error("Failed to rollback to intersection point, aborting chain switch");
                return;
            }
        }

        // Apply the new chain from the candidate
        // For now, just update the tip - real implementation would apply candidate blocks
        const tipSlot = Number(candidate.slotNumber);
        const tipBlockNo = candidate.blockNumber;

        // Placeholder hash calculation - real implementation would use candidate's actual hash
        const tipHash = new Uint8Array(32);

        await sql`
            UPDATE current_tip SET hash = ${tipHash}, slot = ${tipSlot} WHERE id = 1
        `;

        logger.info(`Switched to best chain: slot=${tipSlot}, block=${tipBlockNo}`);

        // Save rollback point at new tip
        await this.saveRollbackPoint(tipBlockNo);
    }

    /**
     * Get current chain tip for a peer
     */
    getChainTip(peerId: string): ChainCandidate | undefined {
        return this.candidates.get(peerId);
    }

    /**
     * Save a rollback point for ledger state restoration
     */
    async saveRollbackPoint(blockNumber: number): Promise<void> {
        try {
            // Get current ledger state (simplified - would need full snapshot)
            const ledgerStateRows = await sql`
                SELECT state FROM ledger_state WHERE id = 1
            `.values() as [string][];

            const currentTipRows = await sql`
                SELECT hash FROM current_tip WHERE id = 1
            `.values() as [Uint8Array][];

            if (ledgerStateRows.length > 0 && currentTipRows.length > 0) {
                this.rollbackPoints.set(blockNumber, {
                    hash: currentTipRows[0][0],
                    ledgerState: ledgerStateRows[0][0],
                });
                logger.debug(`Saved rollback point at block ${blockNumber}`);
            }
        } catch (error) {
            logger.error(`Failed to save rollback point at block ${blockNumber}:`, error);
        }
    }

    /**
     * Rollback to a specific block number
     */
    async rollbackToBlock(blockNumber: number): Promise<boolean> {
        const rollbackPoint = this.rollbackPoints.get(blockNumber);
        if (!rollbackPoint) {
            logger.error(`No rollback point found for block ${blockNumber}`);
            return false;
        }

        try {
            // Restore ledger state
            await sql`
                UPDATE ledger_state SET state = ${rollbackPoint.ledgerState} WHERE id = 1
            `;

            // Restore tip
            await sql`
                UPDATE current_tip SET hash = ${rollbackPoint.hash} WHERE id = 1
            `;

            // Remove more recent rollback points
            for (const [pointBlock] of this.rollbackPoints) {
                if (pointBlock > blockNumber) {
                    this.rollbackPoints.delete(pointBlock);
                }
            }

            logger.info(`Rolled back to block ${blockNumber}`);
            return true;
        } catch (error) {
            logger.error(`Failed to rollback to block ${blockNumber}:`, error);
            return false;
        }
    }

    /**
     * Get all current chain candidates
     */
    getAllCandidates(): Map<string, ChainCandidate> {
        return new Map(this.candidates);
    }
}
