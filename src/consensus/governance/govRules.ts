/**
 * Conway GOV, GOVCERT and the governance parts of LEDGER, as cardano-ledger-conway 1.22.1
 * (the version cardano-node 11.0.1 runs) defines them:
 *
 *   LEDGER  `validateTreasuryValue` (body key 21 must equal the treasury) and, after the bootstrap
 *           phase, `validateWithdrawalsDelegated` (a key-hash reward account that withdraws must be
 *           delegated to a DRep);
 *   CERTS   the transaction's withdrawals drain the accounts first, then every certificate runs in
 *           order through DELEG / POOL (certificateRules.ts) or GOVCERT (here);
 *   GOV     the proposals in order (deposit, return account, network ids, guardrail script,
 *           previous-action chain, hard-fork succession, committee update bounds, bootstrap-phase
 *           restrictions), then the votes (unknown voters and actions, expired actions, voters an
 *           action type does not admit, bootstrap-phase restrictions, protocol-11 unelected
 *           committee members).
 *
 * GOV and CERTS run only for phase-2-valid transactions. The rules read the state before the
 * transaction (CERTS) and after its certificates (GOV); `GovBlockOverlay` carries the effects of
 * the earlier transactions of the block and of the earlier certificates of the transaction.
 * Failure strings start with the rule and the ledger's constructor name.
 */
import { conwayDelegPoolFailures, type CertLedgerView, type CertRuleParams } from "../certificateRules";
import { GOV_ACTION_NAMES, credHashOf, updateUint, voterCred, type DRepTarget, type GovTxModel, type ProposalModel, type TypedCred } from "./govTxDecode";

export interface GovRuleParams extends CertRuleParams {
    govActionDeposit: bigint;
    drepDeposit: bigint;
    govActionLifetime: number;
}

export type Purpose = "pparams" | "hardfork" | "committee" | "constitution";
export const purposeOfType = (t: number): Purpose | null => (t === 0 ? "pparams" : t === 1 ? "hardfork" : t === 3 || t === 4 ? "committee" : t === 5 ? "constitution" : null);

/** A live proposal (submitted, not yet removed at a boundary) as the GOV rule sees it. */
export interface ProposalView {
    id: string;
    type: number;
    prev: string | null;
    expiresAfter: number;
    /** HardForkInitiation's protocol version. */
    major?: number;
    minor?: number;
    /** UpdateCommittee's members to add (cold credentials). */
    ccAdd?: TypedCred[];
    /** ParameterChange touching a security-group parameter (SPO votes are admitted on it). */
    security?: boolean;
}

export interface GovLedgerView extends CertLedgerView {
    /** Deposit a registered DRep paid (its refund), null when not registered. */
    drepDeposit(cred: TypedCred): bigint | null;
    /** The account's DRep delegation: null when none (or no account), undefined when unknown. */
    accountDRep(cred: TypedCred): DRepTarget | null | undefined;
    /** Members of the enacted committee (cold → expiry epoch); null when there is none (no confidence). */
    committeeMembers(): Map<TypedCred, number> | null;
    /**
     * The committee state (`csCommitteeCreds`): cold credential → authorised hot key or resignation.
     * `hotAlt` is the other reading of a hot key stored before credentials were typed (either may vote).
     */
    committeeCreds(): Map<TypedCred, CommitteeCred>;
    /** Live proposals by action id. */
    proposals(): Map<string, ProposalView>;
    /** The enacted root of every purpose (`pRoots`): the last enacted action id, null for none. */
    roots(): Record<Purpose, string | null>;
    constitutionScript(): string | null;
    treasury(): bigint | null;
}

export interface CommitteeCred { hot: TypedCred | null; hotAlt?: TypedCred; resigned: boolean }

export interface GovTxVerdict { failures: string[]; reports: string[] }

// ───────────────────────────── overlay ─────────────────────────────

