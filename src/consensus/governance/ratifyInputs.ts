/**
 * The inputs of one ratification round (ratify.ts) as the DRep pulser snapshots them when it is set
 * up at the start of `epoch` (cardano-ledger-conway `setFreshDRepPulsingState`):
 *   proposals   the live proposals after this boundary's removals, in submission order, with votes;
 *   committee   the enacted committee and the committee state (hot keys) of the new epoch;
 *   DReps       the DRep stake distribution of the boundary (`computeDRepDistr`) and the registered
 *               DReps with their expiry;
 *   SPOs        the mark snapshot's pool distribution plus the deposits of live proposals whose return
 *               account delegates to a pool of it (`addToPoolDistr`; preview epoch 994: four pools
 *               100 000 ADA above the snapshot on Koios' pool_voting_power_history), and each pool's
 *               default vote from its reward account's DRep delegation;
 *   enact state the enacted roots, this epoch's parameters, the treasury after the boundary.
 */
import { sql } from "../../sql";
import { ledgerGovReads, ledgerStakeReads } from "../../ledger/nodeLedgerStore";
import { readRewardPots } from "../../db/leaderState";
import { typedOf, type TypedCred } from "./govTxDecode";
import { loadCommitteeView, loadDReps, loadLiveProposals, payloadCcAdd, payloadCcRemove, type LiveProposal } from "./govLedgerView";
import type { RatifyInput, RatifyParams, RatifyProposal, Purpose } from "./ratify";
import { rationalOf, type ActionKind } from "./tally";

export function ratifyParamsOf(raw: Record<string, unknown>): RatifyParams {
    const drep: RatifyParams["drep"] = {}, pool: RatifyParams["pool"] = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("dvt_")) drep[k] = rationalOf(v, "1");
        if (k.startsWith("pvt_") || k === "pvtpp_security_group") pool[k === "pvtpp_security_group" ? "pvt_p_p_security_group" : k] = rationalOf(v, "1");
    }
    return {
        protocolMajor: Number(raw.protocol_major_ver ?? 9), protocolMinor: Number(raw.protocol_minor_ver ?? 0),
        committeeMinSize: Number(raw.committee_min_size ?? 0), committeeMaxTermLength: Number(raw.committee_max_term_length ?? Number.MAX_SAFE_INTEGER),
        drep, pool,
    };
}

async function votesOf(actionId: string, untilSlot: number): Promise<Array<[number, string, number]>> {
    const gr = ledgerGovReads();
    if (gr) return gr.votes(actionId, untilSlot).map((v) => [v.voterKind, v.voterHash, v.vote]);
    return ((await sql`SELECT voter_kind, voter_hash, vote FROM gov_votes WHERE action_id = ${actionId} AND slot <= ${untilSlot}`.values()) as unknown[][]).map((r) => [Number(r[0]), String(r[1]), Number(r[2])]);
}

export async function ratifyProposalOf(p: LiveProposal, untilSlot = Number.MAX_SAFE_INTEGER): Promise<RatifyProposal> {
    const out: RatifyProposal = { id: p.id, kind: p.kind as ActionKind, prev: p.prev, expiresAfter: p.expiresEpoch, ccVotes: new Map(), drepVotes: new Map(), spoVotes: new Map() };
    switch (p.kind) {
        case "ParameterChange": out.changes = p.payload?.changes ?? {}; break;
        case "TreasuryWithdrawals": out.withdrawalTotal = ((p.payload?.withdrawals ?? []) as Array<{ amount: string }>).reduce((s, w) => s + BigInt(w.amount), 0n); break;
        case "InitHardFork": out.version = { major: Number(p.payload?.major ?? 0), minor: Number(p.payload?.minor ?? 0) }; break;
        case "UpdateCommittee":
            out.ccRemove = payloadCcRemove(p.payload);
            out.ccAdd = payloadCcAdd(p.payload).map((a) => ({ cred: a.creds[0]!, expires: a.expires }));
            out.ccThreshold = { num: BigInt(String(p.payload?.thresholdNum ?? 0)), den: BigInt(String(p.payload?.thresholdDen ?? 1)) };
            break;
    }
    for (const [kind, h, vote] of await votesOf(p.id, untilSlot)) {
        if (kind === 0 || kind === 1) out.ccVotes.set(typedOf(kind, h), vote);
        else if (kind === 2 || kind === 3) out.drepVotes.set(typedOf(kind - 2, h), vote);
        else if (kind === 4) out.spoVotes.set(h.toLowerCase(), vote);
    }
    return out;
}

/** DRep distribution of boundary `takenAt`: typed credential / "abstain" / "noconfidence" → stake. */
export async function drepDistributionAt(takenAt: number): Promise<Map<string, bigint>> {
    const gr = ledgerGovReads();
    const rows: Array<[number, string, bigint]> = gr
        ? gr.drepStake(takenAt).map((r) => [r.type, r.hash, r.stake])
        : ((await sql`SELECT drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][]).map((r) => [Number(r[0]), r[1] == null ? "" : String(r[1]), BigInt(String(r[2]))]);
    const out = new Map<string, bigint>();
    for (const [t, h, st] of rows) {
        const k = t === 2 ? "abstain" : t === 3 ? "noconfidence" : typedOf(t, h);
        out.set(k, (out.get(k) ?? 0n) + st);
    }
    return out;
}

/** Pool distribution of the mark snapshot taken at `takenAt`. */
async function poolSnapshot(takenAt: number): Promise<Map<string, bigint>> {
    const sr = ledgerStakeReads();
    if (sr) return sr.snapshotPoolStake(takenAt);
    const out = new Map<string, bigint>();
    for (const r of (await sql`SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][]) out.set(String(r[0]), BigInt(String(r[1])));
    return out;
}

