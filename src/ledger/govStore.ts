/**
 * Governance, protocol parameters and nonces over the LedgerStore (docs/PLAN_LMDB_LEDGER.md phase 3).
 * Rows mirror the SQLite tables of consensus/governance/state.ts, consensus/epochParams.ts,
 * consensus/pparams.ts and the nonce columns of db.ts, keyed by their natural keys:
 *   gov_dreps        typedCred (28 key / 0x01 ‖ 28 script; rows from before bug 153 by the bare hash, `isScript` decides) → JSON DRepRow
 *   gov_drep_deleg   typedStakeCred → JSON { type, hash }          (0 key, 1 script, 2 abstain, 3 no-confidence)
 *   gov_committee    cold (0x00/0x01 ‖ 28; 28 bytes = untyped row from before bug 153) → JSON { expiresEpoch, hot, resigned }
 *   gov_cc_auth      cold (as gov_committee) → JSON { hot, resigned }  (hot in the same typed form)
 *   gov_state        "state" → JSON GovStateRow
 *   gov_proposals    txid(32) ‖ u32 index → JSON ProposalRow (status, decidedEpoch, seq included)
 *   gov_votes        txid ‖ u32 index ‖ u8 voterKind ‖ voterHash → JSON { vote, slot }
 *   gov_enacted      u32 epoch ‖ txid ‖ u32 index → JSON { kind, detail }
 *   drep_stake       u32 takenAt ‖ u8 type ‖ hash → u64 stake
 *   epoch_params     u32 epoch → JSON { params, source }
 *   pparam_props     u32 epoch ‖ genesisKey(28) → JSON { changes, slot }
 *   nonces           u32 epoch → JSON NonceRow
 *   gov_drep_boot    u8 type ‖ drepHash(28) ‖ typedStakeCred → empty   protocol-9 reverse delegations (`drepDelegs`, bug 165)
 *   gov_pulser       u32 epoch ‖ u8 part → the DRep pulser's frozen snapshot of the epoch (bug 167): part 0 JSON
 *                    (meta + proposals with their vote maps), 1 JSON DRep distribution, 2 binary DRep states, 3 JSON pool distribution
 */
import { readU64, u64 } from "./LedgerDiff";
import type { LedgerStore, LedgerView } from "./LedgerStore";
import { SDB, StakeReads, cat, hexKey, keyHex, u32 } from "./stakeStore";
import { DB_STAKE_BAL } from "./utxoStore";

export const GDB = {
    dreps: "gov_dreps", drepDeleg: "gov_drep_deleg", committee: "gov_committee", ccAuth: "gov_cc_auth", state: "gov_state", proposals: "gov_proposals",
    votes: "gov_votes", enacted: "gov_enacted", drepStake: "drep_stake", epochParams: "epoch_params", pparamProps: "pparam_props", nonces: "nonces",
    /** NewConstitution proposals' anchors by action id, and the anchor of the constitution in force (key "current"). */
    constitutionAnchors: "gov_constitution_anchor",
    /** Protocol-9 reverse delegations: the DRep's `drepDelegs` set, which the bootstrap phase kept stale (bug 165). */
    drepBoot: "gov_drep_boot",
    /** The pulser snapshot per epoch (`PulsingSnapshot`: proposals with votes, DRep distribution and states, pool distribution), frozen at the boundary. */
    pulser: "gov_pulser",
} as const;

