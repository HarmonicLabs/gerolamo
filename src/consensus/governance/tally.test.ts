import { describe, expect, test } from "bun:test";
import { paramGroups, rationalOf } from "./tally";

describe("Conway parameter groups", () => {
    test("each parameter's DRep group and the security group (cardano-ledger ConwayPParams)", () => {
        expect([...paramGroups(["a0"])]).toEqual(["technical"]);
        expect([...paramGroups(["min_fee_a"])].sort()).toEqual(["economic", "security"]);
        expect([...paramGroups(["max_tx_ex_mem"])]).toEqual(["network"]); // not a security parameter
        expect([...paramGroups(["max_block_ex_mem"])].sort()).toEqual(["network", "security"]);
        expect([...paramGroups(["gov_action_deposit"])].sort()).toEqual(["gov", "security"]);
        expect([...paramGroups(["drep_deposit"])]).toEqual(["gov"]);
        expect([...paramGroups(["key_deposit", "pool_deposit", "min_pool_cost"])]).toEqual(["economic"]);
    });
    test("rationals from stored parameter values", () => {
        expect(rationalOf("0.67", "1")).toEqual({ num: 67n, den: 100n });
        expect(rationalOf(1, "1")).toEqual({ num: 1n, den: 1n });
        expect(rationalOf("bogus", "0.5")).toEqual({ num: 5n, den: 10n });
    });
});