/** Pools whose delegators' stake summed to zero in the snapshot (stakeStore `snap_pool_zero`; SQLite keeps none). */
async function zeroStakePools(takenAt: number): Promise<string[]> {
    const sr = ledgerStakeReads();
    return sr ? sr.snapshotZeroPools(takenAt) : [];
}

async function poolOfAccount(typed: string): Promise<string | null> {
    const sr = ledgerStakeReads();
    if (sr) return sr.delegationOf(typed);
    const script = typed.length === 58, hash = script ? typed.slice(2) : typed;
    const r = (await sql`SELECT pool_key_hash FROM delegations WHERE stake_credentials = ${Uint8Array.from(Buffer.from(hash, "hex"))} AND (cred_type IS NULL OR cred_type = ${script ? 1 : 0})`.values()) as unknown[][];
    const v = r[0]?.[0];
    if (v == null) return null;
    return typeof v === "string" ? v.toLowerCase() : Buffer.from(v as Uint8Array).toString("hex");
}

/** Pools whose reward account delegates to AlwaysAbstain / AlwaysNoConfidence (`defaultStakePoolVote`), among the registered pools. */
async function poolDefaults(pools: Iterable<string>): Promise<Map<string, "abstain" | "noconfidence">> {
    const out = new Map<string, "abstain" | "noconfidence">();
    const gr = ledgerGovReads(), sr = ledgerStakeReads();
    if (gr && sr) {
        for (const id of pools) {
            const p = sr.pool(id);
            const ra = p?.params?.rewardAccount ? String(p.params.rewardAccount).toLowerCase() : null;
            const d = ra ? gr.drepDelegation(ra) : null;
            if (d?.type === 2) out.set(id, "abstain"); else if (d?.type === 3) out.set(id, "noconfidence");
        }
        return out;
    }
    const rows = (await sql`SELECT p.pool_id, d.drep_type FROM pool_params p JOIN gov_drep_delegations d ON d.stake_key = lower(json_extract(p.params_json, '$.rewardAccount')) WHERE d.drep_type IN (2, 3)`.values()) as unknown[][];
    for (const r of rows) out.set(String(r[0]), Number(r[1]) === 2 ? "abstain" : "noconfidence");
    return out;
}

export interface GatherOptions {
    /** Stake snapshot epoch (default `epoch`). */
    takenAt?: number;
    /** Only votes cast up to this slot (diagnostics). */
    votesUntilSlot?: number;
    /** Treasury override (the replay supplies the chain's). */
    treasury?: bigint;
    /** DRep / pool distribution overrides (the replay can supply Koios' to isolate the rule). */
    drepDistr?: Map<string, bigint>;
    poolDistr?: Map<string, bigint>;
}

/** Everything `ratifyRound` needs for the pulser of `epoch`, from the store as it is now (call after the boundary's enactment). */
export async function gatherRatifyInput(epoch: number, raw: Record<string, unknown>, roots: Record<Purpose, string | null>, opts: GatherOptions = {}): Promise<RatifyInput> {
    const takenAt = opts.takenAt ?? epoch;
    const params = ratifyParamsOf(raw);
    const live = (await loadLiveProposals()).filter((p) => p.status === "active");
    const proposals: RatifyProposal[] = [];
    for (const p of live) proposals.push(await ratifyProposalOf(p, opts.votesUntilSlot));
    const cv = await loadCommitteeView();
    const activity = Number(raw.drep_activity ?? 20);
    const drepExpiry = new Map<TypedCred, number>();
    for (const [c, d] of await loadDReps()) drepExpiry.set(c, d.expiry ?? d.lastActive + activity);
    const drepDistr = opts.drepDistr ?? (await drepDistributionAt(takenAt));
    let poolDistr = opts.poolDistr;
    if (!poolDistr) {
        poolDistr = new Map(await poolSnapshot(takenAt));
        // `calculatePoolDistr` lists every pool a snapshot credential delegates to, at 0 when its
        // delegators hold nothing (bug 247); a deposit may land on such a pool
        for (const id of await zeroStakePools(takenAt)) if (!poolDistr.has(id)) poolDistr.set(id, 0n);
        const deposits = new Map<string, bigint>();
        for (const p of live) deposits.set(p.returnAccount, (deposits.get(p.returnAccount) ?? 0n) + p.deposit);
        for (const [acct, dep] of deposits) {
            const pool = await poolOfAccount(acct);
            if (pool && poolDistr.has(pool)) poolDistr.set(pool, poolDistr.get(pool)! + dep);
        }
    }
    const poolDefault = await poolDefaults(poolDistr.keys());
    const treasury = opts.treasury ?? (await readRewardPots().catch(() => null))?.treasury ?? 0n;
    return {
        epoch, params,
        committee: cv.rowMembers ? { members: cv.rowMembers, threshold: cv.threshold } : null,
        committeeCreds: cv.rowCreds,
        proposals, drepDistr, drepExpiry, poolDistr, poolDefault, roots, treasury,
    };
}
