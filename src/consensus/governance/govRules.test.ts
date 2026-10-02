import { describe, expect, test } from "bun:test";
import { checkGovTx, GovBlockOverlay, ppuWellFormed, pvCanFollow, type GovLedgerView, type GovRuleParams, type ProposalView } from "./govRules";
import { decodeGovTx, type GovActionModel, type GovCertModel, type GovTxModel, type ProposalModel, type VoteModel } from "./govTxDecode";

const H = (c: string) => c.repeat(28), S = (c: string) => "01" + c.repeat(28);
const RET = H("a1"), POOL = H("b1"), DREP = H("c1"), SDREP = S("c2"), COLD = S("d1"), HOT = S("d2"), SCRIPT = H("e1").slice(0, 56);
const ROOT_PP = "11".repeat(32) + ":0";

function view(over: Partial<{ accounts: Record<string, { balance?: bigint; drep?: any }>; pools: Record<string, string>; dreps: Record<string, bigint>; members: Map<string, number> | null; creds: Map<string, any>; proposals: ProposalView[]; roots: any; script: string | null; treasury: bigint | null; exact: boolean }> = {}): GovLedgerView {
    const accounts = over.accounts ?? { [RET]: {} };
    const pools = over.pools ?? { [POOL]: "vrf1" };
    const dreps = over.dreps ?? { [DREP]: 500n, [SDREP]: 500n };
    const members = over.members === undefined ? new Map([[COLD, 500]]) : over.members;
    const creds = over.creds ?? new Map([[COLD, { hot: HOT, resigned: false }]]);
    const props = new Map((over.proposals ?? []).map((p) => [p.id, p]));
    return {
        accountRegistered: (c) => c in accounts,
        accountDeposit: () => null,
        accountBalance: (c) => (c in accounts ? accounts[c]!.balance ?? 0n : null),
        accountDRep: (c) => (c in accounts ? accounts[c]!.drep ?? null : null),
        poolRegistered: (p) => p in pools,
        poolVrf: (p) => pools[p] ?? null,
        registeredVrfs: () => new Set(Object.values(pools)),
        drepRegistered: (c) => c in dreps,
        drepDeposit: (c) => dreps[c] ?? null,
        committeeMembers: () => members,
        committeeCreds: () => creds,
        proposals: () => props,
        roots: () => over.roots ?? { pparams: ROOT_PP, hardfork: null, committee: null, constitution: null },
        constitutionScript: () => (over.script === undefined ? SCRIPT : over.script),
        treasury: () => (over.treasury === undefined ? 1_000_000n : over.treasury),
        balancesExact: () => (over.exact ? { exact: true, why: "" } : { exact: false, why: "ledger store mode sqlite" }),
    };
}
const pp = (major = 10, extra: Partial<GovRuleParams> = {}): GovRuleParams => ({ protocolMajor: major, protocolMinor: 0, keyDeposit: 2_000_000n, minPoolCost: 170_000_000n, eMax: 18, networkId: 0, epoch: 100, govActionDeposit: 1_000n, drepDeposit: 500n, govActionLifetime: 6, ...extra });
const tx = (m: Partial<GovTxModel>): GovTxModel => ({ txId: "ab".repeat(32), certs: [], proposals: [], votes: [], withdrawals: [], treasuryValue: null, ...m });
const prop = (action: GovActionModel, over: Partial<ProposalModel> = {}): ProposalModel => ({ index: 0, deposit: 1_000n, returnAccount: { network: 0, cred: RET }, action, ...over });
const pc = (prev: string | null = ROOT_PP, keys: Array<[number, bigint]> = [[0, 44n]], policy: string | null = SCRIPT): GovActionModel => ({ type: 0, prev, update: new Map(keys.map(([k, v]) => [k, { t: "u", v }])), policy });
const vote = (voterKind: number, voterHash: string, actionId: string, v = 1): VoteModel => ({ voterKind, voterHash, actionId, vote: v });
const run = (t: GovTxModel, p = pp(), v = view()) => checkGovTx(t, p, new GovBlockOverlay(v)).failures;
const rules = (fs: string[]) => fs.map((f) => f.split(" ").slice(0, 2).join(" "));

