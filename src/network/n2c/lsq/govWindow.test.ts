import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbor, CborArray, CborBytes, CborSimple, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { LedgerStore } from "../../../ledger/LedgerStore";
import { GovReads, GovWrites, type ProposalRow } from "../../../ledger/govStore";
import { StakeReads } from "../../../ledger/stakeStore";
import { UtxoReads } from "../../../ledger/utxoStore";
import { conwayPParamsCbor } from "../pparamsCbor";
import { CborWriter } from "./cborWriter";
import type { GovFacts } from "./govIndex";
import { answerConwayQuery, setGovFactsSource } from "./queries";
import type { LsqView } from "./view";

// The window between the boundary that ratifies actions and the one that enacts them (bug 266):
// GetRatifyState / GetGovState / GetFuturePParams / GetProposals / GetCommitteeMembersState while
// the store's pending decision holds ratified actions. Scenario 1 is preview's last ParameterChange
// (dd4fbc61…:0, ratified at 1366, enacted at 1367 — Koios agrees): its future parameters must be
// the parameters preview adopted at 1367.
const fx = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "ratified-pc-preview-1366.json"), "utf8")) as {
    proposal: ProposalRow & { payload: string }; votes: Array<{ voterKind: number; voterHash: string; vote: number; slot: number }>; params: Record<string, Record<string, unknown>>;
};
const E = 1366, START = E * 86_400, NO_RETURN = START + 86_400 - 2 * 25_920;
const PC = fx.proposal.actionId, PREV_PP = fx.proposal.prevActionId!;
const COLD = "00" + "c1".repeat(28), HOT = "00" + "a1".repeat(28), COLD2 = "01" + "c2".repeat(28);
const UC = "11".repeat(32) + ":0", TW = "22".repeat(32) + ":1";
const CONSTITUTION = { url: "ipfs://constitution", hash: "ca".repeat(32) };
const tmp: string[] = [];
afterAll(async () => { setGovFactsSource(null); for (const d of tmp) await rm(d, { recursive: true, force: true }); });

/** A recognisable procedure per action (the answers embed it verbatim). */
const procedure = (id: string) => new CborWriter().array(4).uint(1_000_000_000).hex("e0" + "10".repeat(28)).array(1).uint(6).array(2).text(`ipfs://${id.slice(0, 8)}`).hex("ab".repeat(32)).finish();
const facts: GovFacts = { drepAnchor: new Map(), proposal: new Map([PC, UC, TW].map((id) => [id, procedure(id)])), credType: new Map(), ccResign: new Map(), stakeDeposit: new Map() };
const pp = (raw: Record<string, unknown>) => Cbor.encode(conwayPParamsCbor(raw)).toBuffer();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const arr = (o: CborObj | undefined): CborObj[] => (o instanceof CborTag ? arr(o.data) : (o as CborArray).array);
const enc = (o: CborObj | undefined) => hex(Cbor.encode(o!).toBuffer());
const uint = (o: CborObj | undefined) => Number((o as CborUInt).num);
const actionId = (o: CborObj | undefined) => { const a = arr(o); return `${hex((a[0] as CborBytes).bytes)}:${uint(a[1])}`; };

