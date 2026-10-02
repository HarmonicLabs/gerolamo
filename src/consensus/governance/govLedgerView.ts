/**
 * The governance state the GOV / GOVCERT / DELEG / POOL checks and the ratification read, from
 * the LMDB ledger store (lmdb mode) or the SQLite tables, keyed the way the ledger keys it.
 *
 * Credential storage (bug 153):
 *   DReps        typed hex (hash for a key credential, "01" + hash for a script) as the row key;
 *                rows written before typing are keyed by the bare hash and carry `is_script`, which
 *                is authoritative either way.
 *   committee    cold (and hot) credentials as "00" + hash / "01" + hash; a 56-character key is a
 *                row from before typing whose credential type is unknown — it matches both types
 *                (`ccCredsOf`) until a certificate, vote or the migration names its type.
 *   proposals    UpdateCommittee payloads carry `typed: true` and typed creds; older payloads hold
 *                bare hashes (both types).
 */
import { sql } from "../../sql";
import { ledgerGovReads, ledgerStakeReads, ledgerStateExact } from "../../ledger/nodeLedgerStore";
import { readRewardPots } from "../../db/leaderState";
import type { DRepTarget, GovTxModel, TypedCred } from "./govTxDecode";
import { voterCred } from "./govTxDecode";
import type { CommitteeCred, GovLedgerView, ProposalView, Purpose } from "./govRules";
import { paramGroups, type Rational } from "./tally";

// ───────────────────────────── storage conventions ─────────────────────────────

/** Committee storage key of a typed credential ("00"/"01" + hash). */
export const ccKey = (c: TypedCred): string => (c.length === 58 ? c : `00${c}`);
/** Typed credentials a committee storage key stands for (both for a legacy untyped key). */
export function ccCredsOf(k: string | null | undefined): TypedCred[] {
    if (!k) return [];
    const s = k.toLowerCase();
    if (s.length === 58) return [s.startsWith("00") ? s.slice(2) : s];
    return [s, `01${s}`];
}
export const ccIsLegacy = (k: string): boolean => k.length === 56;
/** Typed credential of a DRep row (the key may be bare from before typing; `is_script` decides). */
export function drepCredOfRow(key: string, isScript: number | boolean | null | undefined): TypedCred {
    const h = key.length === 58 ? key.slice(2) : key;
    return isScript ? `01${h.toLowerCase()}` : h.toLowerCase();
}
/** Storage key of a DRep (typed). */
export const drepKey = (c: TypedCred): string => c;
const bareOf = (c: TypedCred): string => (c.length === 58 ? c.slice(2) : c);
/** UpdateCommittee payload creds as typed credentials (legacy payloads: both types per hash). */
export function payloadCcAdd(payload: any): Array<{ creds: TypedCred[]; expires: number }> {
    const typed = payload?.typed === true;
    return ((payload?.add ?? []) as Array<{ cred: string; expires: number }>).map((a) => ({ creds: typed ? [String(a.cred)] : [String(a.cred), `01${a.cred}`], expires: Number(a.expires) }));
}
export function payloadCcRemove(payload: any): TypedCred[] {
    const typed = payload?.typed === true;
    return ((payload?.remove ?? []) as string[]).flatMap((c) => (typed ? [String(c)] : [String(c), `01${c}`]));
}

const kindType: Record<string, number> = { ParameterChange: 0, InitHardFork: 1, TreasuryWithdrawals: 2, NoConfidence: 3, UpdateCommittee: 4, NewConstitution: 5, Info: 6 };

// ───────────────────────────── committee, proposals, roots ─────────────────────────────

export interface CommitteeView {
    /** Enacted members (cold → expiry) by typed credential, a legacy row under both readings; null when there is no committee (no confidence). */
    members: Map<TypedCred, number> | null;
    threshold: Rational;
    /** `csCommitteeCreds` by typed cold credential (legacy rows under both readings). */
    creds: Map<TypedCred, CommitteeCred>;
    /** The same, one entry per stored row (for counting: a legacy row must not count twice). */
    rowMembers: Map<string, number> | null;
    rowCreds: Map<string, CommitteeCred>;
}