describe("GOV proposals (cardano-ledger-conway 1.22.1 Rules/Gov.hs)", () => {
    test("a well-formed ParameterChange on the enacted root passes", () => { expect(run(tx({ proposals: [prop(pc())] }))).toEqual([]); });
    test("deposit, return account, network ids and guardrail script", () => {
        expect(rules(run(tx({ proposals: [prop(pc(), { deposit: 999n })] })))).toEqual(["GOV ProposalDepositIncorrect"]);
        expect(rules(run(tx({ proposals: [prop(pc(), { returnAccount: { network: 0, cred: H("99") } })] })))).toEqual(["GOV ProposalReturnAccountDoesNotExist"]);
        expect(run(tx({ proposals: [prop(pc(), { returnAccount: { network: 0, cred: H("99") } })] }), pp(9))).toEqual([]); // not checked in the bootstrap phase
        expect(rules(run(tx({ proposals: [prop(pc(), { returnAccount: { network: 1, cred: RET } })] })))).toEqual(["GOV ProposalProcedureNetworkIdMismatch"]);
        expect(rules(run(tx({ proposals: [prop(pc(ROOT_PP, [[0, 44n]], null))] })))).toEqual(["GOV InvalidGuardrailsScriptHash"]);
    });
    test("treasury withdrawals: registered, same network, non-zero (outside the bootstrap phase), guardrail", () => {
        const tw = (amount: bigint, cred = RET, network = 0, policy: string | null = SCRIPT): GovActionModel => ({ type: 2, withdrawals: [{ account: { network, cred }, amount }], policy });
        expect(run(tx({ proposals: [prop(tw(5n))] }))).toEqual([]);
        expect(rules(run(tx({ proposals: [prop(tw(0n))] })))).toEqual(["GOV ZeroTreasuryWithdrawals"]);
        expect(rules(run(tx({ proposals: [prop(tw(5n, H("98")))] })))).toEqual(["GOV TreasuryWithdrawalReturnAccountsDoNotExist"]);
        expect(rules(run(tx({ proposals: [prop(tw(5n, RET, 1))] })))).toEqual(["GOV TreasuryWithdrawalsNetworkIdMismatch"]);
        expect(rules(run(tx({ proposals: [prop(tw(5n, RET, 0, null))] })))).toEqual(["GOV InvalidGuardrailsScriptHash"]);
    });
    test("previous action: the enacted root or a live proposal of the same purpose", () => {
        const live: ProposalView = { id: "22".repeat(32) + ":0", type: 0, prev: ROOT_PP, expiresAfter: 110 };
        const info: ProposalView = { id: "33".repeat(32) + ":0", type: 6, prev: null, expiresAfter: 110 };
        const v = view({ proposals: [live, info] });
        expect(run(tx({ proposals: [prop(pc(live.id))] }), pp(), v)).toEqual([]);
        expect(rules(run(tx({ proposals: [prop(pc(null))] }), pp(), v))).toEqual(["GOV InvalidPrevGovActionId"]);
        expect(rules(run(tx({ proposals: [prop(pc(info.id))] }), pp(), v))).toEqual(["GOV InvalidPrevGovActionId"]); // another purpose
        // a second proposal of the same transaction may build on the first
        const first = prop(pc(ROOT_PP)), second = prop(pc(`${"ab".repeat(32)}:0`), { index: 1 });
        expect(run(tx({ proposals: [first, second] }))).toEqual([]);
    });
    test("committee updates: no member both added and removed, terms after the current epoch", () => {
        const uc = (add: Array<[string, number]>, remove: string[] = []): GovActionModel => ({ type: 4, prev: null, remove, add: add.map(([cred, epoch]) => ({ cred, epoch })), thrNum: 2n, thrDen: 3n });
        expect(run(tx({ proposals: [prop(uc([[S("f1"), 200]]))] }))).toEqual([]);
        expect(rules(run(tx({ proposals: [prop(uc([[S("f1"), 200]], [S("f1")]))] })))).toEqual(["GOV ConflictingCommitteeUpdate"]);
        expect(rules(run(tx({ proposals: [prop(uc([[S("f1"), 100]]))] })))).toEqual(["GOV ExpirationEpochTooSmall"]);
    });
    test("hard forks: the successor of the current version or of the parent hard fork", () => {
        const hf = (prev: string | null, major: number, minor: number): GovActionModel => ({ type: 1, prev, major, minor });
        expect(pvCanFollow({ major: 10, minor: 0 }, { major: 11, minor: 0 })).toBe(true);
        expect(pvCanFollow({ major: 10, minor: 0 }, { major: 10, minor: 1 })).toBe(true);
        expect(pvCanFollow({ major: 10, minor: 0 }, { major: 12, minor: 0 })).toBe(false);
        expect(pvCanFollow({ major: 10, minor: 2 }, { major: 11, minor: 1 })).toBe(false);
        expect(run(tx({ proposals: [prop(hf(null, 11, 0))] }))).toEqual([]);
        expect(rules(run(tx({ proposals: [prop(hf(null, 12, 0))] })))).toEqual(["GOV ProposalCantFollow"]);
        const parent: ProposalView = { id: "44".repeat(32) + ":0", type: 1, prev: null, expiresAfter: 110, major: 11, minor: 0 };
        expect(run(tx({ proposals: [prop(hf(parent.id, 11, 1))] }), pp(), view({ proposals: [parent] }))).toEqual([]);
        // a major above the current one's successor is judged against the current version, parent or not
        expect(rules(run(tx({ proposals: [prop(hf(parent.id, 12, 0))] }), pp(), view({ proposals: [parent] })))).toEqual(["GOV ProposalCantFollow"]);
        expect(rules(run(tx({ proposals: [prop(hf(parent.id, 11, 0))] }), pp(), view({ proposals: [parent] })))).toEqual(["GOV ProposalCantFollow"]);
    });
    test("bootstrap phase: only parameter changes, hard forks and info actions", () => {
        expect(rules(run(tx({ proposals: [prop({ type: 3, prev: null })] }), pp(9)))).toEqual(["GOV DisallowedProposalDuringBootstrap"]);
        expect(run(tx({ proposals: [prop({ type: 6 })] }), pp(9))).toEqual([]);
    });
    test("malformed parameter updates (ppuWellFormed)", () => {
        expect(ppuWellFormed({ major: 10 }, new Map())).toBe(false);
        expect(ppuWellFormed({ major: 10 }, new Map([[3, { t: "u", v: 0n }]]))).toBe(false); // max tx size 0
        expect(ppuWellFormed({ major: 9 }, new Map([[17, { t: "u", v: 0n }]]))).toBe(true); // coins per byte 0 allowed in bootstrap
        expect(ppuWellFormed({ major: 10 }, new Map([[17, { t: "u", v: 0n }]]))).toBe(false);
        expect(ppuWellFormed({ major: 10 }, new Map([[8, { t: "u", v: 0n }]]))).toBe(true); // nOpt 0 before protocol 11
        expect(ppuWellFormed({ major: 11 }, new Map([[8, { t: "u", v: 0n }]]))).toBe(false);
        expect(rules(run(tx({ proposals: [prop(pc(ROOT_PP, [[29, 0n]]))] })))).toEqual(["GOV MalformedProposal"]);
    });
});