/** What the ledger's DRep pulser froze at the start of an epoch (`psProposals`, `psDRepDistr`, `psDRepState`, `psPoolDistr`). Credentials typed (hash / "01" + hash). */
export interface PulserSnapshot {
    epoch: number;
    /** The last block before the epoch — the state the pulser copied — for facts as of then (anchors); null when unknown. */
    boundary: { slot: number; hash: string } | null;
    /** Live proposals in submission order with their vote maps: committee by typed hot credential, DReps by typed credential, pools by key hash; votes 0 No, 1 Yes, 2 Abstain. */
    proposals: Array<{ actionId: string; cc: Array<[string, number]>; drep: Array<[string, number]>; spo: Array<[string, number]> }>;
    /** DRep → stake: type 0 key, 1 script (hash), 2 always-abstain, 3 always-no-confidence (hash ""), zero entries included. */
    drepDistr: Array<{ type: number; hash: string; stake: string }>;
    /** Registered DReps with the raw stored expiry, deposit and delegator set as of the boundary. */
    drepStates: Array<{ cred: string; expiry: number; deposit: string; delegators: string[] }>;
    poolDistr: Array<[string, string]>;
    /** "boundary": written by the boundary; "backfill": reconstructed on restart (bug 167), "-exact" from the store's history, "-approx" with today's DRep states. */
    source: "boundary" | "backfill-exact" | "backfill-approx";
    /** 2: the pool distribution lists the snapshot's zero-stake pools with delegators (bug 247); absent / 1: written without them. */
    version?: number;
}
const pulserKey = (epoch: number, part: number) => cat(u32(epoch), Uint8Array.of(part));
const typedToBytes = (typed: string): Uint8Array => cat(Uint8Array.of(typed.length === 58 ? 1 : 0), hexKey(typed.length === 58 ? typed.slice(2) : typed));
const bytesToTyped = (b: Uint8Array, o: number): string => (b[o] === 1 ? "01" : "") + keyHex(b.subarray(o + 1, o + 29));
function encodeDRepStates(states: PulserSnapshot["drepStates"]): Uint8Array {
    let n = 0; for (const s of states) n += 29 + 4 + 8 + 4 + 29 * s.delegators.length;
    const out = new Uint8Array(n), dv = new DataView(out.buffer);
    let p = 0;
    for (const s of states) {
        out.set(typedToBytes(s.cred), p); p += 29;
        dv.setUint32(p, s.expiry, false); p += 4;
        dv.setBigUint64(p, BigInt(s.deposit), false); p += 8;
        dv.setUint32(p, s.delegators.length, false); p += 4;
        for (const d of s.delegators) { out.set(typedToBytes(d), p); p += 29; }
    }
    return out;
}
function decodeDRepStates(b: Uint8Array): PulserSnapshot["drepStates"] {
    const out: PulserSnapshot["drepStates"] = [], dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let p = 0; p < b.length;) {
        const cred = bytesToTyped(b, p); p += 29;
        const expiry = dv.getUint32(p, false); p += 4;
        const deposit = dv.getBigUint64(p, false).toString(); p += 8;
        const n = dv.getUint32(p, false); p += 4;
        const delegators: string[] = [];
        for (let i = 0; i < n; i++) { delegators.push(bytesToTyped(b, p)); p += 29; }
        out.push({ cred, expiry, deposit, delegators });
    }
    return out;
}
export interface AnchorRow { url: string; hash: string }
const CURRENT_CONSTITUTION = new TextEncoder().encode("current");

export interface DRepRow { isScript: number; deposit: string; registeredSlot: number; lastActiveEpoch: number; expiryEpoch: number | null }
export interface DRepDelegRow { type: number; hash: string | null }
export interface CommitteeRow { expiresEpoch: number; hot: string | null; resigned: number }
export interface CcAuthRow { hot: string | null; resigned: number }
export interface GovStateRow { thrNum: number; thrDen: number; constitutionHash: string | null; constitutionScript: string | null; noConfidence: number; prevPP: string | null; prevHF: string | null; prevCC: string | null; prevCons: string | null; seededEpoch: number; dormantEpochs: number; pending: string | null; /** 1 once the credential-typing migration ran (bug 153; SQLite keeps it in schema_migrations). */ credSchema?: number }
export interface ProposalRow { actionId: string; seq: number; kind: string; prevActionId: string | null; deposit: string; returnAccount: string; payload: string; proposedEpoch: number; expiresEpoch: number; status: string; decidedEpoch: number | null }
export interface VoteRow { actionId: string; voterKind: number; voterHash: string; vote: number; slot: number }
export interface NonceRow { nonceHex: string; source: string; evolvingHex: string | null; candidateHex: string | null; startEvolvingHex: string | null; startCandidateHex: string | null; startSlot: number | null; startLabHex: string | null }