export async function loadCommitteeView(): Promise<CommitteeView> {
    const gr = ledgerGovReads();
    let thrNum = 2, thrDen = 3, noConfidence = false;
    const memberRows: Array<[string, number, string | null, number]> = [];
    const authRows: Array<[string, string | null, number]> = [];
    if (gr) {
        const s = gr.state();
        if (s) { thrNum = s.thrNum; thrDen = s.thrDen; noConfidence = s.noConfidence === 1; }
        for (const [k, c] of gr.committee()) memberRows.push([k, c.expiresEpoch, c.hot, c.resigned]);
        for (const [k, a] of gr.committeeAuths()) authRows.push([k, a.hot, a.resigned]);
    } else {
        const st = (await sql`SELECT committee_threshold_num, committee_threshold_den, no_confidence FROM gov_state WHERE id = 1`.values()) as unknown[][];
        if (st[0]) { thrNum = Number(st[0][0]); thrDen = Number(st[0][1]); noConfidence = Number(st[0][2]) === 1; }
        for (const r of (await sql`SELECT cold_credential, expires_epoch, hot_credential, resigned FROM gov_committee`.values()) as unknown[][]) memberRows.push([String(r[0]), Number(r[1]), r[2] == null ? null : String(r[2]), Number(r[3] ?? 0)]);
        for (const r of (await sql`SELECT cold_credential, hot_credential, resigned FROM gov_committee_auth`.values()) as unknown[][]) authRows.push([String(r[0]), r[1] == null ? null : String(r[1]), Number(r[2] ?? 0)]);
    }
    const members = noConfidence ? null : new Map<TypedCred, number>();
    const rowMembers = noConfidence ? null : new Map<string, number>();
    for (const [k, exp] of memberRows) { rowMembers?.set(k.toLowerCase(), exp); if (members) for (const c of ccCredsOf(k)) members.set(c, exp); }
    const creds: CommitteeView["creds"] = new Map(), rowCreds: CommitteeView["rowCreds"] = new Map();
    const put = (k: string, hot: string | null, resigned: number) => {
        const hs = ccCredsOf(hot);
        const v: CommitteeCred = { hot: resigned ? null : hs[0] ?? null, ...(hs.length > 1 && !resigned ? { hotAlt: hs[1] } : {}), resigned: resigned === 1 };
        rowCreds.set(k.toLowerCase(), v);
        for (const c of ccCredsOf(k)) creds.set(c, v);
    };
    // Members written before the authorisation table existed carry their hot key on the row.
    for (const [k, , hot, resigned] of memberRows) if (hot != null || resigned) put(k, hot, resigned);
    for (const [k, hot, resigned] of authRows) put(k, hot, resigned);
    return { members, threshold: { num: BigInt(thrNum), den: BigInt(thrDen) }, creds, rowMembers, rowCreds };
}

export interface LiveProposal { id: string; seq: number; kind: string; prev: string | null; deposit: bigint; returnAccount: string; payload: any; proposedEpoch: number; expiresEpoch: number; status: string }

