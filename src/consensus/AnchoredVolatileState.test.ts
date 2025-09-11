import { expect, test } from "bun:test";
import { Hash32, PoolKeyHash, Value } from "@harmoniclabs/cardano-ledger-ts";
import { VolatileDB } from "./VolatileDB";
import { AnchoredVolatileState, Point } from "./AnchoredVolatileState";
import { VolatileState } from "./validation/types";

test("Anchoring VolatileState", async () => {
    // Create VolatileDB to manage anchored states
    const volatileDB = new VolatileDB();

    // Mock issuer pool key hash
    const issuer = new PoolKeyHash(
        Buffer.from("mockpoolkeyhash12345678901234567890123456789012", "hex"),
    );

    // Create mock volatile states for demonstration
    const genesisVolatileState = new VolatileState(
        [],
        undefined,
        undefined,
        Value.lovelaces(0n),
    );
    const nextVolatileState = new VolatileState(
        [],
        undefined,
        undefined,
        Value.lovelaces(1000n),
    );

    // Create anchor points
    const genesisPoint: Point = {
        slot: 100n,
        hash: new Hash32(new Uint8Array(32).fill(1)), // Mock genesis hash
    };

    // Create anchored states
    const genesisAnchoredState = AnchoredVolatileState.anchor(
        genesisVolatileState,
        genesisPoint,
        issuer,
    );
    expect(genesisAnchoredState).toBeDefined();
    expect(genesisAnchoredState.point.slot).toBe(100n);
    expect(genesisAnchoredState.point.hash).toBeDefined();

    // Add to volatile DB
    volatileDB.pushBack(genesisAnchoredState);
    expect(volatileDB.len()).toBe(1);

    // Create next anchored state, anchoring it to the genesis block
    const nextAnchoredState = AnchoredVolatileState.anchor(
        nextVolatileState,
        genesisPoint,
        issuer,
    );
    expect(nextAnchoredState).toBeDefined();
    expect(nextAnchoredState.point.slot).toBe(100n); // Anchored to genesis
    expect(nextAnchoredState.point.hash).toBeDefined();

    // Add to volatile DB
    volatileDB.pushBack(nextAnchoredState);
    expect(volatileDB.len()).toBe(2);

    // Test rollback functionality
    const rollbackSuccess = volatileDB.rollbackTo(genesisPoint);
    expect(rollbackSuccess).toBe(true);
    expect(volatileDB.len()).toBe(1);

    // Verify the anchoring worked
    const finalState = volatileDB.viewBack();
    expect(finalState).toBeDefined();
    if (finalState) {
        expect(finalState.point.slot).toBe(100n);
        expect(finalState.issuer).toBeDefined();
        expect(finalState.state).toBeDefined();
    }
});
