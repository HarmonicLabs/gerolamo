import { describe, expect, test } from "bun:test";
import { ratifyRound, type RatifyInput, type RatifyProposal } from "./ratify";

const r = (num: number, den = 100) => ({ num: BigInt(num), den: BigInt(den) });
const C1 = "00" + "c1".repeat(28), C2 = "00" + "c2".repeat(28), C3 = "00" + "c3".repeat(28);
const H1 = "h1".replace("h", "a").repeat(28), H2 = "a2".repeat(28), H3 = "a3".repeat(28);
const D1 = "d1".repeat(28), D2 = "d2".repeat(28), P1 = "e1".repeat(28), P2 = "e2".repeat(28);
const params = { protocolMajor: 10, protocolMinor: 0, committeeMinSize: 2, committeeMaxTermLength: 100, drep: { dvt_p_p_economic_group: r(50), dvt_treasury_withdrawal: r(50), dvt_committee_normal: r(50), dvt_hard_fork_initiation: r(50), dvt_motion_no_confidence: r(50), dvt_update_to_constitution: r(50), dvt_p_p_gov_group: r(50) }, pool: { pvt_p_p_security_group: r(50), pvt_committee_normal: r(50), pvt_hard_fork_initiation: r(50), pvt_motion_no_confidence: r(50) } };
function input(proposals: RatifyProposal[], over: Partial<RatifyInput> = {}): RatifyInput {
    return {
        epoch: 100, params,
        committee: { members: new Map([[C1, 200], [C2, 200], [C3, 200]]), threshold: r(2, 3) },
        committeeCreds: new Map([[C1, { hot: H1, resigned: false }], [C2, { hot: H2, resigned: false }], [C3, { hot: H3, resigned: false }]]),
        proposals,
        drepDistr: new Map([[D1, 60n], [D2, 40n]]), drepExpiry: new Map([[D1, 120], [D2, 120]]),
        poolDistr: new Map([[P1, 60n], [P2, 40n]]), poolDefault: new Map(),
        roots: { pparams: null, hardfork: null, committee: null, constitution: null },
        treasury: 1000n,
        ...over,
    };
}
const yesAll = (): Pick<RatifyProposal, "ccVotes" | "drepVotes" | "spoVotes"> => ({ ccVotes: new Map([[H1, 1], [H2, 1], [H3, 1]]), drepVotes: new Map([[D1, 1], [D2, 1]]), spoVotes: new Map([[P1, 1], [P2, 1]]) });
const P = (id: string, kind: RatifyProposal["kind"], over: Partial<RatifyProposal> = {}): RatifyProposal => ({ id, kind, prev: null, expiresAfter: 110, ...yesAll(), ...over });