async function storeWith(pending: { ratified: string[]; expired: string[] }, extra: (g: GovWrites) => void = () => {}): Promise<LedgerStore> {
    const dir = await mkdtemp(join(tmpdir(), "lsq-gov-")); tmp.push(dir);
    const st = LedgerStore.open(dir, { mapSize: 64 * 1024 * 1024, persistDiffs: false });
    const g = new GovWrites(st);
    await st.applyDirect(() => {
        // the ratifying boundary advanced the roots past the ratified actions (ratifyForNext)
        g.putState({ thrNum: 2, thrDen: 3, constitutionHash: CONSTITUTION.hash, constitutionScript: "fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64", noConfidence: 0, prevPP: pending.ratified.includes(PC) ? PC : PREV_PP, prevHF: null, prevCC: pending.ratified.includes(UC) ? UC : null, prevCons: null, seededEpoch: 646, dormantEpochs: 0, pending: JSON.stringify({ epoch: E, ...pending }), credSchema: 1 });
        g.putConstitutionAnchor(CONSTITUTION);
        g.putCommittee(COLD, { expiresEpoch: 1400, hot: null, resigned: 0 });
        g.putCommitteeAuth(COLD, { hot: HOT, resigned: 0 });
        g.putEpochParams(E - 1, fx.params["1365"]!, "local");
        g.putEpochParams(E, fx.params["1366"]!, "local");
        g.putProposal({ ...fx.proposal, status: pending.ratified.includes(PC) ? "ratified" : "active", decidedEpoch: pending.ratified.includes(PC) ? E : null });
        for (const v of fx.votes) g.putVote({ actionId: PC, ...v });
        extra(g);
        const live = g.reads.proposals(["active", "ratified"]);
        g.putPulserSnapshot({ epoch: E, boundary: null, source: "boundary", version: 2, drepDistr: [], drepStates: [], poolDistr: [], proposals: live.map((p) => ({ actionId: p.actionId, cc: [], drep: [], spo: p.actionId === PC ? [["aa".repeat(28), 1]] : [] })) });
    });
    await st.setAnchor({ slot: START + 100, hash: new Uint8Array(32) });
    return st;
}
const viewOf = (st: LedgerStore, slot: number): LsqView => ({ point: { slot: BigInt(slot), hash: "00".repeat(32), blockNo: 1n, era: 6 }, stake: new StakeReads(st), gov: new GovReads(st), utxo: new UtxoReads(st), atTip: true, volatileHashes: [], anchorKey: `test:${slot}` });
const ask = async (v: LsqView, q: CborObj[]) => answerConwayQuery(v, { network: "preview", magic: 2 }, q);
const Q = (...xs: Array<number | CborObj>) => xs.map((x) => (typeof x === "number" ? new CborUInt(x) : x));
const emptySet = () => new CborTag(258, new CborArray([]));

describe("ratified ParameterChange, queried between the ratifying and the enacting boundary", () => {
    let st: LedgerStore;
    const next = pp(fx.params["1367"]!);
    beforeAll(async () => { setGovFactsSource(() => facts); st = await storeWith({ ratified: [PC], expired: [] }); });

    test("GetFuturePParams = Just the parameters preview adopted at 1367, before and after the slot of no return", async () => {
        for (const slot of [START + 1_000, NO_RETURN + 10]) expect(hex(await ask(viewOf(st, slot), Q(33)))).toBe("81" + hex(next));
        expect(hex(next)).not.toBe(hex(pp(fx.params["1366"]!)));
    });
    test("GetRatifyState: the next enact state, the action as the pulser holds it, not delayed", async () => {
        const r = arr(Cbor.parse(await ask(viewOf(st, START + 1_000), Q(32))));
        const es = arr(r[0]);
        expect(es.length).toBe(7);
        expect(enc(es[2])).toBe(hex(next));                              // curPParams after ENACT
        expect(enc(es[3])).toBe(hex(pp(fx.params["1365"]!)));            // the epoch's prevPParams
        expect(uint(es[4])).toBe(0);                                      // treasury reset at the end of RATIFY
        expect(enc(es[5])).toBe("a0");                                    // no withdrawals
        const roots = arr(es[6]);
        expect(actionId(arr(roots[0])[0])).toBe(PC);                      // the ratified action is the new root
        expect(arr(roots[1]).length).toBe(0);
        const enacted = arr(r[1]);
        expect(enacted.length).toBe(1);
        const gas = arr(enacted[0]);
        expect(actionId(gas[0])).toBe(PC);
        expect(enc(gas[3])).toBe("a1581c" + "aa".repeat(28) + "01");     // the pulser snapshot's SPO vote
        expect(enc(gas[4])).toBe(hex(procedure(PC)));
        expect(uint(gas[5])).toBe(1358); expect(uint(gas[6])).toBe(1388);
        expect(arr(r[2]).length).toBe(0);
        expect((r[3] as CborSimple).simple).toBe(false);
    });
    test("GetGovState: proposal roots still the last enacted, the future parameters potential then definite, the ratify state inside", async () => {
        for (const [slot, tag] of [[START + 1_000, 2], [NO_RETURN + 10, 1]] as const) {
            const g = arr(Cbor.parse(await ask(viewOf(st, slot), Q(24))));
            const roots = arr(arr(g[0])[0]);
            expect(actionId(arr(roots[0])[0])).toBe(PREV_PP);             // cgsProposals roots: enactment happens at the next boundary
            expect(arr(arr(g[0])[1]).map((x) => actionId(arr(x)[0]))).toEqual([PC]); // still among the proposals
            const fut = arr(g[5]);
            expect(uint(fut[0])).toBe(tag);
            expect(enc(tag === 2 ? arr(fut[1])[0] : fut[1])).toBe(hex(next));
            expect(enc(arr(g[6])[1])).toBe(hex(await ask(viewOf(st, slot), Q(32))));
        }
    });
    test("GetProposals lists the ratified action (the pulser's snapshot); the committee is unaffected", async () => {
        const ps = arr(Cbor.parse(await ask(viewOf(st, START + 1_000), Q(31, emptySet()))));
        expect(ps.map((x) => actionId(arr(x)[0]))).toEqual([PC]);
        const cms = arr(Cbor.parse(await ask(viewOf(st, START + 1_000), Q(27, emptySet(), emptySet(), emptySet()))));
        const m = (cms[0] as unknown as { map: Array<{ k: CborObj; v: CborObj }> }).map;
        expect(m.length).toBe(1);
        expect(enc(arr(m[0]!.v)[3])).toBe("8102");                        // NoChangeExpected
    });
});