/** The state a block's transactions see: the base view plus the effects of what came before in the block. */
export class GovBlockOverlay implements GovLedgerView {
    private accounts = new Map<TypedCred, { registered: boolean; deposit: bigint | null }>();
    private balances = new Map<TypedCred, bigint>();
    private delegs = new Map<TypedCred, DRepTarget | null>();
    private pools = new Map<string, string>();
    private dreps = new Map<TypedCred, bigint | null>();
    private unregisteredDReps = new Set<TypedCred>();
    private ccCreds: Map<TypedCred, CommitteeCred> | null = null;
    private props: Map<string, ProposalView> | null = null;
    private members: Map<TypedCred, number> | null | undefined = undefined;
    private cachedVrfs: Set<string> | null | undefined = undefined;
    private cachedRoots: Record<Purpose, string | null> | null = null;
    constructor(private readonly base: GovLedgerView) {}

    accountRegistered(c: TypedCred): boolean | null { const a = this.accounts.get(c); return a ? a.registered : this.base.accountRegistered(c); }
    accountDeposit(c: TypedCred): bigint | null { const a = this.accounts.get(c); return a ? a.deposit : this.base.accountDeposit(c); }
    accountBalance(c: TypedCred): bigint | null { const b = this.balances.get(c); if (b !== undefined) return b; const a = this.accounts.get(c); if (a) return a.registered ? 0n : null; return this.base.accountBalance(c); }
    balancesExact(): { exact: boolean; why: string } { return this.base.balancesExact?.() ?? { exact: false, why: "reward balances not proven exact" }; }
    accountDRep(c: TypedCred): DRepTarget | null | undefined {
        const a = this.accounts.get(c);
        if (a && !a.registered) return null;
        const d = this.delegs.has(c) ? this.delegs.get(c)! : a ? null : this.base.accountDRep(c);
        if (d && d.kind === "cred" && this.unregisteredDReps.has(d.cred)) return null; // cleared by the DRep's unregistration
        return d;
    }
    poolRegistered(p: string): boolean | null { return this.pools.has(p) ? true : this.base.poolRegistered(p); }
    poolVrf(p: string): string | null { return this.pools.get(p) ?? this.base.poolVrf(p); }
    registeredVrfs(): Set<string> | null {
        if (this.cachedVrfs === undefined) this.cachedVrfs = this.base.registeredVrfs();
        if (!this.cachedVrfs) return null;
        const out = new Set(this.cachedVrfs); for (const v of this.pools.values()) out.add(v); return out;
    }
    drepRegistered(c: TypedCred): boolean | null { if (this.dreps.has(c)) return this.dreps.get(c) != null; return this.base.drepRegistered(c); }
    drepDeposit(c: TypedCred): bigint | null { return this.dreps.has(c) ? this.dreps.get(c)! : this.base.drepDeposit(c); }
    committeeMembers(): Map<TypedCred, number> | null { if (this.members === undefined) this.members = this.base.committeeMembers(); return this.members; }
    committeeCreds(): Map<TypedCred, CommitteeCred> { if (!this.ccCreds) this.ccCreds = new Map(this.base.committeeCreds()); return this.ccCreds; }
    proposals(): Map<string, ProposalView> { if (!this.props) this.props = new Map(this.base.proposals()); return this.props; }
    roots(): Record<Purpose, string | null> { if (!this.cachedRoots) this.cachedRoots = this.base.roots(); return this.cachedRoots; }
    constitutionScript(): string | null { return this.base.constitutionScript(); }
    treasury(): bigint | null { return this.base.treasury(); }

    // effects
    drain(c: TypedCred, amount: bigint): void { const b = this.accountBalance(c); if (b != null) this.balances.set(c, b - amount); }
    registerAccount(c: TypedCred, deposit: bigint): void { this.accounts.set(c, { registered: true, deposit }); this.balances.set(c, 0n); this.delegs.set(c, null); }
    unregisterAccount(c: TypedCred): void { this.accounts.set(c, { registered: false, deposit: null }); this.balances.delete(c); this.delegs.set(c, null); }
    delegateVote(c: TypedCred, d: DRepTarget): void { this.delegs.set(c, d); }
    registerPool(p: string, vrf: string): void { this.pools.set(p, vrf); }
    registerDRep(c: TypedCred, deposit: bigint): void { this.dreps.set(c, deposit); this.unregisteredDReps.delete(c); }
    unregisterDRep(c: TypedCred): void {
        this.dreps.set(c, null); this.unregisteredDReps.add(c);
        for (const [k, d] of this.delegs) if (d && d.kind === "cred" && d.cred === c) this.delegs.set(k, null);
    }
    setCommitteeCred(cold: TypedCred, v: CommitteeCred): void { this.committeeCreds().set(cold, v); }
    addProposal(p: ProposalView): void { this.proposals().set(p.id, p); }
}