describe("GOV votes", () => {
    const TW: ProposalView = { id: "55".repeat(32) + ":0", type: 2, prev: null, expiresAfter: 110 };
    const NC: ProposalView = { id: "66".repeat(32) + ":0", type: 3, prev: null, expiresAfter: 110 };
    const PC: ProposalView = { id: "77".repeat(32) + ":0", type: 0, prev: ROOT_PP, expiresAfter: 110, security: false };
    const OLD: ProposalView = { id: "88".repeat(32) + ":0", type: 6, prev: null, expiresAfter: 90 };
    const v = () => view({ proposals: [TW, NC, PC, OLD] });
    test("voters that exist, on live actions they may vote on", () => {
        expect(run(tx({ votes: [vote(1, HOT.slice(2), TW.id), vote(2, DREP, TW.id), vote(3, SDREP.slice(2), NC.id), vote(4, POOL, NC.id)] }), pp(), v())).toEqual([]);
        expect(rules(run(tx({ votes: [vote(2, H("97"), TW.id)] }), pp(), v()))).toEqual(["GOV VotersDoNotExist"]);
        expect(rules(run(tx({ votes: [vote(0, HOT.slice(2), TW.id)] }), pp(), v()))).toEqual(["GOV VotersDoNotExist"]); // the hot key is a script
        expect(rules(run(tx({ votes: [vote(2, DREP, "99".repeat(32) + ":0")] }), pp(), v()))).toEqual(["GOV GovActionsDoNotExist"]);
        expect(rules(run(tx({ votes: [vote(2, DREP, OLD.id)] }), pp(), v()))).toEqual(["GOV VotingOnExpiredGovAction"]);
        expect(rules(run(tx({ votes: [vote(1, HOT.slice(2), NC.id)] }), pp(), v()))).toEqual(["GOV DisallowedVoters"]); // CC on no-confidence
        expect(rules(run(tx({ votes: [vote(4, POOL, TW.id)] }), pp(), v()))).toEqual(["GOV DisallowedVoters"]);
        expect(rules(run(tx({ votes: [vote(4, POOL, PC.id)] }), pp(), v()))).toEqual(["GOV DisallowedVoters"]); // no security-group parameter
        expect(run(tx({ votes: [vote(4, POOL, PC.id)] }), pp(), view({ proposals: [{ ...PC, security: true }] }))).toEqual([]);
    });
    test("bootstrap phase: DReps vote on info actions only", () => {
        expect(rules(run(tx({ votes: [vote(2, DREP, PC.id)] }), pp(9), v()))).toEqual(["GOV DisallowedVotesDuringBootstrap"]);
        expect(rules(run(tx({ votes: [vote(1, HOT.slice(2), TW.id)] }), pp(9), v()))).toEqual(["GOV DisallowedVotesDuringBootstrap"]);
    });
    test("protocol 11: hot keys of cold keys outside the enacted committee may not vote", () => {
        const creds = new Map<string, any>([[COLD, { hot: HOT, resigned: false }], [S("d3"), { hot: S("d4"), resigned: false }]]);
        const vv = view({ proposals: [TW], creds });
        expect(run(tx({ votes: [vote(1, H("d4"), TW.id)] }), pp(10), vv)).toEqual([]);
        expect(rules(run(tx({ votes: [vote(1, H("d4"), TW.id)] }), pp(11), vv))).toEqual(["GOV UnelectedCommitteeVoters"]);
    });
    test("certificates of the same transaction come first: a new DRep may vote, an unregistered one may not", () => {
        const NEW = H("c3");
        expect(run(tx({ certs: [{ index: 0, type: 16, cred: NEW, coin: 500n }], votes: [vote(2, NEW, TW.id)] }), pp(), v())).toEqual([]);
        expect(rules(run(tx({ certs: [{ index: 0, type: 17, cred: DREP, coin: 500n }], votes: [vote(2, DREP, TW.id)] }), pp(), v()))).toEqual(["GOV VotersDoNotExist"]);
    });
});

