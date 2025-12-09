import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { SQLNewEpochState } from "./ledger";

/**
 * Applies a validated block to the ledger state according to Praos consensus rules
 */
export class BlockApplier {
    constructor(_ledgerState: SQLNewEpochState) {
        // Ledger state not currently used in block application
    }

    /**
     * Apply a validated block to the ledger state
     */
    async applyBlock(_block: MultiEraBlock, _slot: bigint): Promise<void> {
        // TODO: Implement block application logic
        // Currently a no-op as the required ledger state methods are not implemented
    }
}