// ───────────────────────────── helpers ─────────────────────────────

const isBootstrapAction = (t: number) => t === 0 || t === 1 || t === 6;
/** Protocol versions run up to `MaxVersion` (13 in cardano-ledger-binary 1.7); `succVersion` fails beyond. */
const MAX_VERSION = 13;
const succVersion = (v: number): number | null => (v + 1 <= MAX_VERSION ? v + 1 : null);
/** Shelley `pvCanFollow`: the next major with minor 0, or the same major with the next minor. */
export function pvCanFollow(prev: { major: number; minor: number }, next: { major: number; minor: number }): boolean {
    const s = succVersion(prev.major);
    return (s != null && s === next.major && next.minor === 0) || (prev.major === next.major && prev.minor + 1 === next.minor);
}

/**
 * Conway `ppuWellFormed`: no zero where zero breaks the chain (block/tx/header/value size,
 * collateral percentage, committee term, action lifetime, pool / action / DRep deposit, after the
 * bootstrap phase the UTxO byte price, from protocol 11 nOpt) and not an empty update.
 * Keys are the CBOR keys of `protocol_param_update`.
 */
export function ppuWellFormed(pv: { major: number }, update: Map<number, unknown>): boolean {
    if (update.size === 0) return false;
    const nonZero = [2, 3, 4, 22, 23, 28, 29, 6, 30, 31];
    if (pv.major !== 9) nonZero.push(17);
    if (pv.major >= 11) nonZero.push(8);
    for (const k of nonZero) { const v = updateUint(update as any, k); if (v === 0n) return false; }
    // key 17 as a rational / other shapes: only the unsigned integers above can be zero here
    return true;
}

/** Stake-pool votes are admitted on hard forks, committee actions, no-confidence and security-group parameter changes; Info takes every voter. */
const SECURITY_KEYS = new Set([0, 1, 2, 3, 4, 17, 21, 22, 30, 33]); // min_fee_a/b, block/tx/header size, coins/byte, block ex-units, value size, action deposit, ref-script fee
function spoVotingAllowed(p: ProposalView, securityRelevant: boolean): boolean {
    switch (p.type) { case 5: case 2: return false; case 0: return securityRelevant; default: return true; }
}

// ───────────────────────────── the transaction ─────────────────────────────

/**
 * Check one phase-2-valid transaction against the governance rules and apply its effects to the
 * overlay (whether or not it passes: the block is judged as a whole).
 */