describe("RATIFY order and enact state (Rules/Ratify.hs)", () => {
    test("proposals are taken by action priority, not submission order: a committee update submitted later delays an earlier parameter change", () => {
        const out = ratifyRound(input([P("pc", "ParameterChange", { changes: { min_fee_a: 44 } }), P("uc", "UpdateCommittee", { ccAdd: [{ cred: C1, expires: 150 }], ccThreshold: r(2, 3) })]));
        expect(out.ratified).toEqual(["uc"]);
        expect(out.tallies.find((t) => t.id === "pc")!.reason).toBe("delayed");
    });
    test("a parameter change chained on one ratified earlier in the round passes in the same round", () => {
        const out = ratifyRound(input([P("a", "ParameterChange", { changes: { min_fee_a: 44 } }), P("b", "ParameterChange", { prev: "a", changes: { min_fee_a: 45 } })]));
        expect(out.ratified).toEqual(["a", "b"]);
        expect(out.roots.pparams).toBe("b");
    });
    test("a parameter change raising a threshold judges the later proposals of the round with it", () => {
        const pc = P("pc", "ParameterChange", { changes: { dvt_treasury_withdrawal: "0.9" } });
        const tw = P("tw", "TreasuryWithdrawals", { withdrawalTotal: 10n, drepVotes: new Map([[D1, 1]]) }); // 60 %
        expect(ratifyRound(input([tw])).ratified).toEqual(["tw"]);
        expect(ratifyRound(input([pc, tw])).ratified).toEqual(["pc"]);
    });
    test("treasury withdrawals must fit the treasury, which the round's withdrawals reduce", () => {
        const out = ratifyRound(input([P("t1", "TreasuryWithdrawals", { withdrawalTotal: 700n }), P("t2", "TreasuryWithdrawals", { withdrawalTotal: 400n })]));
        expect(out.ratified).toEqual(["t1"]);
        expect(out.tallies[1]!.reason).toBe("treasury insufficient");
    });
    test("new committee terms must end within committeeMaxTermLength", () => {
        expect(ratifyRound(input([P("uc", "UpdateCommittee", { ccAdd: [{ cred: C1, expires: 200 }], ccThreshold: r(2, 3) })])).ratified).toEqual(["uc"]);
        expect(ratifyRound(input([P("uc", "UpdateCommittee", { ccAdd: [{ cred: C1, expires: 201 }], ccThreshold: r(2, 3) })])).tallies[0]!.reason).toBe("term beyond committeeMaxTermLength");
    });
    test("an unratified proposal whose expiresAfter is below the epoch expires; a ratified one does not", () => {
        const out = ratifyRound(input([P("old", "Info", { expiresAfter: 99 }), P("pc", "ParameterChange", { expiresAfter: 99, changes: { min_fee_a: 1 } })]));
        expect(out.expired).toEqual(["old"]);
        expect(out.ratified).toEqual(["pc"]);
    });
    test("the previous action must be the enacted root of the purpose", () => {
        expect(ratifyRound(input([P("pc", "ParameterChange", { prev: "x", changes: { min_fee_a: 1 } })])).ratified).toEqual([]);
        expect(ratifyRound(input([P("pc", "ParameterChange", { prev: "x", changes: { min_fee_a: 1 } })], { roots: { pparams: "x", hardfork: null, committee: null, constitution: null } })).ratified).toEqual(["pc"]);
    });
});

describe("RATIFY committee", () => {
    const pc = (cc: Map<string, number>) => P("pc", "ParameterChange", { changes: { min_fee_a: 1 }, ccVotes: cc });
    test("an active member that did not vote counts as No; Abstain is excluded", () => {
        expect(ratifyRound(input([pc(new Map([[H1, 1], [H2, 1]]))])).ratified).toEqual(["pc"]); // 2/3
        expect(ratifyRound(input([pc(new Map([[H1, 1]]))])).ratified).toEqual([]); // 1/3
        expect(ratifyRound(input([pc(new Map([[H1, 1], [H2, 2]]))])).ratified).toEqual([]); // 1/2 of the non-abstaining
        expect(ratifyRound(input([pc(new Map([[H1, 1], [H2, 2], [H3, 2]]))])).ratified).toEqual(["pc"]); // 1/1
    });
    test("expired, resigned and unauthorised members do not count (and do not make the minimum size)", () => {
        const creds = new Map<string, { hot: string | null; resigned: boolean }>([[C1, { hot: H1, resigned: false }], [C2, { hot: null, resigned: true }]]);
        const members = new Map([[C1, 200], [C2, 200], [C3, 200]]);
        expect(ratifyRound(input([pc(new Map([[H1, 1]]))], { committeeCreds: creds, committee: { members, threshold: r(2, 3) } })).tallies[0]!.cc).toBe("no threshold"); // 1 active < min size 2
        expect(ratifyRound(input([pc(new Map([[H1, 1]]))], { committeeCreds: creds, committee: { members, threshold: r(2, 3) }, params: { ...params, committeeMinSize: 1 } })).ratified).toEqual(["pc"]);
        const expired = new Map([[C1, 200], [C2, 99], [C3, 99]]);
        expect(ratifyRound(input([pc(new Map([[H1, 1]]))], { committee: { members: expired, threshold: r(2, 3) }, params: { ...params, committeeMinSize: 1 } })).ratified).toEqual(["pc"]);
    });
    test("the minimum size does not apply in the bootstrap phase", () => {
        const boot = { ...params, protocolMajor: 9, committeeMinSize: 7 };
        expect(ratifyRound(input([pc(new Map([[H1, 1], [H2, 1]]))], { params: boot })).ratified).toEqual(["pc"]);
        expect(ratifyRound(input([pc(new Map([[H1, 1], [H2, 1]]))], { params: { ...boot, protocolMajor: 10 } })).ratified).toEqual([]);
    });
    test("no committee (no confidence): only NoConfidence / UpdateCommittee can pass", () => {
        const out = ratifyRound(input([pc(new Map([[H1, 1]])), P("uc", "UpdateCommittee", { ccAdd: [{ cred: C1, expires: 150 }], ccThreshold: r(2, 3) })], { committee: null }));
        expect(out.ratified).toEqual(["uc"]);
    });
});