describe("GOVCERT (Rules/GovCert.hs)", () => {
    const c = (m: Partial<GovCertModel>): GovCertModel => ({ index: 0, type: 16, ...m });
    test("DRep registration, unregistration and update", () => {
        expect(run(tx({ certs: [c({ type: 16, cred: H("c4"), coin: 500n })] }))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 16, cred: DREP, coin: 500n })] })))).toEqual(["GOVCERT ConwayDRepAlreadyRegistered"]);
        expect(rules(run(tx({ certs: [c({ type: 16, cred: H("c4"), coin: 400n })] })))).toEqual(["GOVCERT ConwayDRepIncorrectDeposit"]);
        expect(rules(run(tx({ certs: [c({ type: 17, cred: H("c4"), coin: 500n })] })))).toEqual(["GOVCERT ConwayDRepNotRegistered"]);
        expect(rules(run(tx({ certs: [c({ type: 17, cred: DREP, coin: 400n })] })))).toEqual(["GOVCERT ConwayDRepIncorrectRefund"]);
        expect(rules(run(tx({ certs: [c({ type: 18, cred: H("c4") })] })))).toEqual(["GOVCERT ConwayDRepNotRegistered"]);
        // a script DRep and a key DRep with the same hash are two DReps (bug 153)
        expect(rules(run(tx({ certs: [c({ type: 17, cred: "01" + DREP, coin: 500n })] })))).toEqual(["GOVCERT ConwayDRepNotRegistered"]);
    });
    test("committee keys: members or potential members, never after a resignation", () => {
        expect(run(tx({ certs: [c({ type: 14, cold: COLD, hot: S("d9") })] }))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 14, cold: S("d5"), hot: S("d9") })] })))).toEqual(["GOVCERT ConwayCommitteeIsUnknown"]);
        const future: ProposalView = { id: "99".repeat(32) + ":0", type: 4, prev: null, expiresAfter: 110, ccAdd: [S("d5")] };
        expect(run(tx({ certs: [c({ type: 14, cold: S("d5"), hot: S("d9") })] }), pp(), view({ proposals: [future] }))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 15, cold: COLD }), c({ index: 1, type: 14, cold: COLD, hot: S("d9") })] })))).toEqual(["GOVCERT ConwayCommitteeHasPreviouslyResigned"]);
    });
});

