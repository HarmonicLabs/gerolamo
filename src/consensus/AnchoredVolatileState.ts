import { VolatileState } from "./validation/types";
import { Hash32, PoolKeyHash } from "@harmoniclabs/cardano-ledger-ts";

// Point interface for anchoring
export interface Point {
    slot: bigint;
    hash: Hash32;
}

// AnchoredVolatileState wraps a VolatileState with an anchor point
// Based on Amaru's AnchoredVolatileState design
export class AnchoredVolatileState {
    constructor(
        public anchor: [Point, PoolKeyHash],
        public state: VolatileState,
    ) {}

    // Create an anchored volatile state from a volatile state
    static anchor(
        state: VolatileState,
        point: Point,
        issuer: PoolKeyHash,
    ): AnchoredVolatileState {
        return new AnchoredVolatileState([point, issuer], state);
    }

    // Get the anchor point
    get point(): Point {
        return this.anchor[0];
    }

    // Get the issuer pool key hash
    get issuer(): PoolKeyHash {
        return this.anchor[1];
    }

    // Convert to store update (similar to Amaru's into_store_update)
    intoStoreUpdate(): StoreUpdate {
        return new StoreUpdate(this.point, this.issuer, this.state._fees);
    }
}

// Simplified StoreUpdate for Gerolamo
export class StoreUpdate {
    constructor(
        public point: Point,
        public issuer: PoolKeyHash,
        public fees: any, // Value type from cardano-ledger-ts
    ) {}
}