describe("RATIFY SPOs and DReps", () => {
    test("an SPO that did not vote: No on a hard fork even with an AlwaysAbstain reward account, Abstain during the bootstrap phase", () => {
        const hf = P("hf", "InitHardFork", { version: { major: 11, minor: 0 }, spoVotes: new Map([[P2, 1]]) }); // 40 %
        expect(ratifyRound(input([hf], { poolDefault: new Map([[P1, "abstain"]]) })).ratified).toEqual([]);
        const pc = P("pc", "ParameterChange", { changes: { min_fee_a: 1 }, spoVotes: new Map([[P2, 1]]) }); // security group
        expect(ratifyRound(input([pc], { poolDefault: new Map([[P1, "abstain"]]) })).ratified).toEqual(["pc"]); // 40/40
        expect(ratifyRound(input([pc])).ratified).toEqual([]); // 40/100
        expect(ratifyRound(input([pc], { params: { ...params, protocolMajor: 9 } })).ratified).toEqual(["pc"]); // bootstrap: 40/40
        expect(ratifyRound(input([{ ...hf, spoVotes: new Map([[P2, 1]]) }], { params: { ...params, protocolMajor: 9 } })).ratified).toEqual([]); // hard fork: still No
    });
    test("an AlwaysNoConfidence reward account votes Yes on NoConfidence", () => {
        const nc = P("nc", "NoConfidence", { spoVotes: new Map() });
        expect(ratifyRound(input([nc])).ratified).toEqual([]);
        expect(ratifyRound(input([nc], { poolDefault: new Map([[P1, "noconfidence"]]) })).ratified).toEqual(["nc"]);
    });
    test("DReps: unvoted is No, expired DReps and AlwaysAbstain are out, AlwaysNoConfidence is No (Yes on NoConfidence)", () => {
        const tw = (dv: Map<string, number>) => P("tw", "TreasuryWithdrawals", { withdrawalTotal: 1n, drepVotes: dv });
        expect(ratifyRound(input([tw(new Map([[D2, 1]]))])).ratified).toEqual([]); // 40/100
        expect(ratifyRound(input([tw(new Map([[D2, 1]]))], { drepExpiry: new Map([[D1, 99], [D2, 120]]) })).ratified).toEqual(["tw"]); // D1 expired
        expect(ratifyRound(input([tw(new Map([[D2, 1]]))], { drepExpiry: new Map([[D1, 100], [D2, 120]]) })).ratified).toEqual([]); // expiry = epoch: still active
        expect(ratifyRound(input([tw(new Map([[D1, 1]]))], { drepDistr: new Map([[D1, 60n], ["noconfidence", 70n], ["abstain", 500n]]) })).ratified).toEqual([]); // 60/130
        const nc = P("nc", "NoConfidence", { drepVotes: new Map() });
        expect(ratifyRound(input([nc], { drepDistr: new Map([[D1, 60n], ["noconfidence", 70n]]) })).ratified).toEqual(["nc"]); // 70/130
    });
    test("bootstrap phase: DRep thresholds are zero; Info is never ratified", () => {
        const pc = P("pc", "ParameterChange", { changes: { min_fee_a: 1 }, drepVotes: new Map() });
        expect(ratifyRound(input([pc], { params: { ...params, protocolMajor: 9 } })).ratified).toEqual(["pc"]);
        expect(ratifyRound(input([P("i", "Info")])).ratified).toEqual([]);
    });
});