export function checkGovTx(tx: GovTxModel, pp: GovRuleParams, v: GovBlockOverlay): GovTxVerdict {
    const failures: string[] = [], reports: string[] = [];
    const bootstrap = pp.protocolMajor === 9;

    // LEDGER: declared treasury, withdrawals delegated to a DRep (state before the certificates)
    // (the treasury is as exact as the balances: one store; report-only otherwise, as rules/txRules.ts — bug 273)
    if (tx.treasuryValue != null) {
        const t = v.treasury();
        if (t != null && t !== tx.treasuryValue) { const ex = v.balancesExact(); const msg = `LEDGER ConwayTreasuryValueMismatch supplied ${tx.treasuryValue} expected ${t}`; if (ex.exact) failures.push(msg); else reports.push(`${msg} (report-only: ${ex.why})`); }
    }
    if (!bootstrap) {
        const bad: string[] = [];
        for (const w of tx.withdrawals) {
            if (w.account.cred.length !== 56) continue; // script accounts are not checked
            const d = v.accountDRep(w.account.cred);
            if (d === null) bad.push(w.account.cred);
        }
        if (bad.length) failures.push(`LEDGER ConwayWdrlNotDelegatedToDRep ${bad.join(",")}`);
    }

    // CERTS: withdrawals drain the accounts before the first certificate
    for (const w of tx.withdrawals) v.drain(w.account.cred, w.amount);
    const committeeProposals = [...v.proposals().values()].filter((p) => p.type === 3 || p.type === 4);
    for (const c of tx.certs) {
        if (c.type >= 14 && c.type <= 18) { failures.push(...govCertFailures(c.type, c, pp, v, committeeProposals)); continue; }
        const r = conwayDelegPoolFailures(c, pp, v);
        failures.push(...r.failures); reports.push(...r.reports);
        if (r.effects.unregisterAccount) v.unregisterAccount(r.effects.unregisterAccount);
        if (r.effects.registerAccount) v.registerAccount(r.effects.registerAccount.cred, r.effects.registerAccount.deposit);
        if (r.effects.registerPool) v.registerPool(r.effects.registerPool.pool, r.effects.registerPool.vrf);
        if (c.drep && c.cred && (c.type === 9 || c.type === 10 || c.type === 12 || c.type === 13) && v.accountRegistered(c.cred) !== false) v.delegateVote(c.cred, c.drep);
    }

    // GOV: proposals, then votes (state after the certificates)
    const before = new Map(v.proposals());
    for (const p of tx.proposals) failures.push(...proposalFailures(tx.txId, p, pp, v, before));
    failures.push(...voteFailures(tx, pp, v));
    return { failures, reports };
}

function govCertFailures(type: number, c: { cred?: TypedCred; coin?: bigint; cold?: TypedCred; hot?: TypedCred }, pp: GovRuleParams, v: GovBlockOverlay, committeeProposals: ProposalView[]): string[] {
    const out: string[] = [];
    switch (type) {
        case 16: {
            if (v.drepRegistered(c.cred!) === true) out.push(`GOVCERT ConwayDRepAlreadyRegistered ${c.cred}`);
            if ((c.coin ?? 0n) !== pp.drepDeposit) out.push(`GOVCERT ConwayDRepIncorrectDeposit supplied ${c.coin} expected ${pp.drepDeposit}`);
            v.registerDRep(c.cred!, pp.drepDeposit);
            break;
        }
        case 17: {
            const reg = v.drepRegistered(c.cred!);
            if (reg === false) out.push(`GOVCERT ConwayDRepNotRegistered ${c.cred}`);
            const paid = v.drepDeposit(c.cred!);
            if (reg !== false && paid != null && (c.coin ?? 0n) !== paid) out.push(`GOVCERT ConwayDRepIncorrectRefund supplied ${c.coin} expected ${paid}`);
            v.unregisterDRep(c.cred!);
            break;
        }
        case 18:
            if (v.drepRegistered(c.cred!) === false) out.push(`GOVCERT ConwayDRepNotRegistered ${c.cred}`);
            break;
        case 14: case 15: {
            const cold = c.cold!;
            const st = v.committeeCreds().get(cold);
            if (st?.resigned) out.push(`GOVCERT ConwayCommitteeHasPreviouslyResigned ${cold}`);
            const members = v.committeeMembers();
            const isCurrent = members != null && members.has(cold);
            const isFuture = committeeProposals.some((p) => p.type === 4 && (p.ccAdd ?? []).includes(cold));
            if (!isCurrent && !isFuture) out.push(`GOVCERT ConwayCommitteeIsUnknown ${cold}`);
            v.setCommitteeCred(cold, type === 14 ? { hot: c.hot!, resigned: false } : { hot: null, resigned: true });
            break;
        }
    }
    return out;
}

