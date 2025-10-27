import { BabbageBlock } from "@harmoniclabs/cardano-ledger-ts";
import { SQLNewEpochState } from "./ledger";
import { validateBlock } from "./BlockBodyValidator";

export class BlockValidator {
    private lState: SQLNewEpochState;

    constructor(lState: SQLNewEpochState) {
        this.lState = lState;
    }

    validateBlock(block: BabbageBlock, _slot: bigint): boolean {
        // For now, delegate to the existing validateBlock function
        // In the future, this could include additional validation logic
        return validateBlock(block, this.lState);
    }
}