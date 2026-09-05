import { describe, expect, test } from "bun:test";
import { committeeAccepts, drepAccepts, poolAccepts, thresholdsFor, paramGroups } from "./tally";

const r = (n: number, d: number) => ({ num: BigInt(n), den: BigInt(d) });

describe("Conway tally", () => {
    test("DReps: abstain excluded, unvoted counts as No, AlwaysNoConfidence is Yes only for NoConfidence", () => {
        const t = { yes: 67n, no: 20n, abstain: 50n, unvoted: 13n, alwaysNoConfidence: 0n, alwaysAbstain: 100n };
        expect(drepAccepts(t, r(67, 100), "Info")).toBe(true);   // 67/100
        expect(drepAccepts({ ...t, unvoted: 14n }, r(67, 100), "Info")).toBe(false); // 67/101
        const nc = { yes: 0n, no: 0n, abstain: 0n, unvoted: 0n, alwaysNoConfidence: 70n, alwaysAbstain: 0n };
        expect(drepAccepts(nc, r(67, 100), "NoConfidence")).toBe(true);
        expect(drepAccepts(nc, r(67, 100), "InitHardFork")).toBe(false);
    });
    test("pools: 51% of non-abstaining stake", () => {
        expect(poolAccepts({ yes: 51n, no: 49n, abstain: 10n, unvoted: 0n, unvotedAbstain: 0n, unvotedNoConfidence: 0n }, r(51, 100), "InitHardFork")).toBe(true);
        expect(poolAccepts({ yes: 40n, no: 0n, abstain: 0n, unvoted: 60n, unvotedAbstain: 20n, unvotedNoConfidence: 0n }, r(51, 100), "InitHardFork")).toBe(false); // 40/80
    });
    test("committee: threshold over yes+no, needs min size", () => {
        expect(committeeAccepts({ yes: 5, no: 2, abstain: 0, active: 7 }, r(2, 3), 7)).toBe(true);
        expect(committeeAccepts({ yes: 5, no: 2, abstain: 0, active: 6 }, r(2, 3), 7)).toBe(false);
        expect(committeeAccepts({ yes: 4, no: 3, abstain: 0, active: 7 }, r(2, 3), 7)).toBe(false);
    });
    test("thresholds by action kind, bootstrap phase skips DReps", () => {
        const p = { committeeThreshold: r(2, 3), committeeMinSize: 7, drep: { dvt_hard_fork_initiation: r(6, 10), dvt_p_p_economic_group: r(67, 100), dvt_p_p_gov_group: r(75, 100) }, pool: { pvt_hard_fork_initiation: r(51, 100), pvt_p_p_security_group: r(51, 100) }, protocolMajor: 9 };
        expect(thresholdsFor("InitHardFork", p).drep).toBeNull();
        expect(thresholdsFor("InitHardFork", { ...p, protocolMajor: 10 }).drep).toEqual(r(6, 10));
        const pc = thresholdsFor("ParameterChange", { ...p, protocolMajor: 10 }, ["min_fee_a", "drep_deposit"]);
        expect(pc.drep).toEqual(r(75, 100)); // max of economic (0.67) and gov (0.75)
        expect(pc.pool).toEqual(r(51, 100)); // min_fee_a is a security parameter
        expect([...paramGroups(["a0"])]).toEqual(["technical"]);
    });
});