describe("DELEG / POOL (certificateRules.ts)", () => {
    const c = (m: Partial<GovCertModel>): GovCertModel => ({ index: 0, type: 7, ...m });
    const NEW = H("a2");
    test("registration deposits, refunds and balances", () => {
        expect(run(tx({ certs: [c({ type: 7, cred: NEW, coin: 2_000_000n })] }))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 7, cred: NEW, coin: 1n })] }), pp(10)))).toEqual(["DELEG IncorrectDepositDELEG"]);
        expect(rules(run(tx({ certs: [c({ type: 7, cred: NEW, coin: 1n })] }), pp(11)))).toEqual(["DELEG DepositIncorrectDELEG"]);
        expect(rules(run(tx({ certs: [c({ type: 0, cred: RET })] })))).toEqual(["DELEG StakeKeyRegisteredDELEG"]);
        expect(rules(run(tx({ certs: [c({ type: 8, cred: NEW, coin: 2_000_000n })] })))).toEqual(["DELEG StakeKeyNotRegisteredDELEG"]);
        // a non-zero balance: reported when the balances are not exact (sqlite / dual, a SQLite-seeded store), failed when they are (bug 274)
        expect(run(tx({ certs: [c({ type: 1, cred: RET })] }), pp(), view({ accounts: { [RET]: { balance: 5n } } }))).toEqual([]);
        const rep = checkGovTx(tx({ certs: [c({ type: 1, cred: RET })] }), pp(), new GovBlockOverlay(view({ accounts: { [RET]: { balance: 5n } } }))).reports[0];
        expect(rep).toContain("StakeKeyHasNonZeroAccountBalanceDELEG");
        expect(rep).toContain("report-only: ledger store mode sqlite");
        expect(rules(run(tx({ certs: [c({ type: 1, cred: RET })] }), pp(), view({ accounts: { [RET]: { balance: 5n } }, exact: true })))).toEqual(["DELEG StakeKeyHasNonZeroAccountBalanceDELEG"]);
        // exact balances: a full withdrawal before the deregistration passes, a partial one leaves a balance
        expect(run(tx({ withdrawals: [{ account: { network: 0, cred: RET }, amount: 5n }], certs: [c({ type: 1, cred: RET })] }), pp(), view({ accounts: { [RET]: { balance: 5n, drep: { kind: "abstain" } } }, exact: true }))).toEqual([]);
        expect(rules(run(tx({ withdrawals: [{ account: { network: 0, cred: RET }, amount: 4n }], certs: [c({ type: 1, cred: RET })] }), pp(), view({ accounts: { [RET]: { balance: 5n, drep: { kind: "abstain" } } }, exact: true })))).toEqual(["DELEG StakeKeyHasNonZeroAccountBalanceDELEG"]);
        // withdrawals drain the account before the certificates (CERTS)
        expect(run(tx({ withdrawals: [{ account: { network: 0, cred: RET }, amount: 5n }], certs: [c({ type: 1, cred: RET })] }), pp(), view({ accounts: { [RET]: { balance: 5n, drep: { kind: "abstain" } } } }))).toEqual([]);
    });
    test("delegatees must be registered (DReps from protocol 10 on)", () => {
        expect(rules(run(tx({ certs: [c({ type: 2, cred: RET, pool: H("b9") })] })))).toEqual(["DELEG DelegateeStakePoolNotRegisteredDELEG"]);
        expect(rules(run(tx({ certs: [c({ type: 9, cred: RET, drep: { kind: "cred", cred: H("c9") } })] })))).toEqual(["DELEG DelegateeDRepNotRegisteredDELEG"]);
        expect(run(tx({ certs: [c({ type: 9, cred: RET, drep: { kind: "cred", cred: H("c9") } })] }), pp(9))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 9, cred: NEW, drep: { kind: "abstain" } })] })))).toEqual(["DELEG StakeKeyNotRegisteredDELEG"]);
    });
    test("pool registration and retirement", () => {
        const reg = (cost: bigint, network = 0, vrf = "vrf9", mdLen: number | null = 32) => c({ type: 3, pool: H("b2"), poolReg: { vrf, cost, rewardAccount: { network, cred: RET }, metadataHashLen: mdLen } });
        expect(run(tx({ certs: [reg(170_000_000n)] }))).toEqual([]);
        expect(rules(run(tx({ certs: [reg(1n)] })))).toEqual(["POOL StakePoolCostTooLowPOOL"]);
        expect(rules(run(tx({ certs: [reg(170_000_000n, 1)] })))).toEqual(["POOL WrongNetworkPOOL"]);
        expect(rules(run(tx({ certs: [reg(170_000_000n, 0, "vrf9", 33)] })))).toEqual(["POOL PoolMedataHashTooBig"]);
        expect(run(tx({ certs: [reg(170_000_000n, 0, "vrf1")] }), pp(10))).toEqual([]);
        expect(rules(run(tx({ certs: [reg(170_000_000n, 0, "vrf1")] }), pp(11)))).toEqual(["POOL VRFKeyHashAlreadyRegistered"]);
        expect(run(tx({ certs: [c({ type: 4, pool: POOL, epoch: 101 })] }))).toEqual([]);
        expect(rules(run(tx({ certs: [c({ type: 4, pool: POOL, epoch: 100 })] })))).toEqual(["POOL StakePoolRetirementWrongEpochPOOL"]);
        expect(rules(run(tx({ certs: [c({ type: 4, pool: POOL, epoch: 119 })] })))).toEqual(["POOL StakePoolRetirementWrongEpochPOOL"]);
        expect(rules(run(tx({ certs: [c({ type: 4, pool: H("b3"), epoch: 101 })] })))).toEqual(["POOL StakePoolNotRegisteredOnKeyPOOL"]);
    });
});