/** Proposals the ledger still holds: submitted and not yet removed at a boundary (active or ratified-not-enacted), in submission order. */
export async function loadLiveProposals(): Promise<LiveProposal[]> {
    const gr = ledgerGovReads();
    if (gr) return gr.proposals(["active", "ratified"]).map((p) => ({ id: p.actionId, seq: p.seq, kind: p.kind, prev: p.prevActionId, deposit: BigInt(p.deposit), returnAccount: p.returnAccount, payload: JSON.parse(p.payload), proposedEpoch: p.proposedEpoch, expiresEpoch: p.expiresEpoch, status: p.status }));
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status FROM gov_proposals WHERE status IN ('active', 'ratified') ORDER BY seq`.values()) as unknown[][];
    return rows.map((r) => ({ id: String(r[0]), seq: Number(r[1]), kind: String(r[2]), prev: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), returnAccount: String(r[5]), payload: JSON.parse(String(r[6])), proposedEpoch: Number(r[7]), expiresEpoch: Number(r[8]), status: String(r[9]) }));
}

export function proposalViewOf(p: LiveProposal): ProposalView {
    const type = kindType[p.kind] ?? 6;
    return {
        id: p.id, type, prev: p.prev, expiresAfter: p.expiresEpoch,
        ...(type === 1 ? { major: Number(p.payload?.major ?? 0), minor: Number(p.payload?.minor ?? 0) } : {}),
        ...(type === 4 ? { ccAdd: payloadCcAdd(p.payload).flatMap((a) => a.creds) } : {}),
        ...(type === 0 ? { security: paramGroups(Object.keys(p.payload?.changes ?? {})).has("security") } : {}),
    };
}

/**
 * The enacted root of every purpose (`pRoots`). `gov_state.prev_*` advance when an action is
 * ratified (the next pulser needs them); until the next boundary enacts it the ledger's root is
 * still its parent, i.e. the `prev` of the first action of that purpose the pending round ratified.
 */
export async function loadRoots(live?: LiveProposal[]): Promise<Record<Purpose, string | null>> {
    const gr = ledgerGovReads();
    let row: [string | null, string | null, string | null, string | null, string | null] | null = null;
    if (gr) { const s = gr.state(); if (s) row = [s.prevPP, s.prevHF, s.prevCC, s.prevCons, s.pending]; }
    else { const r = (await sql`SELECT prev_pparams, prev_hardfork, prev_committee, prev_constitution, pending FROM gov_state WHERE id = 1`.values()) as unknown[][]; if (r[0]) row = r[0].map((x) => (x == null ? null : String(x))) as any; }
    const roots: Record<Purpose, string | null> = { pparams: row?.[0] ?? null, hardfork: row?.[1] ?? null, committee: row?.[2] ?? null, constitution: row?.[3] ?? null };
    let pending: { ratified?: string[] } | null = null;
    try { pending = row?.[4] ? JSON.parse(row[4]) : null; } catch { pending = null; }
    if (pending?.ratified?.length) {
        const byId = new Map((live ?? (await loadLiveProposals())).map((p) => [p.id, p]));
        const seen = new Set<Purpose>();
        for (const id of pending.ratified) {
            const p = byId.get(id);
            if (!p || p.status !== "ratified") continue; // already enacted: the root is current
            const t = kindType[p.kind] ?? 6;
            const purpose: Purpose | null = t === 0 ? "pparams" : t === 1 ? "hardfork" : t === 3 || t === 4 ? "committee" : t === 5 ? "constitution" : null;
            if (!purpose || seen.has(purpose)) continue;
            seen.add(purpose);
            roots[purpose] = p.prev;
        }
    }
    return roots;
}

export async function loadConstitutionScript(): Promise<string | null> {
    const gr = ledgerGovReads();
    if (gr) return gr.state()?.constitutionScript ?? null;
    const r = (await sql`SELECT constitution_script FROM gov_state WHERE id = 1`.values()) as unknown[][];
    return r[0]?.[0] == null ? null : String(r[0][0]).toLowerCase();
}

// ───────────────────────────── DReps ─────────────────────────────

/** Registered DReps: typed credential → { deposit, expiry }. */
export async function loadDReps(): Promise<Map<TypedCred, { deposit: bigint; expiry: number | null; lastActive: number }>> {
    const out = new Map<TypedCred, { deposit: bigint; expiry: number | null; lastActive: number }>();
    const gr = ledgerGovReads();
    if (gr) { for (const [k, d] of gr.dreps()) out.set(drepCredOfRow(k, d.isScript), { deposit: BigInt(d.deposit), expiry: d.expiryEpoch, lastActive: d.lastActiveEpoch }); return out; }
    for (const r of (await sql`SELECT credential, is_script, deposit, expiry_epoch, last_active_epoch FROM gov_dreps`.values()) as unknown[][]) out.set(drepCredOfRow(String(r[0]), Number(r[1])), { deposit: BigInt(String(r[2])), expiry: r[3] == null ? null : Number(r[3]), lastActive: Number(r[4]) });
    return out;
}

async function drepRow(c: TypedCred): Promise<{ deposit: bigint } | null> {
    const gr = ledgerGovReads();
    const script = c.length === 58;
    if (gr) {
        const d = gr.drep(c) ?? (script ? gr.drep(bareOf(c)) : null);
        if (!d || (d.isScript ? 1 : 0) !== (script ? 1 : 0)) return null;
        return { deposit: BigInt(d.deposit) };
    }
    const rows = (await sql`SELECT deposit, is_script FROM gov_dreps WHERE credential IN (${c}, ${bareOf(c)})`.values()) as unknown[][];
    const r = rows.find((x) => (Number(x[1]) ? 1 : 0) === (script ? 1 : 0));
    return r ? { deposit: BigInt(String(r[0])) } : null;
}

// ───────────────────────────── the block view ─────────────────────────────

function hexToBytes(h: string): Uint8Array { return Uint8Array.from(Buffer.from(h, "hex")); }

/**
 * A `GovLedgerView` over the current state for the transactions of one block: every account,
 * pool and DRep the block's governance content names is read up front (the rules are synchronous).
 */
export async function buildGovLedgerView(txs: GovTxModel[], opts: { needVrfs: boolean; balancesUnknown?: boolean }): Promise<GovLedgerView> {
    const accounts = new Set<TypedCred>(), pools = new Set<string>(), dreps = new Set<TypedCred>();
    for (const t of txs) {
        for (const w of t.withdrawals) accounts.add(w.account.cred);
        for (const c of t.certs) {
            if (c.type >= 16 && c.type <= 18) { if (c.cred) dreps.add(c.cred); }
            else if (c.cred) accounts.add(c.cred);
            if (c.pool) pools.add(c.pool);
            if (c.drep?.kind === "cred") dreps.add(c.drep.cred);
        }
        for (const p of t.proposals) { accounts.add(p.returnAccount.cred); if (p.action.type === 2) for (const w of p.action.withdrawals) accounts.add(w.account.cred); }
        for (const v of t.votes) { if (v.voterKind === 2 || v.voterKind === 3) dreps.add(voterCred(v.voterKind, v.voterHash)); if (v.voterKind === 4) pools.add(v.voterHash); }
    }
    const sr = ledgerStakeReads(), gr = ledgerGovReads();
    const reg = new Map<TypedCred, boolean>(), bal = new Map<TypedCred, bigint>(), dd = new Map<TypedCred, DRepTarget | null>();
    for (const a of accounts) {
        const script = a.length === 58, hash = bareOf(a);
        if (sr) {
            reg.set(a, sr.isRegistered(a));
            bal.set(a, sr.rewardBalance(a));
        } else {
            const rows = (await sql`SELECT 1 FROM stake WHERE stake_credentials = ${hexToBytes(hash)} AND (cred_type IS NULL OR cred_type = ${script ? 1 : 0}) LIMIT 1`.values()) as unknown[][];
            reg.set(a, rows.length > 0);
            const rw = (await sql`SELECT COALESCE(SUM(amount), 0) FROM rewards WHERE stake_credentials = ${hexToBytes(a)}`.values()) as unknown[][];
            bal.set(a, BigInt(String(rw[0]?.[0] ?? 0)));
        }
        const d = gr ? gr.drepDelegation(a) : (((await sql`SELECT drep_type, drep_hash FROM gov_drep_delegations WHERE stake_key = ${a}`.values()) as unknown[][]).map((r) => ({ type: Number(r[0]), hash: r[1] == null ? null : String(r[1]) }))[0] ?? null);
        dd.set(a, !reg.get(a) || !d ? null : d.type === 2 ? { kind: "abstain" } : d.type === 3 ? { kind: "noConfidence" } : { kind: "cred", cred: d.type === 1 ? `01${d.hash}` : String(d.hash) });
    }
    const poolReg = new Map<string, string | null>(); // pool → vrf (null = not registered)
    for (const p of pools) {
        if (sr) { const r = sr.pool(p); poolReg.set(p, r ? r.vrf : null); }
        else { const r = (await sql`SELECT vrf_key_hash FROM pool_params WHERE pool_id = ${p}`.values()) as unknown[][]; poolReg.set(p, r[0] ? String(r[0][0]) : null); }
    }
    let vrfs: Set<string> | null = null;
    if (opts.needVrfs) {
        vrfs = new Set();
        if (sr) { for (const r of sr.pools().values()) vrfs.add(r.vrf); for (const r of sr.pendingPools().values()) vrfs.add(r.vrf); }
        else {
            for (const r of (await sql`SELECT vrf_key_hash FROM pool_params`.values()) as unknown[][]) vrfs.add(String(r[0]));
            try { for (const r of (await sql`SELECT vrf_key_hash FROM pool_params_pending`.values()) as unknown[][]) vrfs.add(String(r[0])); } catch { /* table absent */ }
        }
    }
    const drepInfo = new Map<TypedCred, { deposit: bigint } | null>();
    for (const d of dreps) drepInfo.set(d, await drepRow(d));
    // committee, proposals, roots and the guardrail script only when some transaction reads them
    // (a block with withdrawals only is the common case)
    const needGov = txs.some((t) => t.proposals.length || t.votes.length || t.certs.some((c) => c.type === 14 || c.type === 15));
    const committee: CommitteeView = needGov ? await loadCommitteeView() : { members: new Map(), threshold: { num: 2n, den: 3n }, creds: new Map(), rowMembers: new Map(), rowCreds: new Map() };
    const live = needGov ? await loadLiveProposals() : [];
    const props = new Map<string, ProposalView>(live.map((p) => [p.id, proposalViewOf(p)]));
    const roots = needGov ? await loadRoots(live) : { pparams: null, hardfork: null, committee: null, constitution: null };
    const script = needGov ? await loadConstitutionScript() : null;
    const pots = txs.some((t) => t.treasuryValue != null) ? await readRewardPots().catch(() => null) : null;
    const exactness = ledgerStateExact(); // balances and pots from the same store
    return {
        accountRegistered: (c) => (reg.has(c) ? reg.get(c)! : null),
        accountDeposit: () => null,
        accountBalance: (c) => (!opts.balancesUnknown && bal.has(c) ? bal.get(c)! : null),
        balancesExact: () => exactness,
        accountDRep: (c) => (dd.has(c) ? dd.get(c)! : undefined),
        poolRegistered: (p) => (poolReg.has(p) ? poolReg.get(p) != null : null),
        poolVrf: (p) => poolReg.get(p) ?? null,
        registeredVrfs: () => vrfs,
        drepRegistered: (c) => (drepInfo.has(c) ? drepInfo.get(c) != null : null),
        drepDeposit: (c) => drepInfo.get(c)?.deposit ?? null,
        committeeMembers: () => committee.members,
        committeeCreds: () => committee.creds,
        proposals: () => props,
        roots: () => roots,
        constitutionScript: () => script,
        treasury: () => pots?.treasury ?? null,
    };
}

