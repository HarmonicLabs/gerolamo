import {
    ChainCandidate,
    compareChains,
    evaluateChains,
    selectBestChain,
} from "../consensus/chainSelection";
import { MultiEraHeader } from "@harmoniclabs/cardano-ledger-ts";
import { sql } from "bun";
import { logger } from "../utils/logger";

/**
 * Manages chain candidates from multiple peers and selects the best chain
 */
export class ChainManager {
    private candidates = new Map<string, ChainCandidate>();

    /**
     * Add or update a chain candidate from a peer
     */
    async addChainCandidate(
        peerId: string,
        tip: MultiEraHeader,
        stake: bigint,
        length: number,
    ) {
        const candidate: ChainCandidate = { tip, stake, length };
        this.candidates.set(peerId, candidate);

        logger.debug(
            `Added chain candidate from ${peerId}: stake=${stake}, length=${length}, slot=${tip.header.body.slot}`,
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
    async getBestChain(): Promise<ChainCandidate | null> {
        if (this.candidates.size === 0) return null;

        const candidates = Array.from(this.candidates.values());
        return await evaluateChains(candidates);
    }

    /**
     * Check if the current tip should be updated
     */
    async shouldSwitchChain(): Promise<boolean> {
        const bestCandidate = await this.getBestChain();
        if (!bestCandidate) return false;

        // Get current tip from database
        const currentTipRows = await sql`
            SELECT hash, slot FROM current_tip WHERE id = 1
        `.values() as [Uint8Array, number][];

        if (currentTipRows.length === 0) return true; // No current tip

        const [currentHash, currentSlot] = currentTipRows[0];
        const candidateSlot = Number(bestCandidate.tip.header.body.slot);

        // Switch if candidate has higher slot (simplified - should use full comparison)
        return candidateSlot > currentSlot;
    }

    /**
     * Apply the best chain by updating the database tip
     */
    async applyBestChain() {
        const bestCandidate = await this.getBestChain();
        if (!bestCandidate) return;

        // For now, calculate hash from header CBOR (simplified)
        // TODO: Get proper hash from MultiEraHeader
        const tipSlot = Number(bestCandidate.tip.header.body.slot);

        // This is a placeholder - need proper hash calculation
        const tipHash = new Uint8Array(32); // Placeholder

        await sql`
            UPDATE current_tip SET hash = ${tipHash}, slot = ${tipSlot} WHERE id = 1
        `;

        logger.info(`Switched to best chain: slot=${tipSlot}`);
    }

    /**
     * Get current chain tip for a peer
     */
    getChainTip(peerId: string): ChainCandidate | undefined {
        return this.candidates.get(peerId);
    }

    /**
     * Get all current chain candidates
     */
    getAllCandidates(): Map<string, ChainCandidate> {
        return new Map(this.candidates);
    }
}