const enc = new TextEncoder(), dec = new TextDecoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));
const unjson = <T>(b: Uint8Array | undefined): T | null => (b ? (JSON.parse(dec.decode(b)) as T) : null);
const STATE_KEY = enc.encode("state");
const EMPTY = new Uint8Array(0);
export function actionKey(actionId: string): Uint8Array { const i = actionId.indexOf(":"); return cat(hexKey(actionId.slice(0, i)), u32(Number(actionId.slice(i + 1)))); }
export function keyAction(k: Uint8Array): string { return `${keyHex(k.subarray(0, 32))}:${new DataView(k.buffer, k.byteOffset).getUint32(32, false)}`; }
const voteKey = (actionId: string, kind: number, voterHash: string) => cat(actionKey(actionId), Uint8Array.of(kind), hexKey(voterHash));
const drepStakeKey = (takenAt: number, type: number, hash: string) => cat(u32(takenAt), Uint8Array.of(type), hash ? hexKey(hash) : EMPTY);
/** 29-byte DRep prefix (type ‖ hash) of a typed DRep credential. */
const drepPrefix = (typed: string) => cat(Uint8Array.of(typed.length === 58 ? 1 : 0), hexKey(typed.length === 58 ? typed.slice(2) : typed));

export class GovReads {
    constructor(private readonly s: LedgerStore | LedgerView) {}

