import { describe, expect, test } from "bun:test";
import { applyOverlay, applyOverlays, type BlockOverlay, type BlockRuleInputs } from "./blockRulesPure";

const u = (ref: string) => ({ ref, address: "addr_test1x", value: new Map([["lovelace", 1n]]), referenceScriptHash: null, hasDatum: false });
const ov = (created: string[], spent: string[], pools: string[] = [], withdrawn: string[] = []): BlockOverlay => ({
    created: new Map(created.map((r) => [r, u(r)])), spent: new Set(spent), poolsRegistered: new Set(pools), withdrawnCreds: new Set(withdrawn),
});

describe("applyOverlays", () => {
    test("equals folding applyOverlay in order", () => {
        const inputs: BlockRuleInputs = {
            resolved: new Map([["a", u("a")], ["b", u("b")]]),
            rows: new Map([["a", { utxo_ref: "a" } as any], ["b", { utxo_ref: "b" } as any]]),
            pools: new Set(["p0"]),
            rewardBalances: new Map([["c1", 5n], ["c2", 7n]]),
        };
        const overlays = [ov(["c"], ["a"], ["p1"]), ov(["d", "a"], ["c"], [], ["c1"]), ov([], ["d"], ["p2"], ["c9"])];
        let folded: BlockRuleInputs = inputs;
        for (const o of overlays) folded = applyOverlay(folded, o);
        const once = applyOverlays(inputs, overlays);
        expect([...once.resolved.keys()].sort()).toEqual([...folded.resolved.keys()].sort());
        expect([...once.rows!.keys()].sort()).toEqual([...folded.rows!.keys()].sort());
        expect([...once.pools].sort()).toEqual([...folded.pools].sort());
        expect([...once.rewardBalances!]).toEqual([...folded.rewardBalances!]);
        // the input maps are untouched
        expect(inputs.resolved.size).toBe(2);
        expect(inputs.rewardBalances!.get("c1")).toBe(5n);
        expect(once.resolved.has("a")).toBe(true); // re-created by the second overlay after the first spent it
        expect(once.resolved.has("d")).toBe(false);
    });
});
