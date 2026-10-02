/**
 * Conway RATIFY (cardano-ledger-conway 1.22.1 `Rules/Ratify.hs`, `Governance/Internal.hs`), pure:
 * one ratification round, the one the DRep pulser set up at the start of `epoch` completes at the
 * next boundary.
 *
 *   - Proposals are considered in `actionPriority` order (NoConfidence, UpdateCommittee,
 *     NewConstitution, HardFork, ParameterChange, TreasuryWithdrawals, Info), stable within a
 *     priority (submission order) — `reorderActions`.
 *   - A proposal is ratified when its parent is the purpose's current root, an UpdateCommittee's
 *     new terms end within `committeeMaxTermLength`, no delaying action was ratified earlier in the
 *     round, a TreasuryWithdrawals fits the treasury, and the committee, the SPOs and the DReps
 *     accept it. Ratified actions update the round's enact state at once (roots, parameters,
 *     committee, protocol version, treasury), so a later proposal of the round is judged against
 *     them — a second ParameterChange chained on the first can pass in the same round.
 *   - Proposals not ratified whose `expiresAfter` is below `epoch` expire.
 *
 * Committee: yes / (yes + no) over the enacted members that are unexpired, authorised and not
 * resigned; such a member that did not vote counts as No; Abstain is excluded. Outside the
 * bootstrap phase a committee with fewer active members than `committeeMinSize` cannot ratify.
 * SPOs: yes / (total − abstain); a pool that did not vote counts as No on a hard fork, as Abstain
 * during the bootstrap phase, and otherwise by its reward account's DRep delegation
 * (AlwaysNoConfidence → Yes on NoConfidence, AlwaysAbstain → Abstain, anything else → No).
 * DReps: yes / (total − abstain) over registered, unexpired DReps plus AlwaysNoConfidence
 * (Yes on NoConfidence); a DRep that did not vote counts as No; AlwaysAbstain is excluded.
 * A zero threshold accepts without counting; an action a body may not vote on has threshold zero
 * for it; an action without a threshold (Info, or a committee below its minimum size) is never
 * ratified.
 */
import type { TypedCred } from "./govTxDecode";
import { paramGroups, rationalOf, type ActionKind, type Rational } from "./tally";

export interface RatifyParams {
    protocolMajor: number;
    protocolMinor: number;
    committeeMinSize: number;
    committeeMaxTermLength: number;
    /** dvt_* and pvt_* thresholds by raw key (`pvt_p_p_security_group` for the security group). */
    drep: Record<string, Rational>;
    pool: Record<string, Rational>;
}

export interface RatifyProposal {
    id: string;
    kind: ActionKind;
    prev: string | null;
    expiresAfter: number;
    /** Changed parameter keys (raw names) of a ParameterChange; its raw changes for in-round updates. */
    changes?: Record<string, unknown>;
    /** TreasuryWithdrawals total. */
    withdrawalTotal?: bigint;
    /** UpdateCommittee. */
    ccRemove?: TypedCred[];
    ccAdd?: Array<{ cred: TypedCred; expires: number }>;
    ccThreshold?: Rational;
    /** HardFork. */
    version?: { major: number; minor: number };
    /** Votes: CC by hot credential (typed), DRep by credential (typed), SPO by pool id; 0 No, 1 Yes, 2 Abstain. */
    ccVotes: Map<TypedCred, number>;
    drepVotes: Map<TypedCred, number>;
    spoVotes: Map<string, number>;
}

export type Purpose = "pparams" | "hardfork" | "committee" | "constitution";
export const purposeOfKind = (k: ActionKind): Purpose | null => (k === "ParameterChange" ? "pparams" : k === "InitHardFork" ? "hardfork" : k === "NoConfidence" || k === "UpdateCommittee" ? "committee" : k === "NewConstitution" ? "constitution" : null);

