import { describe, expect, test } from "bun:test";
import { Value } from "@harmoniclabs/cardano-ledger-ts";
import { unitsOf, unitsFromStoredTxOut, unitsEqual } from "./value";

describe("unitsOf", () => {
    test("ADA-only Value → lovelace", () => {
        expect([...unitsOf(Value.lovelaces(1234n))]).toEqual([["lovelace", 1234n]]);
    });
    test("multi-asset Value keeps policy+name units", () => {
        const policy = "ab".repeat(28);
        const v = Value.add(Value.lovelaces(5n), Value.singleAsset(policy, new Uint8Array([0x01, 0x02]), 7n));
        const m = unitsOf(v);
        expect(m.get("lovelace")).toBe(5n);
        expect(m.get(policy + "0102")).toBe(7n);
    });
    test("stored JSON with the ADA entry duplicated under the empty policy counts it once", () => {
        const m = unitsFromStoredTxOut({ amount: "29999999999800000", assets: { "": { "": "29999999999800000" }, ["cd".repeat(28)]: { "01": "3" } } });
        expect([...m]).toEqual([["lovelace", 29999999999800000n], ["cd".repeat(28) + "01", 3n]]);
    });
    test("bigint coin values and stored JSON agree", () => {
        expect(unitsEqual(unitsOf(99n), unitsFromStoredTxOut({ amount: "99", assets: {} }))).toBe(true);
    });
});