describe("LEDGER governance checks", () => {
    test("the declared treasury must be the treasury (strict when the pots are exact, bug 273)", () => {
        expect(run(tx({ treasuryValue: 1_000_000n }), pp(), view({ exact: true }))).toEqual([]);
        expect(rules(run(tx({ treasuryValue: 5n }), pp(), view({ exact: true })))).toEqual(["LEDGER ConwayTreasuryValueMismatch"]);
        expect(run(tx({ treasuryValue: 5n }))).toEqual([]);
        expect(checkGovTx(tx({ treasuryValue: 5n }), pp(), new GovBlockOverlay(view())).reports[0]).toContain("ConwayTreasuryValueMismatch supplied 5 expected 1000000 (report-only: ledger store mode sqlite)");
    });
    test("key-hash reward accounts that withdraw must delegate to a DRep (from protocol 10)", () => {
        const w = { withdrawals: [{ account: { network: 0, cred: RET }, amount: 0n }] };
        expect(rules(run(tx(w)))).toEqual(["LEDGER ConwayWdrlNotDelegatedToDRep"]);
        expect(run(tx(w), pp(9))).toEqual([]);
        expect(run(tx(w), pp(), view({ accounts: { [RET]: { drep: { kind: "noConfidence" } } } }))).toEqual([]);
        expect(run(tx({ withdrawals: [{ account: { network: 0, cred: "01" + RET }, amount: 0n }] }))).toEqual([]); // script accounts exempt
    });
});

describe("decodeGovTx on a real Conway body", () => {
    test("preview slot 55835715: the first governance action (100 000 ADA deposit, testnet return account)", async () => {
        const { MultiEraBlock } = await import("@harmoniclabs/cardano-ledger-ts");
        const hex = (await Bun.file(new URL("../__fixtures__/preview-block-55835715.hex", import.meta.url)).text()).trim();
        const m: any = MultiEraBlock.fromCbor(Uint8Array.from(Buffer.from(hex, "hex")));
        const body = m.block.transactionBodies[0];
        const g = decodeGovTx(body.cborRef.toBuffer(), body.hash.toString());
        expect(g.proposals.length).toBe(1);
        expect(g.proposals[0]!.deposit).toBe(100_000_000_000n);
        expect(g.proposals[0]!.returnAccount.network).toBe(0);
        expect(g.txId).toBe(String(body.hash.toString()));
    });
});
