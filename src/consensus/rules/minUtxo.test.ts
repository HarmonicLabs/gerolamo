import { describe, expect, test } from "bun:test";
import { alonzoMinUtxo, maryMinUtxo, valueSizeWords } from "./value";
import { tierRefScriptFee } from "./txRules";

const P = "a".repeat(56);
const oneToken = new Map([["lovelace", 1n], [P, 1n]]);

describe("min UTxO formulas", () => {
    test("value size in words", () => {
        expect(valueSizeWords(new Map([["lovelace", 5n]]))).toBe(2);
        expect(valueSizeWords(oneToken)).toBe(11); // 6 + ⌈(12 + 0 + 28)/8⌉
        expect(valueSizeWords(new Map([[P + "61".repeat(32), 1n]]))).toBe(15); // 12 + 32 + 28 = 72 → 9
    });
    test("Mary: one token with an empty name needs 1.407406 ADA at minUTxOValue 1 ADA", () => {
        expect(maryMinUtxo(oneToken, 1_000_000n)).toBe(1_407_406n);
        expect(maryMinUtxo(new Map([["lovelace", 1n]]), 1_000_000n)).toBe(1_000_000n);
        expect(maryMinUtxo(new Map([[P + "61".repeat(32), 1n]]), 1_000_000n)).toBe(1_555_554n);
    });
    test("Alonzo: 0.999978 ADA for ADA-only, 1.310316 for one token, +10 words for a datum hash", () => {
        expect(alonzoMinUtxo(new Map([["lovelace", 1n]]), 34482n, false)).toBe(999_978n);
        expect(alonzoMinUtxo(oneToken, 34482n, false)).toBe(1_310_316n);
        expect(alonzoMinUtxo(new Map([["lovelace", 1n]]), 34482n, true)).toBe(1_344_798n);
    });
});

describe("Conway tiered reference-script fee", () => {
    test("15 lovelace/byte, ×1.2 every 25 600 bytes, floored", () => {
        expect(tierRefScriptFee(0, 15)).toBe(0n);
        expect(tierRefScriptFee(1000, 15)).toBe(15_000n);
        expect(tierRefScriptFee(25600, 15)).toBe(384_000n);
        expect(tierRefScriptFee(25601, 15)).toBe(384_018n);
        // 25600·15 + 25600·18 + 25600·21.6 + 5120·25.92 = 1 530 470.4
        expect(tierRefScriptFee(81920, 15)).toBe(1_530_470n);
    });
});