export interface RatifyInput {
    /** The epoch the pulser was set up in (`reCurrentEpoch`). */
    epoch: number;
    params: RatifyParams;
    /** Enacted committee (cold → expiry) and its threshold; null when there is none (no confidence). */
    committee: { members: Map<TypedCred, number>; threshold: Rational } | null;
    /** Committee state at the pulser's start: cold → authorised hot key (`hotAlt`: the other reading of an untyped legacy key), or resigned. Keyed like `committee.members`. */
    committeeCreds: Map<TypedCred, { hot: TypedCred | null; hotAlt?: TypedCred; resigned: boolean }>;
    /** Live proposals in submission order. */
    proposals: RatifyProposal[];
    /** DRep stake distribution: typed credential, or "abstain" / "noconfidence". */
    drepDistr: Map<string, bigint>;
    /** Registered DReps and their expiry (`reDRepState`). */
    drepExpiry: Map<TypedCred, number>;
    /** SPO voting stake per pool (stake snapshot plus deposits), and the default vote of pools whose reward account delegates to a predefined DRep. */
    poolDistr: Map<string, bigint>;
    poolDefault: Map<string, "abstain" | "noconfidence">;
    roots: Record<Purpose, string | null>;
    treasury: bigint;
}

export interface ProposalTally {
    id: string; kind: ActionKind; ratified: boolean; reason: string;
    /** Human-readable per body: "yes/total thr n/d", "not voting" or "no threshold". */
    cc: string; drep: string; spo: string;
    /** The counted amounts (committee members; lovelace), null where the body did not count. */
    counts: { ccYes: bigint | null; ccTotal: bigint | null; drepYes: bigint | null; drepTotal: bigint | null; spoYes: bigint | null; spoTotal: bigint | null };
}
export interface RatifyOutput { ratified: string[]; expired: string[]; tallies: ProposalTally[]; roots: Record<Purpose, string | null> }

const PRIORITY: Record<ActionKind, number> = { NoConfidence: 0, UpdateCommittee: 1, NewConstitution: 2, InitHardFork: 3, ParameterChange: 4, TreasuryWithdrawals: 5, Info: 6 };
const DELAYING = new Set<ActionKind>(["NoConfidence", "UpdateCommittee", "NewConstitution", "InitHardFork"]);
const ZERO: Rational = { num: 0n, den: 1n };
const isZero = (r: Rational) => r.num === 0n;
/** ratio a/b ≥ r, with a/0 = 0 (`%?`). */
const atLeast = (a: bigint, b: bigint, r: Rational): boolean => (b === 0n ? isZero(r) : a * r.den >= r.num * b);
const maxR = (rs: Rational[]): Rational => rs.reduce((a, b) => (a.num * b.den >= b.num * a.den ? a : b), ZERO);

/** `votingCommitteeThreshold`: null = no threshold (never ratified); ZERO = voting not allowed (accepted). */
function committeeThreshold(kind: ActionKind, epoch: number, p: RatifyParams, committee: RatifyInput["committee"], creds: RatifyInput["committeeCreds"]): Rational | null {
    if (kind === "NoConfidence" || kind === "UpdateCommittee") return ZERO;
    if (kind === "Info") return null;
    if (!committee) return null;
    if (p.protocolMajor === 9) return committee.threshold;
    let active = 0;
    for (const [cold, expiry] of committee.members) { const s = creds.get(cold); if (s && !s.resigned && s.hot && epoch <= expiry) active++; }
    return active >= p.committeeMinSize ? committee.threshold : null;
}
function spoThreshold(a: RatifyProposal, p: RatifyParams, elected: boolean): Rational | null {
    const t = (k: string) => p.pool[k] ?? { num: 1n, den: 1n };
    switch (a.kind) {
        case "NoConfidence": return t("pvt_motion_no_confidence");
        case "UpdateCommittee": return t(elected ? "pvt_committee_normal" : "pvt_committee_no_confidence");
        case "NewConstitution": case "TreasuryWithdrawals": return ZERO;
        case "InitHardFork": return t("pvt_hard_fork_initiation");
        case "ParameterChange": return paramGroups(Object.keys(a.changes ?? {})).has("security") ? t("pvt_p_p_security_group") : ZERO;
        case "Info": return null;
    }
}
function drepThreshold(a: RatifyProposal, p: RatifyParams, elected: boolean): Rational | null {
    if (a.kind === "Info") return null;
    if (p.protocolMajor === 9) return ZERO; // every DRep threshold is reset to 0 in the bootstrap phase
    const t = (k: string) => p.drep[k] ?? { num: 1n, den: 1n };
    switch (a.kind) {
        case "NoConfidence": return t("dvt_motion_no_confidence");
        case "UpdateCommittee": return t(elected ? "dvt_committee_normal" : "dvt_committee_no_confidence");
        case "NewConstitution": return t("dvt_update_to_constitution");
        case "InitHardFork": return t("dvt_hard_fork_initiation");
        case "TreasuryWithdrawals": return t("dvt_treasury_withdrawal");
        case "ParameterChange": {
            const g = paramGroups(Object.keys(a.changes ?? {}));
            const rs: Rational[] = [];
            if (g.has("network")) rs.push(t("dvt_p_p_network_group"));
            if (g.has("economic")) rs.push(t("dvt_p_p_economic_group"));
            if (g.has("technical")) rs.push(t("dvt_p_p_technical_group"));
            if (g.has("gov")) rs.push(t("dvt_p_p_gov_group"));
            return maxR(rs);
        }
    }
}