function proposalFailures(txId: string, p: ProposalModel, pp: GovRuleParams, v: GovBlockOverlay, before: Map<string, ProposalView>): string[] {
    const out: string[] = [];
    const a = p.action, name = GOV_ACTION_NAMES[a.type] ?? String(a.type);
    const bootstrap = pp.protocolMajor === 9;
    const id = `${txId}:${p.index}`;
    if (bootstrap && !isBootstrapAction(a.type)) out.push(`GOV DisallowedProposalDuringBootstrap ${name} ${id}`);
    if (a.type === 1) {
        // `preceedingHardFork` (1.22.1 looks the parent up among the proposals before this transaction)
        const cur = { major: pp.protocolMajor, minor: pp.protocolMinor };
        const s = succVersion(cur.major);
        let prevPv: { major: number; minor: number } | null = null;
        if (a.prev === v.roots().hardfork || s == null || a.major > s) prevPv = cur;
        else if (a.prev) { const parent = before.get(a.prev); if (parent && parent.type === 1) prevPv = { major: parent.major ?? 0, minor: parent.minor ?? 0 }; }
        if (prevPv && !pvCanFollow(prevPv, { major: a.major, minor: a.minor })) out.push(`GOV ProposalCantFollow ${a.prev ?? "-"} supplied ${a.major}.${a.minor} expected successor of ${prevPv.major}.${prevPv.minor}`);
    }
    if (a.type === 0 && !ppuWellFormed({ major: pp.protocolMajor }, a.update)) out.push(`GOV MalformedProposal ${id}`);
    if (!bootstrap) {
        if (v.accountRegistered(p.returnAccount.cred) === false) out.push(`GOV ProposalReturnAccountDoesNotExist ${p.returnAccount.cred}`);
        if (a.type === 2) {
            const missing = a.withdrawals.filter((w) => v.accountRegistered(w.account.cred) === false).map((w) => w.account.cred);
            if (missing.length) out.push(`GOV TreasuryWithdrawalReturnAccountsDoNotExist ${missing.join(",")}`);
        }
    }
    if (p.deposit !== pp.govActionDeposit) out.push(`GOV ProposalDepositIncorrect supplied ${p.deposit} expected ${pp.govActionDeposit}`);
    if (p.returnAccount.network !== pp.networkId) out.push(`GOV ProposalProcedureNetworkIdMismatch ${p.returnAccount.cred} ${p.returnAccount.network}`);
    if (a.type === 2) {
        const wrong = a.withdrawals.filter((w) => w.account.network !== pp.networkId);
        if (wrong.length) out.push(`GOV TreasuryWithdrawalsNetworkIdMismatch ${wrong.map((w) => w.account.cred).join(",")}`);
        if ((a.policy ?? null) !== (v.constitutionScript() ?? null)) out.push(`GOV InvalidGuardrailsScriptHash supplied ${a.policy ?? "-"} expected ${v.constitutionScript() ?? "-"}`);
        if (!bootstrap && a.withdrawals.reduce((s, w) => s + w.amount, 0n) === 0n) out.push(`GOV ZeroTreasuryWithdrawals ${id}`);
    } else if (a.type === 4) {
        const removing = new Set(a.remove);
        const conflicting = a.add.filter((m) => removing.has(m.cred)).map((m) => m.cred);
        if (conflicting.length) out.push(`GOV ConflictingCommitteeUpdate ${conflicting.join(",")}`);
        const early = a.add.filter((m) => m.epoch <= pp.epoch);
        if (early.length) out.push(`GOV ExpirationEpochTooSmall ${early.map((m) => `${m.cred}:${m.epoch}`).join(",")}`);
    } else if (a.type === 0) {
        if ((a.policy ?? null) !== (v.constitutionScript() ?? null)) out.push(`GOV InvalidGuardrailsScriptHash supplied ${a.policy ?? "-"} expected ${v.constitutionScript() ?? "-"}`);
    }
    // `proposalsAddAction`: a chained purpose builds on its enacted root or on a live proposal of the same purpose
    const purpose = purposeOfType(a.type);
    const prev = "prev" in a ? a.prev : null;
    if (purpose) {
        const parent = prev ? v.proposals().get(prev) : null;
        const ok = prev === v.roots()[purpose] || (parent != null && purposeOfType(parent.type) === purpose);
        if (!ok) { out.push(`GOV InvalidPrevGovActionId ${name} ${id} prev ${prev ?? "-"}`); return out; }
    }
    v.addProposal({ id, type: a.type, prev, expiresAfter: pp.epoch + pp.govActionLifetime, ...(a.type === 1 ? { major: a.major, minor: a.minor } : {}), ...(a.type === 4 ? { ccAdd: a.add.map((m) => m.cred) } : {}), ...(a.type === 0 ? { security: updateIsSecurityRelevant(a.update.keys()) } : {}) });
    return out;
}

