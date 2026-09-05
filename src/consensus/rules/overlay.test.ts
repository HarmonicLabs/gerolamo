import { describe, expect, test } from "bun:test";
import { overlaySlotKind, rationalFromDecimal } from "./overlay";

const keys = ["a", "b", "c", "d", "e", "f", "g"].map((k) => k.repeat(56)).sort();
const f = rationalFromDecimal("0.05"); // ceiling(1/f) = 20

describe("overlay schedule", () => {
    test("d = 1: every slot is overlay; every 20th is active and rotates through the genesis keys", () => {
        const d = rationalFromDecimal("1");
        expect(overlaySlotKind(0n, 0n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[0] });
        expect(overlaySlotKind(1n, 0n, d, f, keys)).toEqual({ kind: "inactive" });
        expect(overlaySlotKind(20n, 0n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[1] });
        expect(overlaySlotKind(140n, 0n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[0] });
        expect(overlaySlotKind(1000n + 20n, 1000n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[1] });
    });
    test("d = 0: no overlay", () => {
        expect(overlaySlotKind(5n, 0n, rationalFromDecimal("0"), f, keys)).toEqual({ kind: "praos" });
    });
    test("d = 0.5: alternate slots are overlay", () => {
        const d = rationalFromDecimal("0.5");
        // Shelley: step x = ceiling(x·d). s=0: ceil(0)=0 < ceil(0.5)=1 → overlay, position 0 → active, key 0;
        // s=1: ceil(0.5)=1 < ceil(1)=1? no → praos; s=2: 1 < 2 → overlay, position ceil(1)=1 → inactive
        expect(overlaySlotKind(0n, 0n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[0] });
        expect(overlaySlotKind(1n, 0n, d, f, keys)).toEqual({ kind: "praos" });
        expect(overlaySlotKind(2n, 0n, d, f, keys)).toEqual({ kind: "inactive" });
        // s=40: ceil(20)=20 < ceil(20.5)=21 → overlay, position 20 → active, key index 1
        expect(overlaySlotKind(40n, 0n, d, f, keys)).toEqual({ kind: "genesis", genesisKeyHash: keys[1] });
        expect(overlaySlotKind(39n, 0n, d, f, keys)).toEqual({ kind: "praos" });
    });
});

describe("overlay schedule against mainnet epoch 211 (d = 0.9)", () => {
    // Genesis keys of mainnet sorted; slot 5788800 (s = 0) was issued by the delegate of
    // the first key (448570802283…); s = 1 and 2 are inactive overlay slots, s = 10 Praos.
    const keys = ["162f94554ac8", "2075a095b3c8", "268cfc0b89e9", "60baee25cbc9", "ad5463153dc3", "b9547b8a5765", "f7b341c14cd5"];
    const d = rationalFromDecimal("0.9"), asc = rationalFromDecimal("0.05");
    const kind = (s: number) => overlaySlotKind(5788800n + BigInt(s), 5788800n, d, asc, keys);
    test("the first slot of the epoch is an active overlay slot for the first genesis key", () => {
        expect(kind(0)).toEqual({ kind: "genesis", genesisKeyHash: "162f94554ac8" });
    });
    test("ceiling steps: slots 1, 2 inactive; slot 10 Praos (d·10 = 9 = d·9 rounded up? no: ceil(9.0)=9, ceil(9.9)=10 → overlay, position 9, inactive); slot 20 → position 18, inactive", () => {
        expect(kind(1)).toEqual({ kind: "inactive" });
        expect(kind(2)).toEqual({ kind: "inactive" });
        expect(kind(10)).toEqual({ kind: "inactive" });
        expect(kind(20)).toEqual({ kind: "inactive" });
    });
    test("with d = 1 every slot is overlay and every 20th is active", () => {
        const one = rationalFromDecimal("1");
        expect(overlaySlotKind(100n, 100n, one, asc, keys)).toEqual({ kind: "genesis", genesisKeyHash: "162f94554ac8" });
        expect(overlaySlotKind(120n, 100n, one, asc, keys)).toEqual({ kind: "genesis", genesisKeyHash: "2075a095b3c8" });
        expect(overlaySlotKind(101n, 100n, one, asc, keys)).toEqual({ kind: "inactive" });
    });
});
