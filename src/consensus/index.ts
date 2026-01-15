// Consensus module exports
// This module provides all consensus-related functionality for the Ouroboros Praos protocol

// Chain selection
export {
    calculateStake,
    compareChains,
    evaluateChains,
    selectBestChain,
} from "./chainSelection";
export type { ChainCandidate } from "./chainSelection";

// Block validation
export { validateHeader } from "./BlockHeaderValidator";
export { validateBlock } from "./BlockBodyValidator";

// Block application
export { applyBlock } from "./BlockApplication";

// Volatile state management
export {
    createAnchor,
    getVolatileState,
    intoStoreUpdate,
    updateVolatileState,
} from "./AnchoredVolatileState";
export type { StoreUpdate, VolatileState } from "./AnchoredVolatileState";

// Stable state management
export {
    appendBlock,
    createStreamFromExclusive,
    createStreamFromInclusive,
    createStreamIterator,
    createStreamToInclusive,
    garbageCollectVolatile,
    getBlockComponent,
    getBlockFromStable,
    getBlocksFromChunk,
    getBlocksInRange,
    getBlocksReadyForImmutable,
    getStableChain,
    getStableState,
    getTip,
    hasBlockInStable,
    initStableState,
    makeBlocksImmutable,
    reconstructChunk,
    recoverFromCorruption,
    stream,
    transitionToStable,
    validateAllChunks,
    validateChunk,
    validateIntegrity,
} from "./StableState";
export type {
    BlockComponent,
    Point,
    RealPoint,
    StableState,
    StreamFrom,
    StreamTo,
    Tip,
} from "./StableState";
export { MissingBlockError, ResourceRegistry } from "./StableState";
