import { BabbageBlock, MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { SQLNewEpochState } from "./ledger";
import { validateBlock } from "./BlockBodyValidator";

export class BlockValidator {
    private lState: SQLNewEpochState;

    constructor(lState: SQLNewEpochState) {
        this.lState = lState;
    }

    async validateBlock(block: MultiEraBlock, _slot: bigint): Promise<boolean> {
        // For now, delegate to the existing validateBlock function
        // In the future, this could include additional validation logic
        return await validateBlock(block, this.lState);
    }
}