/** A ParameterChange's effect on the thresholds and committee bounds later proposals of the round are judged with. */
function applyParams(p: RatifyParams, changes: Record<string, unknown>): RatifyParams {
    const out: RatifyParams = { ...p, drep: { ...p.drep }, pool: { ...p.pool } };
    for (const [k, v] of Object.entries(changes)) {
        if (k.startsWith("dvt_")) out.drep[k] = rationalOf(v, "1");
        else if (k.startsWith("pvt_")) out.pool[k] = rationalOf(v, "1");
        else if (k === "committee_min_size") out.committeeMinSize = Number(v);
        else if (k === "committee_max_term_length") out.committeeMaxTermLength = Number(v);
    }
    return out;
}

export function ratifyRound(input: RatifyInput): RatifyOutput {
    const { epoch } = input;
    let params = input.params;
    let committee = input.committee ? { members: new Map(input.committee.members), threshold: input.committee.threshold } : null;
    let treasury = input.treasury;
    const roots = { ...input.roots };
    let delayed = false;
    const ratified: string[] = [], expired: string[] = [], tallies: ProposalTally[] = [];
    // stable: Array.prototype.sort is stable, the input is in submission order
    const ordered = input.proposals.map((p, i) => ({ p, i })).sort((a, b) => PRIORITY[a.p.kind] - PRIORITY[b.p.kind] || a.i - b.i).map((x) => x.p);
    let poolTotal = 0n; for (const s of input.poolDistr.values()) poolTotal += s;

    for (const a of ordered) {
        const purpose = purposeOfKind(a.kind);
        const elected = committee != null;
        const tally: ProposalTally = { id: a.id, kind: a.kind, ratified: false, reason: "", cc: "-", drep: "-", spo: "-", counts: { ccYes: null, ccTotal: null, drepYes: null, drepTotal: null, spoYes: null, spoTotal: null } };
        let ok = true;
        if (purpose && (a.prev ?? null) !== (roots[purpose] ?? null)) { ok = false; tally.reason = "prev is not the enacted root"; }
        if (ok && a.kind === "UpdateCommittee" && (a.ccAdd ?? []).some((m) => m.expires > epoch + params.committeeMaxTermLength)) { ok = false; tally.reason = "term beyond committeeMaxTermLength"; }
        if (ok && delayed) { ok = false; tally.reason = "delayed"; }
        if (ok && a.kind === "TreasuryWithdrawals" && (a.withdrawalTotal ?? 0n) > treasury) { ok = false; tally.reason = "treasury insufficient"; }
        if (ok) {
            // committee
            const ct = committeeThreshold(a.kind, epoch, params, committee, input.committeeCreds);
            let ccOk: boolean;
            if (ct == null) { ccOk = false; tally.cc = "no threshold"; }
            else if (isZero(ct)) { ccOk = true; tally.cc = "not voting"; }
            else {
                let yes = 0n, tot = 0n;
                for (const [cold, expiry] of committee!.members) {
                    if (epoch > expiry) continue;
                    const s = input.committeeCreds.get(cold);
                    if (!s || s.resigned || !s.hot) continue;
                    const v = a.ccVotes.get(s.hot) ?? (s.hotAlt ? a.ccVotes.get(s.hotAlt) : undefined);
                    if (v === undefined || v === 0) tot++; else if (v === 1) { yes++; tot++; }
                }
                ccOk = atLeast(yes, tot, ct);
                tally.cc = `${yes}/${tot} thr ${ct.num}/${ct.den}`;
                tally.counts.ccYes = yes; tally.counts.ccTotal = tot;
            }
            // SPOs
            const st = spoThreshold(a, params, elected);
            let spoOk: boolean;
            if (st == null) { spoOk = false; tally.spo = "no threshold"; }
            else if (isZero(st)) { spoOk = true; tally.spo = "not voting"; }
            else {
                let yes = 0n, abstain = 0n;
                const bootstrap = params.protocolMajor === 9;
                for (const [pool, stake] of input.poolDistr) {
                    const v = a.spoVotes.get(pool);
                    if (v === undefined) {
                        if (a.kind === "InitHardFork") continue;
                        if (bootstrap) { abstain += stake; continue; }
                        const d = input.poolDefault.get(pool);
                        if (d === "noconfidence" && a.kind === "NoConfidence") yes += stake;
                        else if (d === "abstain") abstain += stake;
                    } else if (v === 2) abstain += stake;
                    else if (v === 1) yes += stake;
                }
                spoOk = atLeast(yes, poolTotal - abstain, st);
                tally.spo = `${yes}/${poolTotal - abstain} thr ${st.num}/${st.den}`;
                tally.counts.spoYes = yes; tally.counts.spoTotal = poolTotal - abstain;
            }
            // DReps
            const dt = drepThreshold(a, params, elected);
            let drepOk: boolean;
            if (dt == null) { drepOk = false; tally.drep = "no threshold"; }
            else if (isZero(dt)) { drepOk = true; tally.drep = "not voting"; }
            else {
                let yes = 0n, tot = 0n;
                for (const [k, stake] of input.drepDistr) {
                    if (k === "abstain") continue;
                    if (k === "noconfidence") { tot += stake; if (a.kind === "NoConfidence") yes += stake; continue; }
                    const expiry = input.drepExpiry.get(k);
                    if (expiry === undefined || epoch > expiry) continue;
                    const v = a.drepVotes.get(k);
                    if (v === undefined || v === 0) tot += stake; else if (v === 1) { yes += stake; tot += stake; }
                }
                drepOk = atLeast(yes, tot, dt);
                tally.drep = `${yes}/${tot} thr ${dt.num}/${dt.den}`;
                tally.counts.drepYes = yes; tally.counts.drepTotal = tot;
            }
            ok = ccOk && spoOk && drepOk;
            if (!ok) tally.reason = `not accepted (cc ${ccOk ? "yes" : "no"}, spo ${spoOk ? "yes" : "no"}, drep ${drepOk ? "yes" : "no"})`;
        }
        if (ok) {
            // ENACT into the round's state
            tally.ratified = true; tally.reason = "ratified";
            ratified.push(a.id);
            if (purpose) roots[purpose] = a.id;
            switch (a.kind) {
                case "ParameterChange": params = applyParams(params, a.changes ?? {}); break;
                case "InitHardFork": if (a.version) params = { ...params, protocolMajor: a.version.major, protocolMinor: a.version.minor }; break;
                case "TreasuryWithdrawals": treasury -= a.withdrawalTotal ?? 0n; break;
                case "NoConfidence": committee = null; break;
                case "UpdateCommittee": {
                    const members = committee ? new Map(committee.members) : new Map<TypedCred, number>();
                    if (committee) for (const c of a.ccRemove ?? []) members.delete(c);
                    for (const m of a.ccAdd ?? []) members.set(m.cred, m.expires);
                    committee = { members, threshold: a.ccThreshold ?? ZERO };
                    break;
                }
                default: break;
            }
            delayed = DELAYING.has(a.kind);
        } else if (a.expiresAfter < epoch) expired.push(a.id);
        tallies.push(tally);
    }
    return { ratified, expired, tallies, roots };
}
