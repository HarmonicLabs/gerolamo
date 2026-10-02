/**
 * The ratification outcome between the boundary that ratified actions and the one that enacts them
 * (Conway `RatifyState` of the completed DRep pulser: cardano-ledger-conway 1.22.1 Rules/Ratify.hs,
 * Rules/Enact.hs, Governance.hs `predictFuturePParams`), derived from the store's pending decision:
 * the actions ratified in ratification order and those expiring. The enact state they lead to is
 * the epoch's (the pulser's `mkEnactState`: the committee, constitution and parameters in force,
 * the previous epoch's parameters, the chain roots) with each ratified action's ENACT applied in
 * order:
 *   ParameterChange       curPParams ← applyPPUpdates (cost models replaced per language)
 *   HardForkInitiation    the protocol version of curPParams
 *   TreasuryWithdrawals   withdrawals ∪+ the action's (by credential); the treasury ends at 0
 *   NoConfidence          no committee
 *   UpdateCommittee       (members ∖ removed) ∪ added (just added after a no-confidence), threshold
 *   NewConstitution       the constitution
 * `rsDelayed` is whether the last ratified action delays (no-confidence, committee, constitution,
 * hard fork): once one is ratified nothing after it is.
 */
import type { ProposalRow } from "../../../ledger/govStore";
import { mergeCostModels, type RawCostModels } from "../../../consensus/governance/costModelUpdate";
import { payloadCcAdd, payloadCcRemove } from "../../../consensus/governance/govLedgerView";
import { reduced } from "./cborWriter";
import type { Cred } from "./govAdapter";

const DELAYING = new Set(["NoConfidence", "UpdateCommittee", "NewConstitution", "InitHardFork"]);

export interface EnactInputs {
    pending: { ratified: string[]; expired: string[] } | null;
    proposal: (id: string) => ProposalRow | null;
    /** The committee in force (cold credential → expiry), null after a no-confidence. */
    committee: { members: Array<{ cold: Cred; expires: number }>; threshold: [bigint, bigint] } | null;
    constitution: { url: string; hash: string; script: string | null };
    constitutionAnchorOf: (actionId: string) => { url: string; hash: string } | null;
    /** The epoch's parameters (raw record). */
    curRaw: Record<string, unknown>;
}
export interface NextEnact {
    /** Ratified rows in ratification order (`rsEnacted`). */
    enacted: ProposalRow[];
    expired: string[];
    delayed: boolean;
    committee: { members: Array<{ cold: Cred; expires: number }>; threshold: [bigint, bigint] } | null;
    constitution: { url: string; hash: string; script: string | null };
    curRaw: Record<string, unknown>;
    /** A ratified ParameterChange or hard fork: the future parameters are `curRaw` (`predictFuturePParams`). */
    changesPParams: boolean;
    /** `ensWithdrawals`, credential order. */
    withdrawals: Array<[Cred, bigint]>;
}

const typedOf = (c: Cred) => (c.type === 1 ? "01" : "") + c.hash;
const credOf = (typed: string): Cred => (typed.length === 58 && typed.startsWith("01") ? { type: 1, hash: typed.slice(2) } : { type: 0, hash: typed.slice(-56) });
const credOrder = (a: Cred, b: Cred) => { const x = `${a.type === 1 ? 0 : 1}${a.hash}`, y = `${b.type === 1 ? 0 : 1}${b.hash}`; return x < y ? -1 : x > y ? 1 : 0; };

export function nextEnactState(i: EnactInputs): NextEnact {
    const enacted: ProposalRow[] = [];
    let committee = i.committee ? { members: new Map(i.committee.members.map((m) => [typedOf(m.cold), m])), threshold: i.committee.threshold } : null;
    let constitution = i.constitution;
    const cur: Record<string, unknown> = { ...i.curRaw };
    const withdrawals = new Map<string, bigint>();
    let changesPParams = false;
    for (const id of i.pending?.ratified ?? []) {
        const p = i.proposal(id);
        if (!p) throw new Error(`ratified action ${id} is not stored`);
        enacted.push(p);
        const payload = JSON.parse(p.payload) as Record<string, any>;
        switch (p.kind) {
            case "ParameterChange": {
                const { cost_models: cm, ...rest } = (payload.changes ?? {}) as Record<string, unknown> & { cost_models?: RawCostModels };
                Object.assign(cur, rest);
                if (cm) cur.cost_models = mergeCostModels(cur.cost_models, cm);
                changesPParams = true;
                break;
            }
            case "InitHardFork":
                cur.protocol_major_ver = Number(payload.major); cur.protocol_minor_ver = Number(payload.minor);
                changesPParams = true;
                break;
            case "TreasuryWithdrawals":
                for (const w of (payload.withdrawals ?? []) as Array<{ account: string; amount: string }>) { const k = String(w.account).toLowerCase(); withdrawals.set(k, (withdrawals.get(k) ?? 0n) + BigInt(w.amount)); }
                break;
            case "NoConfidence": committee = null; break;
            case "UpdateCommittee": {
                const members = new Map(committee?.members ?? []);
                if (committee) for (const c of payloadCcRemove(payload)) members.delete(c);
                for (const a of payloadCcAdd(payload)) { const typed = a.creds[0]!; members.set(typed, { cold: credOf(typed), expires: a.expires }); }
                committee = { members, threshold: reduced(BigInt(payload.thresholdNum ?? 0), BigInt(payload.thresholdDen ?? 1)) };
                break;
            }
            case "NewConstitution": {
                const a = i.constitutionAnchorOf(p.actionId);
                if (!a) throw new Error(`the anchor of constitution ${p.actionId} is not recorded`);
                constitution = { url: a.url, hash: a.hash, script: payload.script ?? null };
                break;
            }
            default: break;
        }
    }
    const last = enacted[enacted.length - 1];
    return {
        enacted, expired: [...(i.pending?.expired ?? [])], delayed: !!last && DELAYING.has(last.kind),
        committee: committee ? { members: [...committee.members.values()].sort((a, b) => credOrder(a.cold, b.cold)), threshold: committee.threshold } : null,
        constitution, curRaw: cur, changesPParams,
        withdrawals: [...withdrawals.entries()].map(([k, v]) => [credOf(k), v] as [Cred, bigint]).sort((a, b) => credOrder(a[0], b[0])),
    };
}