function voteFailures(tx: GovTxModel, pp: GovRuleParams, v: GovBlockOverlay): string[] {
    const out: string[] = [];
    if (tx.votes.length === 0) return out;
    const bootstrap = pp.protocolMajor === 9;
    const creds = v.committeeCreds();
    const authorized = new Set<TypedCred>(); for (const s of creds.values()) if (!s.resigned) { if (s.hot) authorized.add(s.hot); if (s.hotAlt) authorized.add(s.hotAlt); }
    if (pp.protocolMajor > 10) {
        // `unelectedCommitteeVoters`: hot keys of cold credentials that are members of the enacted committee
        const members = v.committeeMembers();
        const elected = new Set<TypedCred>();
        if (members) for (const [cold, s] of creds) if (members.has(cold) && !s.resigned) { if (s.hot) elected.add(s.hot); if (s.hotAlt) elected.add(s.hotAlt); }
        const unelected = new Set<string>();
        for (const x of tx.votes) if ((x.voterKind === 0 || x.voterKind === 1) && !elected.has(voterCred(x.voterKind, x.voterHash))) unelected.add(voterCred(x.voterKind, x.voterHash));
        if (unelected.size) out.push(`GOV UnelectedCommitteeVoters ${[...unelected].join(",")}`);
    }
    const unknownVoters = new Set<string>(), unknownActions = new Set<string>();
    const boot: string[] = [], expired: string[] = [], disallowed: string[] = [];
    const props = v.proposals();
    for (const x of tx.votes) {
        const cred = voterCred(x.voterKind, x.voterHash);
        const known = x.voterKind <= 1 ? authorized.has(cred) : x.voterKind <= 3 ? v.drepRegistered(cred) !== false : v.poolRegistered(x.voterHash) !== false;
        if (!known) { unknownVoters.add(`${x.voterKind}:${cred}`); continue; }
        const p = props.get(x.actionId);
        if (!p) { unknownActions.add(x.actionId); continue; }
        const tag = `${x.voterKind}:${credHashOf(cred).slice(0, 12)}→${x.actionId.slice(0, 12)}`;
        if (bootstrap) {
            const ok = x.voterKind === 2 || x.voterKind === 3 ? p.type === 6 : isBootstrapAction(p.type);
            if (!ok) boot.push(tag);
        }
        if (pp.epoch > p.expiresAfter) expired.push(tag);
        const allowed = x.voterKind <= 1 ? !(p.type === 3 || p.type === 4) : x.voterKind <= 3 ? true : spoVotingAllowed(p, p.type === 0 && p.security === true);
        if (!allowed) disallowed.push(tag);
    }
    if (unknownVoters.size) out.push(`GOV VotersDoNotExist ${[...unknownVoters].join(",")}`);
    if (unknownActions.size) out.push(`GOV GovActionsDoNotExist ${[...unknownActions].join(",")}`);
    if (boot.length) out.push(`GOV DisallowedVotesDuringBootstrap ${boot.join(",")}`);
    if (expired.length) out.push(`GOV VotingOnExpiredGovAction ${expired.join(",")}`);
    if (disallowed.length) out.push(`GOV DisallowedVoters ${disallowed.join(",")}`);
    return out;
}

/** Whether a ParameterChange update (CBOR keys) touches a security-group parameter (`pvtPPSecurityGroup` applies). */
export function updateIsSecurityRelevant(keys: Iterable<number>): boolean { for (const k of keys) if (SECURITY_KEYS.has(k)) return true; return false; }
