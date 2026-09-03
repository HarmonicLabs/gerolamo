import { afterEach, describe, expect, test } from "bun:test";
import {
    calculatePreProdCardanoEpoch,
    epochForSlot,
    firstSlotOfEpoch,
    getEpochNetwork,
    setEpochNetwork,
} from "./epochFromSlotCalculations";

afterEach(() => setEpochNetwork("preprod"));

describe("epoch geometry", () => {
    test("preprod: Byron epochs 0–3, Shelley from slot 86400 = epoch 4", () => {
        expect(epochForSlot(0n, "preprod")).toBe(0n);
        expect(epochForSlot(86_399n, "preprod")).toBe(3n);
        expect(epochForSlot(86_400n, "preprod")).toBe(4n);
        expect(epochForSlot(10_454_400n, "preprod")).toBe(28n);
        expect(firstSlotOfEpoch(28n, "preprod")).toBe(10_454_400n);
    });

    test("mainnet: 208 Byron epochs, Shelley from slot 4 492 800 = epoch 208", () => {
        expect(epochForSlot(7_000n, "mainnet")).toBe(0n);
        expect(epochForSlot(4_492_799n, "mainnet")).toBe(207n);
        expect(epochForSlot(4_492_800n, "mainnet")).toBe(208n);
        // Blockfrost: slot 196 841 595 is in epoch 653 (2026-09)
        expect(epochForSlot(196_841_595n, "mainnet")).toBe(653n);
        expect(firstSlotOfEpoch(208n, "mainnet")).toBe(4_492_800n);
        expect(firstSlotOfEpoch(653n, "mainnet")).toBe(4_492_800n + 445n * 432_000n);
    });

    test("preview: no Byron era, 86400-slot epochs", () => {
        expect(epochForSlot(86_399n, "preview")).toBe(0n);
        expect(epochForSlot(86_400n, "preview")).toBe(1n);
    });

    test("legacy helper follows the active network", () => {
        expect(getEpochNetwork()).toBe("preprod");
        expect(calculatePreProdCardanoEpoch(7_000)).toBe(0n);
        expect(calculatePreProdCardanoEpoch(100_000)).toBe(4n);
        setEpochNetwork("mainnet");
        expect(calculatePreProdCardanoEpoch(100_000)).toBe(4n); // still Byron on mainnet (epoch 4 of 208)
        expect(calculatePreProdCardanoEpoch(4_492_800)).toBe(208n);
        expect(setEpochNetwork("bogus")).toBe("preprod");
    });
});

import { slotInEpoch, slotToUnixTime } from "./epochFromSlotCalculations";

describe("slotToUnixTime / slotInEpoch", () => {
    test("mainnet: genesis, last Byron slot, first Shelley slot, and a Conway slot", () => {
        expect(slotToUnixTime(0, "mainnet")).toBe(1_506_203_091);
        expect(slotToUnixTime(4_492_799, "mainnet")).toBe(1_506_203_091 + 4_492_799 * 20);
        expect(slotToUnixTime(4_492_800, "mainnet")).toBe(1_596_059_091); // 2020-07-29T21:44:51Z
        expect(slotToUnixTime(72_316_896, "mainnet")).toBe(1_596_059_091 + (72_316_896 - 4_492_800));
        expect(slotInEpoch(4_492_800, "mainnet")).toBe(0n);
        expect(slotInEpoch(4_492_800 + 432_000 + 5, "mainnet")).toBe(5n);
    });
    test("preprod: Byron slots are 20 s until slot 86400; preview is all 1 s", () => {
        expect(slotToUnixTime(0, "preprod")).toBe(1_655_769_600);
        expect(slotToUnixTime(86_400, "preprod")).toBe(1_655_769_600 + 86_400 * 20);
        expect(slotToUnixTime(86_401, "preprod")).toBe(1_655_769_600 + 86_400 * 20 + 1);
        expect(slotToUnixTime(100, "preview")).toBe(1_666_656_000 + 100);
    });
});