    drep(cred: string): DRepRow | null { return unjson<DRepRow>(this.s.get(GDB.dreps, hexKey(cred))); }
    dreps(): Map<string, DRepRow> { const out = new Map<string, DRepRow>(); for (const [k, v] of this.s.range(GDB.dreps, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    /** Registered DReps whose expiry (or legacy last activity + drepActivity) reaches `currentEpoch`. */
    activeDRepCredentials(currentEpoch: number, drepActivity: number): Set<string> {
        const out = new Set<string>();
        // typed credentials (bug 153): a bare-hash row of a script DRep reads as "01" + hash
        for (const [c, d] of this.dreps()) if ((d.expiryEpoch ?? d.lastActiveEpoch + drepActivity) >= currentEpoch) out.add(c.length === 56 && d.isScript ? `01${c}` : c);
        return out;
    }
    /** Stake credentials in a DRep's protocol-9 reverse delegation set. */
    bootDelegators(drepTyped: string): string[] { const out: string[] = []; for (const [k] of this.s.range(GDB.drepBoot, drepPrefix(drepTyped))) out.push(keyHex(k.subarray(29))); return out; }
    drepDelegation(stakeKey: string): DRepDelegRow | null { return unjson<DRepDelegRow>(this.s.get(GDB.drepDeleg, hexKey(stakeKey))); }
    drepDelegations(): Map<string, DRepDelegRow> { const out = new Map<string, DRepDelegRow>(); for (const [k, v] of this.s.range(GDB.drepDeleg, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    committee(): Map<string, CommitteeRow> { const out = new Map<string, CommitteeRow>(); for (const [k, v] of this.s.range(GDB.committee, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    committeeAuth(cold: string): CcAuthRow | null { return unjson<CcAuthRow>(this.s.get(GDB.ccAuth, hexKey(cold))); }
    committeeAuths(): Map<string, CcAuthRow> { const out = new Map<string, CcAuthRow>(); for (const [k, v] of this.s.range(GDB.ccAuth, EMPTY)) out.set(keyHex(k), JSON.parse(dec.decode(v))); return out; }
    /** Members with the authorisation table folded in, as the SQL LEFT JOIN does: [cold, expires, hot, resigned]. */
    committeeWithAuth(): Array<[string, number, string | null, number]> {
        const auth = this.committeeAuths();
        const out: Array<[string, number, string | null, number]> = [];
        for (const [cold, c] of this.committee()) { const a = auth.get(cold); out.push([cold, c.expiresEpoch, a ? a.hot : c.hot, a ? a.resigned : c.resigned]); }
        return out;
    }
    state(): GovStateRow | null { return unjson<GovStateRow>(this.s.get(GDB.state, STATE_KEY)); }
    constitutionAnchor(): AnchorRow | null { return unjson<AnchorRow>(this.s.get(GDB.constitutionAnchors, CURRENT_CONSTITUTION)); }
    constitutionProposalAnchor(actionId: string): AnchorRow | null { return unjson<AnchorRow>(this.s.get(GDB.constitutionAnchors, actionKey(actionId))); }
    proposal(actionId: string): ProposalRow | null { return unjson<ProposalRow>(this.s.get(GDB.proposals, actionKey(actionId))); }
    proposals(status?: string | string[]): ProposalRow[] {
        const want = status == null ? null : new Set(Array.isArray(status) ? status : [status]);
        const out: ProposalRow[] = [];
        for (const [, v] of this.s.range(GDB.proposals, EMPTY)) { const p = JSON.parse(dec.decode(v)) as ProposalRow; if (!want || want.has(p.status)) out.push(p); }
        return out.sort((a, b) => a.seq - b.seq);
    }
    maxSeq(): number { let m = 0; for (const [, v] of this.s.range(GDB.proposals, EMPTY)) m = Math.max(m, (JSON.parse(dec.decode(v)) as ProposalRow).seq); return m; }
    votes(actionId: string, untilSlot = Number.MAX_SAFE_INTEGER): VoteRow[] {
        const out: VoteRow[] = [];
        for (const [k, v] of this.s.range(GDB.votes, actionKey(actionId))) {
            const r = JSON.parse(dec.decode(v)) as { vote: number; slot: number };
            if (r.slot > untilSlot) continue;
            out.push({ actionId, voterKind: k[36]!, voterHash: keyHex(k.subarray(37)), vote: r.vote, slot: r.slot });
        }
        return out;
    }
    enactedAt(epoch: number): Array<{ actionId: string; kind: string; detail: string | null }> {
        const out: Array<{ actionId: string; kind: string; detail: string | null }> = [];
        for (const [k, v] of this.s.range(GDB.enacted, u32(epoch))) { const r = JSON.parse(dec.decode(v)) as { kind: string; detail: string | null }; out.push({ actionId: keyAction(k.subarray(4)), ...r }); }
        return out;
    }
    drepStake(takenAt: number): Array<{ type: number; hash: string; stake: bigint }> {
        const out: Array<{ type: number; hash: string; stake: bigint }> = [];
        for (const [k, v] of this.s.range(GDB.drepStake, u32(takenAt))) out.push({ type: k[4]!, hash: keyHex(k.subarray(5)), stake: readU64(v) });
        return out;
    }
    /** The frozen pulser snapshot of `epoch` (bug 167), or null when the boundary ran before it was kept and no backfill wrote it. */
    pulserSnapshot(epoch: number): PulserSnapshot | null {
        const meta = unjson<Omit<PulserSnapshot, "drepDistr" | "drepStates" | "poolDistr">>(this.s.get(GDB.pulser, pulserKey(epoch, 0)));
        if (!meta) return null;
        return { ...meta, drepDistr: unjson<PulserSnapshot["drepDistr"]>(this.s.get(GDB.pulser, pulserKey(epoch, 1))) ?? [], drepStates: decodeDRepStates(this.s.get(GDB.pulser, pulserKey(epoch, 2)) ?? EMPTY), poolDistr: unjson<PulserSnapshot["poolDistr"]>(this.s.get(GDB.pulser, pulserKey(epoch, 3))) ?? [] };
    }
    pulserEpochs(): number[] { const out = new Set<number>(); for (const [k] of this.s.range(GDB.pulser, EMPTY)) out.add(new DataView(k.buffer, k.byteOffset).getUint32(0, false)); return [...out].sort((a, b) => a - b); }
    epochParams(epoch: number): { params: Record<string, unknown>; source: string | null } | null { return unjson(this.s.get(GDB.epochParams, u32(epoch))); }
    epochParamEpochs(): number[] { const out: number[] = []; for (const [k] of this.s.range(GDB.epochParams, EMPTY)) out.push(new DataView(k.buffer, k.byteOffset).getUint32(0, false)); return out; }
    pparamProposals(epoch: number): Array<{ genesisKey: string; changes: string; slot: number }> {
        const out: Array<{ genesisKey: string; changes: string; slot: number }> = [];
        for (const [k, v] of this.s.range(GDB.pparamProps, u32(epoch))) { const r = JSON.parse(dec.decode(v)) as { changes: string; slot: number }; out.push({ genesisKey: keyHex(k.subarray(4)), ...r }); }
        return out;
    }
    nonce(epoch: number): NonceRow | null { return unjson<NonceRow>(this.s.get(GDB.nonces, u32(epoch))); }
    nonceEpochs(): number[] { const out: number[] = []; for (const [k] of this.s.range(GDB.nonces, EMPTY)) out.push(new DataView(k.buffer, k.byteOffset).getUint32(0, false)); return out; }
}

export class GovWrites {
    readonly reads: GovReads;
    private readonly stake: StakeReads;
    constructor(private readonly s: LedgerStore) { this.reads = new GovReads(s); this.stake = new StakeReads(s); }

    putDRep(cred: string, r: DRepRow): void { this.s.put(GDB.dreps, hexKey(cred), json(r)); }
    delDRep(cred: string): void { this.s.del(GDB.dreps, hexKey(cred)); }
    addBootDelegator(drepTyped: string, stakeKey: string): void { this.s.put(GDB.drepBoot, cat(drepPrefix(drepTyped), hexKey(stakeKey)), Uint8Array.of(1)); }
    delBootDelegator(drepTyped: string, stakeKey: string): void { const k = cat(drepPrefix(drepTyped), hexKey(stakeKey)); if (this.s.get(GDB.drepBoot, k) !== undefined) this.s.del(GDB.drepBoot, k); }
    clearBootDelegators(drepTyped: string): number { const ks = this.reads.bootDelegators(drepTyped); for (const k of ks) this.delBootDelegator(drepTyped, k); return ks.length; }
    /** Every stored reverse delegation (the protocol-10 hard fork discards them). */
    allBootDelegations(): Array<[string, string]> { const out: Array<[string, string]> = []; for (const [k] of this.s.range(GDB.drepBoot, EMPTY)) out.push([(k[0] === 1 ? "01" : "") + keyHex(k.subarray(1, 29)), keyHex(k.subarray(29))]); return out; }
    putDRepDelegation(stakeKey: string, r: DRepDelegRow): void { this.s.put(GDB.drepDeleg, hexKey(stakeKey), json(r)); }
    delDRepDelegation(stakeKey: string): void { this.s.del(GDB.drepDeleg, hexKey(stakeKey)); }
    /** A DRep's unregistration clears every delegation to it. */
    clearDelegationsTo(type: number, hash: string): number { let n = 0; for (const [k, d] of this.reads.drepDelegations()) if (d.type === type && d.hash === hash) { this.delDRepDelegation(k); n++; } return n; }
    putCommittee(cold: string, r: CommitteeRow): void { this.s.put(GDB.committee, hexKey(cold), json(r)); }
    delCommittee(cold: string): void { this.s.del(GDB.committee, hexKey(cold)); }
    putCommitteeAuth(cold: string, r: CcAuthRow): void { this.s.put(GDB.ccAuth, hexKey(cold), json(r)); }
    delCommitteeAuth(cold: string): void { this.s.del(GDB.ccAuth, hexKey(cold)); }
    putState(r: GovStateRow): void { this.s.put(GDB.state, STATE_KEY, json(r)); }
    putConstitutionAnchor(a: AnchorRow): void { this.s.put(GDB.constitutionAnchors, CURRENT_CONSTITUTION, json(a)); }
    putConstitutionProposalAnchor(actionId: string, a: AnchorRow): void { this.s.put(GDB.constitutionAnchors, actionKey(actionId), json(a)); }
    updateState(patch: Partial<GovStateRow>): void { const cur = this.reads.state(); if (cur) this.putState({ ...cur, ...patch }); }
    putProposal(r: ProposalRow): void { this.s.put(GDB.proposals, actionKey(r.actionId), json(r)); }
    updateProposal(actionId: string, patch: Partial<ProposalRow>): void { const cur = this.reads.proposal(actionId); if (cur) this.putProposal({ ...cur, ...patch }); }
    putVote(v: VoteRow): void { this.s.put(GDB.votes, voteKey(v.actionId, v.voterKind, v.voterHash), json({ vote: v.vote, slot: v.slot })); }
    delVote(actionId: string, voterKind: number, voterHash: string): void { const k = voteKey(actionId, voterKind, voterHash); if (this.s.get(GDB.votes, k) !== undefined) this.s.del(GDB.votes, k); }
    putEnacted(epoch: number, actionId: string, kind: string, detail: string | null): void { this.s.put(GDB.enacted, cat(u32(epoch), actionKey(actionId)), json({ kind, detail })); }
    putDRepStake(takenAt: number, type: number, hash: string, stake: bigint): void { this.s.put(GDB.drepStake, drepStakeKey(takenAt, type, hash), u64(stake)); }
    /**
     * The DRep stake distribution at boundary `takenAt` (Conway mkStakeDistrs): every vote-delegated
     * credential's UTxO balance + reward balance, plus live proposal deposits at their return
     * accounts, aggregated by DRep. Idempotent per `takenAt`. Returns the number of DReps written.
     */
    takeDRepStakeSnapshot(takenAt: number): number {
        if (this.reads.drepStake(takenAt).length) return 0;
        const deposits = new Map<string, bigint>();
        for (const p of this.reads.proposals(["active", "ratified"])) deposits.set(p.returnAccount, (deposits.get(p.returnAccount) ?? 0n) + BigInt(p.deposit));
        const sums = new Map<string, { type: number; hash: string; stake: bigint }>();
        for (const [stakeKey, d] of this.reads.drepDelegations()) {
            const amount = this.s.getU64(DB_STAKE_BAL, hexKey(stakeKey)) + this.s.getU64(SDB.reward, hexKey(stakeKey)) + (deposits.get(stakeKey) ?? 0n);
            if (amount === 0n) continue; // SQL: only credentials with a balance, reward or deposit row join
            const hash = d.hash ?? "", key = `${d.type}:${hash}`;
            const cur = sums.get(key);
            if (cur) cur.stake += amount; else sums.set(key, { type: d.type, hash, stake: amount });
        }
        for (const v of sums.values()) this.putDRepStake(takenAt, v.type, v.hash, v.stake);
        return sums.size;
    }
    oldestDRepStakeEpoch(): number | null { const k = this.s.firstStoredKey(GDB.drepStake); return k && k.length >= 4 ? new DataView(k.buffer, k.byteOffset).getUint32(0, false) : null; }
    pruneDRepStakeEpoch(epoch: number): number { let n = 0; for (const k of this.s.storedKeys(GDB.drepStake, u32(epoch))) { this.s.del(GDB.drepStake, k); n++; } return n; }
    putPulserSnapshot(snap: PulserSnapshot): void {
        const { drepDistr, drepStates, poolDistr, ...meta } = snap;
        this.s.put(GDB.pulser, pulserKey(snap.epoch, 0), json(meta));
        this.s.put(GDB.pulser, pulserKey(snap.epoch, 1), json(drepDistr));
        this.s.put(GDB.pulser, pulserKey(snap.epoch, 2), encodeDRepStates(drepStates));
        this.s.put(GDB.pulser, pulserKey(snap.epoch, 3), json(poolDistr));
    }
    delPulserSnapshot(epoch: number): void { for (let part = 0; part < 4; part++) { const k = pulserKey(epoch, part); if (this.s.get(GDB.pulser, k) !== undefined) this.s.del(GDB.pulser, k); } }
    putEpochParams(epoch: number, params: Record<string, unknown>, source: string | null): void { this.s.put(GDB.epochParams, u32(epoch), json({ params, source })); }
    putPParamProposal(epoch: number, genesisKey: string, changes: string, slot: number): void { this.s.put(GDB.pparamProps, cat(u32(epoch), hexKey(genesisKey)), json({ changes, slot })); }
    putNonce(epoch: number, r: NonceRow): void { this.s.put(GDB.nonces, u32(epoch), json(r)); }
    updateNonce(epoch: number, patch: Partial<NonceRow>): void { const cur = this.reads.nonce(epoch); if (cur) this.putNonce(epoch, { ...cur, ...patch }); }
}