describe("ratified UpdateCommittee and TreasuryWithdrawals", () => {
    let st: LedgerStore;
    const add = (g: GovWrites) => {
        g.putProposal({ actionId: UC, seq: 2000, kind: "UpdateCommittee", prevActionId: null, deposit: "1000000000", returnAccount: "10".repeat(28), payload: JSON.stringify({ typed: true, remove: [COLD.slice(2)], add: [{ cred: COLD2, expires: 1450 }], thresholdNum: "3", thresholdDen: "5" }), proposedEpoch: 1360, expiresEpoch: 1390, status: "ratified", decidedEpoch: E });
        g.putProposal({ actionId: TW, seq: 2001, kind: "TreasuryWithdrawals", prevActionId: null, deposit: "1000000000", returnAccount: "10".repeat(28), payload: JSON.stringify({ withdrawals: [{ account: "01" + "77".repeat(28), amount: "5" }, { account: "66".repeat(28), amount: "7" }], policy: null }), proposedEpoch: 1361, expiresEpoch: 1391, status: "active", decidedEpoch: null });
    };
    beforeAll(async () => { setGovFactsSource(() => facts); st = await storeWith({ ratified: [UC], expired: [TW] }, add); });

    test("the committee changes, the action delays, the withdrawal expires; no future parameters", async () => {
        const r = arr(Cbor.parse(await ask(viewOf(st, START + 1_000), Q(32))));
        const es = arr(r[0]);
        const committee = arr(arr(es[0])[0]);
        const members = (committee[0] as unknown as { map: Array<{ k: CborObj; v: CborObj }> }).map;
        expect(members.map((e) => enc(e.k))).toEqual(["8201581c" + "c2".repeat(28)]); // the removed member gone, the script member added
        expect(enc(committee[1])).toBe("d81e820305");
        expect(enc(es[2])).toBe(hex(pp(fx.params["1366"]!)));            // parameters unchanged
        expect(actionId(arr(arr(es[6])[2])[0])).toBe(UC);
        expect(arr(r[1]).map((x) => actionId(arr(x)[0]))).toEqual([UC]);
        expect(arr(r[2]).map(actionId)).toEqual([TW]);
        expect((r[3] as CborSimple).simple).toBe(true);
        expect(hex(await ask(viewOf(st, START + 1_000), Q(33)))).toBe("80");
    });
    test("GetCommitteeMembersState: the removed member ToBeRemoved, the added one Unrecognized and ToBeEnacted", async () => {
        const cms = arr(Cbor.parse(await ask(viewOf(st, START + 1_000), Q(27, emptySet(), emptySet(), emptySet()))));
        const m = (cms[0] as unknown as { map: Array<{ k: CborObj; v: CborObj }> }).map;
        const byCold = new Map(m.map((e) => [enc(e.k), arr(e.v)]));
        const cur = byCold.get("8200581c" + "c1".repeat(28))!, added = byCold.get("8201581c" + "c2".repeat(28))!;
        expect(enc(cur[3])).toBe("8101");                                 // ToBeRemoved
        expect(uint(added[1])).toBe(2);                                   // Unrecognized
        expect(enc(added[0])).toBe("8101");                               // not authorised
        expect(enc(added[3])).toBe("8100");                               // ToBeEnacted
    });
    test("a ratified TreasuryWithdrawals fills the enact state's withdrawals (credential order: script first)", async () => {
        const st2 = await storeWith({ ratified: [TW], expired: [] }, add);
        const es = arr(arr(Cbor.parse(await ask(viewOf(st2, START + 1_000), Q(32))))[0]);
        expect(enc(es[5])).toBe("a2" + "8201581c" + "77".repeat(28) + "05" + "8200581c" + "66".repeat(28) + "07");
        st2.close();
    });
});
