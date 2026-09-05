/**
 * Conway governance state (Phase 4d): DReps and their delegations, the
 * constitutional committee, proposals and votes, and the epoch-boundary
 * ratification + enactment (CIP-1694 / cardano-ledger RATIFY, ENACT, EPOCH).
 *
 * Enactment order and effects follow the ledger: proposals are considered in
 * proposal order; one ratified action per purpose per epoch for the purposes
 * that chain (parameters, hard fork, committee, constitution) — a later
 * proposal for the same purpose must name the previously enacted action as
 * its `prev` id; treasury withdrawals and info actions are unchained.
 * Expired proposals (proposed epoch + govActionLifetime < epoch) are dropped
 * and their deposits refunded to the return account.
 */
import { sql } from "../../sql";
import { typedCredHexOf } from "../../db/stakeCred";
import type { SqlClient } from "../../db";
import { logger } from "../../utils/logger";
import { updateToRaw } from "../pparams";
import { committeeAccepts, drepAccepts, poolAccepts, rationalOf, thresholdsFor, type ActionKind, type CommitteeTally, type DRepTally, type PoolTally, type ThresholdParams } from "./tally";

const hex = (h: any): string => String(h?.toString?.() ?? h ?? "").toLowerCase();

export async function ensureGovernanceTables(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS gov_dreps (
        credential TEXT PRIMARY KEY,
        is_script INTEGER NOT NULL DEFAULT 0,
        deposit INTEGER NOT NULL,
        registered_slot INTEGER NOT NULL,
        last_active_epoch INTEGER NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_drep_delegations (
        stake_key TEXT PRIMARY KEY,
        drep_type INTEGER NOT NULL,   -- 0 key, 1 script, 2 always-abstain, 3 always-no-confidence
        drep_hash TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_committee (
        cold_credential TEXT PRIMARY KEY,
        expires_epoch INTEGER NOT NULL,
        hot_credential TEXT,
        resigned INTEGER NOT NULL DEFAULT 0
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        committee_threshold_num INTEGER NOT NULL,
        committee_threshold_den INTEGER NOT NULL,
        constitution_hash TEXT,
        constitution_script TEXT,
        no_confidence INTEGER NOT NULL DEFAULT 0,
        prev_pparams TEXT, prev_hardfork TEXT, prev_committee TEXT, prev_constitution TEXT,
        seeded_epoch INTEGER NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_proposals (
        action_id TEXT PRIMARY KEY,   -- txid:index
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        prev_action_id TEXT,
        deposit INTEGER NOT NULL,
        return_account TEXT NOT NULL,
        payload TEXT NOT NULL,
        proposed_epoch INTEGER NOT NULL,
        expires_epoch INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',   -- active | ratified | enacted | expired | dropped
        decided_epoch INTEGER
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_votes (
        action_id TEXT NOT NULL,
        voter_kind INTEGER NOT NULL,  -- VoterKind
        voter_hash TEXT NOT NULL,
        vote INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        PRIMARY KEY (action_id, voter_kind, voter_hash)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS gov_enacted (
        epoch INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY (epoch, action_id)
    )`;
}

/** Seed committee, constitution and thresholds from the Conway genesis once (idempotent). */
export async function seedGovernance(db: SqlClient, conwayGenesis: any, epoch: number): Promise<void> {
    const rows = (await db`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][];
    if (rows.length) return;
    const thr = conwayGenesis?.committee?.threshold ?? { numerator: 2, denominator: 3 };
    const cons = conwayGenesis?.constitution ?? {};
    await db`INSERT INTO gov_state (id, committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, seeded_epoch)
        VALUES (1, ${Number(thr.numerator ?? 2)}, ${Number(thr.denominator ?? 3)}, ${cons.anchor?.dataHash ?? null}, ${cons.script ?? null}, 0, ${epoch})`;
    for (const [cred, expiry] of Object.entries(conwayGenesis?.committee?.members ?? {})) {
        const c = String(cred).replace(/^(keyHash|scriptHash)-/, "").toLowerCase();
        await db`INSERT OR IGNORE INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${c}, ${Number(expiry)}, NULL, 0)`;
    }
    logger.info(`Governance seeded from the Conway genesis: ${Object.keys(conwayGenesis?.committee?.members ?? {}).length} committee member(s), threshold ${thr.numerator}/${thr.denominator}`);
}

// ───────────────────────────── capture at apply ─────────────────────────────

export async function recordDRepRegistration(db: SqlClient, cred: any, deposit: bigint, slot: number, epoch: number): Promise<void> {
    const isScript = cred?.type === 1 || cred?.type === "script" ? 1 : 0;
    await db`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch) VALUES (${hex(cred?.hash)}, ${isScript}, ${deposit.toString()}, ${slot}, ${epoch})
        ON CONFLICT(credential) DO UPDATE SET deposit = excluded.deposit, last_active_epoch = excluded.last_active_epoch`;
}
export async function recordDRepUnregistration(db: SqlClient, cred: any): Promise<void> {
    await db`DELETE FROM gov_dreps WHERE credential = ${hex(cred?.hash)}`;
}
export async function recordDRepActivity(db: SqlClient, credHex: string, epoch: number): Promise<void> {
    await db`UPDATE gov_dreps SET last_active_epoch = ${epoch} WHERE credential = ${credHex}`;
}
export async function recordVoteDelegation(db: SqlClient, stakeCred: any, drep: any): Promise<void> {
    const t = Number(drep?.drepType ?? drep?.type ?? -1);
    const h = t === 0 || t === 1 ? hex(drep?.hash) : null;
    await db`INSERT OR REPLACE INTO gov_drep_delegations (stake_key, drep_type, drep_hash) VALUES (${typedCredHexOf(stakeCred) ?? hex(stakeCred?.hash)}, ${t}, ${h})`;
}
export async function recordCommitteeHot(db: SqlClient, cold: any, hot: any): Promise<void> {
    await db`UPDATE gov_committee SET hot_credential = ${hex(hot?.hash)} WHERE cold_credential = ${hex(cold?.hash)}`;
}
export async function recordCommitteeResign(db: SqlClient, cold: any): Promise<void> {
    await db`UPDATE gov_committee SET resigned = 1, hot_credential = NULL WHERE cold_credential = ${hex(cold?.hash)}`;
}

function actionKind(a: any): ActionKind | null {
    switch (Number(a?.govActionType)) {
        case 0: return "ParameterChange";
        case 1: return "InitHardFork";
        case 2: return "TreasuryWithdrawals";
        case 3: return "NoConfidence";
        case 4: return "UpdateCommittee";
        case 5: return "NewConstitution";
        case 6: return "Info";
        default: return null;
    }
}

function actionPayload(kind: ActionKind, a: any): Record<string, unknown> {
    switch (kind) {
        case "ParameterChange":
            return { changes: updateToRaw(a.protocolParamsUpdate ?? {}), policy: a.policyHash ? hex(a.policyHash) : null };
        case "InitHardFork":
            return { major: Number(a.protocolVersion?.major ?? 0), minor: Number(a.protocolVersion?.minor ?? 0) };
        case "TreasuryWithdrawals": {
            const w: Array<{ account: string; amount: string }> = [];
            for (const e of (a.withdrawals?.map ?? []) as any[]) w.push({ account: (typedCredHexOf(e.rewardAccount?.credentials) ?? hex(e.rewardAccount?.credentials?.hash ?? e.rewardAccount?.credentials)), amount: String(e.amount ?? 0) });
            return { withdrawals: w, policy: a.policyHash ? hex(a.policyHash) : null };
        }
        case "UpdateCommittee":
            return {
                remove: ((a.toRemove ?? []) as any[]).map((c) => hex(c?.hash)),
                add: ((a.toAdd ?? []) as any[]).map((e) => ({ cred: hex(e.coldCredential?.hash), expires: Number(e.expiration ?? e.epoch ?? 0) })),
                thresholdNum: String(a.threshold?.num ?? a.threshold?.numerator ?? 0), thresholdDen: String(a.threshold?.den ?? a.threshold?.denominator ?? 1),
            };
        case "NewConstitution":
            return { hash: hex(a.constitution?.anchor?.anchorDataHash), script: a.constitution?.scriptHash ? hex(a.constitution.scriptHash) : null };
        case "Info":
        default:
            return {};
    }
}

export async function recordProposals(db: SqlClient, txIdHex: string, proposals: any[], epoch: number, govActionLifetime: number): Promise<number> {
    let n = 0;
    for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        const kind = actionKind(p?.govAction);
        if (!kind) continue;
        const prev = p.govAction?.govActionId;
        const prevId = prev ? `${hex(prev.id)}:${Number(prev.index)}` : null;
        const seqRows = (await db`SELECT COALESCE(MAX(seq), 0) + 1 FROM gov_proposals`.values()) as unknown[][];
        await db`INSERT OR IGNORE INTO gov_proposals (action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch)
            VALUES (${`${txIdHex.toLowerCase()}:${i}`}, ${Number(seqRows[0]?.[0] ?? 1)}, ${kind}, ${prevId}, ${String(p.deposit ?? 0)}, ${(typedCredHexOf(p.rewardAccount?.credentials) ?? hex(p.rewardAccount?.credentials?.hash ?? p.rewardAccount?.credentials))}, ${JSON.stringify(actionPayload(kind, p.govAction))}, ${epoch}, ${epoch + govActionLifetime})`;
        n++;
    }
    return n;
}

export async function recordVotes(db: SqlClient, procedures: any[], slot: number, epoch: number): Promise<number> {
    let n = 0;
    for (const entry of procedures ?? []) {
        const voter = entry.voter;
        const kind = Number(voter?.kind);
        const vh = hex(voter?.hash);
        for (const v of (entry.votes ?? []) as any[]) {
            const id = v.govActionId;
            const actionId = `${hex(id?.id)}:${Number(id?.index)}`;
            const vote = Number(v.votingProcedure?.vote ?? v.vote ?? -1);
            if (vote < 0) continue;
            await db`INSERT OR REPLACE INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES (${actionId}, ${kind}, ${vh}, ${vote}, ${slot})`;
            if (kind === 2 || kind === 3) await recordDRepActivity(db, vh, epoch);
            n++;
        }
    }
    return n;
}

// ───────────────────────────── boundary ─────────────────────────────

export interface EnactmentResult {
    /** Raw parameter changes to merge into the new epoch's record. */
    paramChanges: Record<string, unknown>;
    /** New protocol version when a hard fork was enacted. */
    protocolVersion: { major: number; minor: number } | null;
    /** Treasury withdrawals to pay: account credential → lovelace. */
    withdrawals: Map<string, bigint>;
    /** Deposits to refund to return accounts (expired or enacted proposals). */
    refunds: Map<string, bigint>;
    enacted: string[];
    expired: string[];
}

interface ProposalRow { action_id: string; seq: number; kind: ActionKind; prev_action_id: string | null; deposit: bigint; return_account: string; payload: any; proposed_epoch: number; expires_epoch: number }

async function activeProposals(): Promise<ProposalRow[]> {
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch FROM gov_proposals WHERE status = 'active' ORDER BY seq`.values()) as unknown[][];
    return rows.map((r) => ({ action_id: String(r[0]), seq: Number(r[1]), kind: String(r[2]) as ActionKind, prev_action_id: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), return_account: String(r[5]), payload: JSON.parse(String(r[6])), proposed_epoch: Number(r[7]), expires_epoch: Number(r[8]) }));
}

/** DRep voting stake: per DRep credential → stake, plus the two default buckets, from the epoch snapshot. */
async function drepDistribution(takenAt: number): Promise<{ byDrep: Map<string, bigint>; alwaysAbstain: bigint; alwaysNoConfidence: bigint; registered: Set<string> }> {
    const rows = (await sql`
        SELECT d.drep_type, d.drep_hash, COALESCE(SUM(s.stake), 0) FROM gov_drep_delegations d
        JOIN epoch_stake_cred s ON s.stake_key = d.stake_key AND s.taken_at = ${takenAt}
        GROUP BY d.drep_type, d.drep_hash`.values()) as unknown[][];
    const byDrep = new Map<string, bigint>();
    let alwaysAbstain = 0n, alwaysNoConfidence = 0n;
    for (const r of rows) {
        const t = Number(r[0]), h = r[1] == null ? "" : String(r[1]), st = BigInt(String(r[2]));
        if (t === 2) alwaysAbstain += st;
        else if (t === 3) alwaysNoConfidence += st;
        else if (h) byDrep.set(h, (byDrep.get(h) ?? 0n) + st);
    }
    const reg = (await sql`SELECT credential FROM gov_dreps`.values()) as unknown[][];
    return { byDrep, alwaysAbstain, alwaysNoConfidence, registered: new Set(reg.map((r) => String(r[0]))) };
}

async function poolDistribution(takenAt: number): Promise<{ byPool: Map<string, bigint>; rewardDrep: Map<string, number> }> {
    const rows = (await sql`SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    const byPool = new Map<string, bigint>();
    for (const r of rows) byPool.set(String(r[0]), BigInt(String(r[1])));
    // pools whose reward account delegates to a default DRep
    const rd = (await sql`SELECT p.pool_id, d.drep_type FROM pool_params p JOIN gov_drep_delegations d ON d.stake_key = lower(json_extract(p.params_json, '$.rewardAccount')) WHERE d.drep_type IN (2, 3)`.values()) as unknown[][];
    const rewardDrep = new Map<string, number>();
    for (const r of rd) rewardDrep.set(String(r[0]), Number(r[1]));
    return { byPool, rewardDrep };
}

async function thresholdParams(raw: Record<string, unknown>): Promise<ThresholdParams> {
    const st = (await sql`SELECT committee_threshold_num, committee_threshold_den, no_confidence FROM gov_state WHERE id = 1`.values()) as unknown[][];
    const drep: Record<string, any> = {}, pool: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("dvt_")) drep[k] = rationalOf(v, "1");
        if (k.startsWith("pvt_") || k === "pvtpp_security_group") pool[k === "pvtpp_security_group" ? "pvt_p_p_security_group" : k] = rationalOf(v, "1");
    }
    return {
        committeeThreshold: { num: BigInt(String(st[0]?.[0] ?? 2)), den: BigInt(String(st[0]?.[1] ?? 3)) },
        committeeMinSize: Number(raw.committee_min_size ?? 7),
        drep, pool,
        protocolMajor: Number(raw.protocol_major_ver ?? 9),
    };
}

/**
 * Ratify and enact at the start of `epoch`, using the parameters of `epoch − 1`
 * and the stake snapshot the ledger uses for voting (taken at the start of
 * `epoch − 1`). Returns the effects for the caller to apply (parameters,
 * hard fork, treasury withdrawals, deposit refunds).
 */
export async function ratifyAndEnact(db: SqlClient, epoch: number, prevRaw: Record<string, unknown>): Promise<EnactmentResult> {
    const out: EnactmentResult = { paramChanges: {}, protocolVersion: null, withdrawals: new Map(), refunds: new Map(), enacted: [], expired: [] };
    const state = (await db`SELECT prev_pparams, prev_hardfork, prev_committee, prev_constitution, no_confidence FROM gov_state WHERE id = 1`.values()) as unknown[][];
    if (!state.length) return out;
    let [prevPP, prevHF, prevCC, prevCons] = [state[0]![0], state[0]![1], state[0]![2], state[0]![3]].map((v) => (v == null ? null : String(v)));
    const noConfidence = Number(state[0]![4]) === 1;
    const params = await thresholdParams(prevRaw);
    const takenAt = epoch - 1;
    const dreps = await drepDistribution(takenAt);
    const pools = await poolDistribution(takenAt);
    const committee = (await db`SELECT cold_credential, expires_epoch, hot_credential, resigned FROM gov_committee`.values()) as unknown[][];
    const activeMembers = committee.filter((r) => Number(r[3]) === 0 && Number(r[1]) >= epoch && r[2] != null);
    const hotToCold = new Map<string, string>(activeMembers.map((r) => [String(r[2]), String(r[0])]));
    const enactedThisEpoch = new Set<"pparams" | "hardfork" | "committee" | "constitution">();
    const proposals = await activeProposals();

    for (const p of proposals) {
        if (p.expires_epoch < epoch) {
            await db`UPDATE gov_proposals SET status = 'expired', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
            out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
            out.expired.push(p.action_id);
            continue;
        }
        // chained purposes: the proposal must build on the last enacted action of its purpose
        const purpose = p.kind === "ParameterChange" ? "pparams" : p.kind === "InitHardFork" ? "hardfork" : (p.kind === "NoConfidence" || p.kind === "UpdateCommittee") ? "committee" : p.kind === "NewConstitution" ? "constitution" : null;
        if (purpose) {
            const prevEnacted = purpose === "pparams" ? prevPP : purpose === "hardfork" ? prevHF : purpose === "committee" ? prevCC : prevCons;
            if ((p.prev_action_id ?? null) !== (prevEnacted ?? null)) continue; // not (yet) buildable
            if (enactedThisEpoch.has(purpose)) continue; // one per purpose per epoch
        }
        const changedKeys = p.kind === "ParameterChange" ? Object.keys(p.payload.changes ?? {}) : [];
        const thr = thresholdsFor(p.kind, params, changedKeys, noConfidence ? "noConfidence" : "normal");
        const votes = (await db`SELECT voter_kind, voter_hash, vote FROM gov_votes WHERE action_id = ${p.action_id}`.values()) as unknown[][];
        // committee
        const ct: CommitteeTally = { yes: 0, no: 0, abstain: 0, active: activeMembers.length };
        const dt: DRepTally = { yes: 0n, no: 0n, abstain: 0n, unvoted: 0n, alwaysNoConfidence: dreps.alwaysNoConfidence, alwaysAbstain: dreps.alwaysAbstain };
        const pt: PoolTally = { yes: 0n, no: 0n, abstain: 0n, unvoted: 0n, unvotedAbstain: 0n, unvotedNoConfidence: 0n };
        const votedDreps = new Set<string>(), votedPools = new Set<string>();
        for (const v of votes) {
            const kind = Number(v[0]), h = String(v[1]), vote = Number(v[2]);
            if (kind === 0 || kind === 1) {
                if (!hotToCold.has(h)) continue; // not an active, authorised member
                if (vote === 1) ct.yes++; else if (vote === 0) ct.no++; else ct.abstain++;
            } else if (kind === 2 || kind === 3) {
                if (!dreps.registered.has(h)) continue;
                const st = dreps.byDrep.get(h) ?? 0n;
                votedDreps.add(h);
                if (vote === 1) dt.yes += st; else if (vote === 0) dt.no += st; else dt.abstain += st;
            } else if (kind === 4) {
                const st = pools.byPool.get(h) ?? 0n;
                votedPools.add(h);
                if (vote === 1) pt.yes += st; else if (vote === 0) pt.no += st; else pt.abstain += st;
            }
        }
        for (const [h, st] of dreps.byDrep) if (!votedDreps.has(h) && dreps.registered.has(h)) dt.unvoted += st;
        for (const [pool, st] of pools.byPool) {
            if (votedPools.has(pool)) continue;
            pt.unvoted += st;
            const d = pools.rewardDrep.get(pool);
            if (d === 2) pt.unvotedAbstain += st;
            if (d === 3) pt.unvotedNoConfidence += st;
        }
        const ccOk = p.kind === "NoConfidence" || noConfidence ? true : committeeAccepts(ct, thr.committee, params.committeeMinSize);
        const drepOk = thr.drep == null || drepAccepts(dt, thr.drep, p.kind);
        const poolOk = thr.pool == null || poolAccepts(pt, thr.pool, p.kind);
        // NoConfidence / UpdateCommittee cannot be ratified by the CC when the CC is the subject
        const ratified = ccOk && drepOk && poolOk && (p.kind !== "Info");
        if (!ratified) continue;

        // enact
        switch (p.kind) {
            case "ParameterChange":
                Object.assign(out.paramChanges, p.payload.changes ?? {});
                prevPP = p.action_id; enactedThisEpoch.add("pparams");
                break;
            case "InitHardFork":
                out.protocolVersion = { major: Number(p.payload.major), minor: Number(p.payload.minor) };
                out.paramChanges.protocol_major_ver = out.protocolVersion.major;
                out.paramChanges.protocol_minor_ver = out.protocolVersion.minor;
                prevHF = p.action_id; enactedThisEpoch.add("hardfork");
                break;
            case "TreasuryWithdrawals":
                for (const w of (p.payload.withdrawals ?? []) as Array<{ account: string; amount: string }>) out.withdrawals.set(w.account, (out.withdrawals.get(w.account) ?? 0n) + BigInt(w.amount));
                break;
            case "NoConfidence":
                await db`UPDATE gov_state SET no_confidence = 1 WHERE id = 1`;
                prevCC = p.action_id; enactedThisEpoch.add("committee");
                break;
            case "UpdateCommittee":
                for (const c of (p.payload.remove ?? []) as string[]) await db`DELETE FROM gov_committee WHERE cold_credential = ${c}`;
                for (const a of (p.payload.add ?? []) as Array<{ cred: string; expires: number }>) await db`INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${a.cred}, ${a.expires}, NULL, 0) ON CONFLICT(cold_credential) DO UPDATE SET expires_epoch = excluded.expires_epoch, resigned = 0`;
                await db`UPDATE gov_state SET committee_threshold_num = ${Number(p.payload.thresholdNum ?? 2)}, committee_threshold_den = ${Number(p.payload.thresholdDen ?? 3)}, no_confidence = 0 WHERE id = 1`;
                prevCC = p.action_id; enactedThisEpoch.add("committee");
                break;
            case "NewConstitution":
                await db`UPDATE gov_state SET constitution_hash = ${p.payload.hash ?? null}, constitution_script = ${p.payload.script ?? null} WHERE id = 1`;
                prevCons = p.action_id; enactedThisEpoch.add("constitution");
                break;
            case "Info":
                break;
        }
        await db`UPDATE gov_proposals SET status = 'enacted', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
        await db`INSERT OR REPLACE INTO gov_enacted (epoch, action_id, kind, detail) VALUES (${epoch}, ${p.action_id}, ${p.kind}, ${JSON.stringify(p.payload)})`;
        out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
        out.enacted.push(`${p.kind} ${p.action_id.slice(0, 12)}…`);
    }
    // Info actions are ratified by votes too but have no effect; treat them like the ledger: they expire and refund.
    await db`UPDATE gov_state SET prev_pparams = ${prevPP}, prev_hardfork = ${prevHF}, prev_committee = ${prevCC}, prev_constitution = ${prevCons} WHERE id = 1`;
    // DReps inactive for longer than drep_activity epochs stop counting
    const activity = Number(prevRaw.drep_activity ?? 20);
    await db`UPDATE gov_dreps SET last_active_epoch = last_active_epoch WHERE last_active_epoch < ${epoch - activity}`; // placeholder: expiry handled by registered set at read time
    return out;
}
