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
import { rewardAccountTypedHex, typedCredHexOf } from "../../db/stakeCred";
import type { SqlClient } from "../../db";
import { logger } from "../../utils/logger";
import { updateToRaw } from "../pparams";
import { readEpochParamsRaw } from "../epochParams";
import { paramChangesOfProposal, type RawCostModels } from "./costModelUpdate";
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
    // Bug 102: the ledger materialises a DRep's expiry when it registers, updates or votes
    // (current epoch + the drep_activity in force then, minus the dormant epochs so far);
    // NULL on rows from before the column existed → the legacy last_active + activity rule.
    try { await sql`ALTER TABLE gov_dreps ADD COLUMN expiry_epoch INTEGER`; } catch { /* exists */ }
    await sql`CREATE TABLE IF NOT EXISTS gov_drep_delegations (
        stake_key TEXT PRIMARY KEY,
        drep_type INTEGER NOT NULL,   -- 0 key, 1 script, 2 always-abstain, 3 always-no-confidence
        drep_hash TEXT
    )`;
    // DRep stake distribution per boundary (bug 90): every vote-delegated credential's balance and
    // reward account plus the deposits of live governance actions (return address), whether or not
    // the credential delegates to a pool. Small (one row per DRep) and never pruned, so tallies
    // stay reproducible offline (`scripts/gov-tally.ts`).
    await sql`CREATE TABLE IF NOT EXISTS epoch_drep_stake (
        taken_at INTEGER NOT NULL,
        drep_type INTEGER NOT NULL,   -- as gov_drep_delegations
        drep_hash TEXT NOT NULL DEFAULT '',
        stake TEXT NOT NULL,
        PRIMARY KEY (taken_at, drep_type, drep_hash)
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
    // Epochs without any active proposal do not age DReps (cardano-ledger numDormantEpochs):
    // the count is added to every DRep's activity when the next proposal arrives.
    try { await sql`ALTER TABLE gov_state ADD COLUMN dormant_epochs INTEGER NOT NULL DEFAULT 0`; } catch { /* exists */ }
    try { await sql`ALTER TABLE gov_state ADD COLUMN pending TEXT`; } catch { /* exists */ }
    // Hot-key authorisations live apart from membership: a cold key may authorise its hot key
    // before the committee update that adds it is enacted (bug 83).
    await sql`CREATE TABLE IF NOT EXISTS gov_committee_auth (
        cold_credential TEXT PRIMARY KEY,
        hot_credential TEXT,
        resigned INTEGER NOT NULL DEFAULT 0
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

/**
 * The expiry the ledger stores for a DRep that registers (`registration`) or is refreshed by an
 * update certificate or a vote, from the parameters in force in `epoch` (cardano-ledger GOVCERT
 * `computeDRepExpiryVersioned` / CERTS `updateVotingDRepExpiries`): epoch + drepActivity −
 * numDormantEpochs, the dormant epochs being added back when the next proposal arrives; in the
 * bootstrap phase (protocol 9) a registration does not subtract them.
 * Bug 102: the expiry was derived at tally time from the *current* drep_activity, so a change of
 * that parameter (preview epoch 964: 20 → 31) moved every existing DRep's expiry, where the chain
 * keeps the value fixed at the last activity (5 099 of preview's 8 984 DReps at epoch 1415 carry
 * the old 20-epoch expiry; found by the snapshot decoder).
 */
export async function drepExpiryFor(db: SqlClient, epoch: number, registration: boolean): Promise<number> {
    const raw = (await readEpochParamsRaw(epoch)) ?? {};
    const activity = Number(raw.drep_activity ?? 20);
    const major = Number(raw.protocol_major_ver ?? 9);
    const st = (await db`SELECT dormant_epochs FROM gov_state WHERE id = 1`.values()) as unknown[][];
    const dormant = Number(st[0]?.[0] ?? 0);
    return epoch + activity - (registration && major < 10 ? 0 : dormant);
}

export async function recordDRepRegistration(db: SqlClient, cred: any, deposit: bigint, slot: number, epoch: number, expiryEpoch?: number): Promise<void> {
    const isScript = cred?.type === 1 || cred?.type === "script" ? 1 : 0;
    const expiry = expiryEpoch ?? (await drepExpiryFor(db, epoch, true));
    await db`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (${hex(cred?.hash)}, ${isScript}, ${deposit.toString()}, ${slot}, ${epoch}, ${expiry})
        ON CONFLICT(credential) DO UPDATE SET deposit = excluded.deposit, last_active_epoch = excluded.last_active_epoch, expiry_epoch = excluded.expiry_epoch`;
}
/**
 * A DRep's unregistration also clears every vote delegation to it (cardano-ledger GOVCERT,
 * `ConwayUnRegDRep`: `clearDRepDelegations` over the DRep's delegator set, no protocol-version
 * guard). Bug 101: only the DRep row was dropped, so the delegations survived; when the DRep
 * registered again its old delegators counted for it without re-delegating (preview epoch 1415:
 * 1 339 registered credentials with a delegation the chain no longer has, 4.1 M ADA on one
 * re-registered DRep; found by the snapshot decoder against the node's unified map).
 */
export async function recordDRepUnregistration(db: SqlClient, cred: any): Promise<void> {
    const h = hex(cred?.hash);
    const isScript = cred?.type === 1 || cred?.type === "script" ? 1 : 0;
    await db`DELETE FROM gov_dreps WHERE credential = ${h}`;
    await db`DELETE FROM gov_drep_delegations WHERE drep_type = ${isScript} AND drep_hash = ${h}`;
}
export async function recordDRepActivity(db: SqlClient, credHex: string, epoch: number): Promise<void> {
    const expiry = await drepExpiryFor(db, epoch, false);
    await db`UPDATE gov_dreps SET last_active_epoch = ${epoch}, expiry_epoch = ${expiry} WHERE credential = ${credHex}`;
}

/** Credentials of the DReps whose expiry reaches `currentEpoch` (registered and not expired). */
export async function activeDRepCredentials(currentEpoch: number, drepActivity: number): Promise<Set<string>> {
    const reg = (await sql`SELECT credential FROM gov_dreps WHERE COALESCE(expiry_epoch, last_active_epoch + ${drepActivity}) >= ${currentEpoch}`.values()) as unknown[][];
    return new Set(reg.map((r) => String(r[0])));
}
export async function recordVoteDelegation(db: SqlClient, stakeCred: any, drep: any): Promise<void> {
    const t = Number(drep?.drepType ?? drep?.type ?? -1);
    const h = t === 0 || t === 1 ? hex(drep?.hash) : null;
    await db`INSERT OR REPLACE INTO gov_drep_delegations (stake_key, drep_type, drep_hash) VALUES (${typedCredHexOf(stakeCred) ?? hex(stakeCred?.hash)}, ${t}, ${h})`;
}
/**
 * A stake credential's deregistration removes its DRep delegation with its pool delegation and
 * reward balance (Conway DELEG rule, `dereg`: vDelegs, sDelegs and rwds all lose the credential).
 * Bug 89: only the pool delegation was dropped, so a credential that deregistered and
 * re-registered without a new vote delegation kept voting through its old DRep (preview
 * epochs 960–962: a 91 T whale counted for drep1yg2dvrjv…, the chain counted nothing; 35b81b42…
 * ratified one epoch early).
 */
export async function recordStakeDeregistration(db: SqlClient, stakeCred: any): Promise<void> {
    const key = typedCredHexOf(stakeCred) ?? hex(stakeCred?.hash);
    if (!key) return;
    await db`DELETE FROM gov_drep_delegations WHERE stake_key = ${key}`;
}
export async function recordCommitteeHot(db: SqlClient, cold: any, hot: any): Promise<void> {
    const c = hex(cold?.hash), h = hex(hot?.hash);
    await db`INSERT INTO gov_committee_auth (cold_credential, hot_credential, resigned) VALUES (${c}, ${h}, 0) ON CONFLICT(cold_credential) DO UPDATE SET hot_credential = excluded.hot_credential, resigned = 0`;
    await db`UPDATE gov_committee SET hot_credential = ${h}, resigned = 0 WHERE cold_credential = ${c}`;
}
export async function recordCommitteeResign(db: SqlClient, cold: any): Promise<void> {
    const c = hex(cold?.hash);
    await db`INSERT INTO gov_committee_auth (cold_credential, hot_credential, resigned) VALUES (${c}, NULL, 1) ON CONFLICT(cold_credential) DO UPDATE SET hot_credential = NULL, resigned = 1`;
    await db`UPDATE gov_committee SET resigned = 1, hot_credential = NULL WHERE cold_credential = ${c}`;
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

function actionPayload(kind: ActionKind, a: any, rawChanges?: Record<string, unknown> | null): Record<string, unknown> {
    switch (kind) {
        case "ParameterChange": {
            // The body bytes are authoritative (bug 59: cost models with negative entries were
            // dropped; bug 66: governance-group fields and the execution-unit limits were not
            // mapped); the library view only fills in when the bytes are unavailable.
            const changes = { ...updateToRaw(a.protocolParamsUpdate ?? {}), ...(rawChanges ?? {}) };
            return { changes, policy: a.policyHash ? hex(a.policyHash) : null };
        }
        case "InitHardFork":
            return { major: Number(a.protocolVersion?.major ?? 0), minor: Number(a.protocolVersion?.minor ?? 0) };
        case "TreasuryWithdrawals": {
            const w: Array<{ account: string; amount: string }> = [];
            for (const e of (a.withdrawals?.map ?? []) as any[]) w.push({ account: rewardAccountTypedHex(e.rewardAccount), amount: String(e.amount ?? 0) }); // typed: a script account keeps its type (bug 85)
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

export async function recordProposals(db: SqlClient, txIdHex: string, proposals: any[], epoch: number, govActionLifetime: number, bodyBytes?: Uint8Array | null): Promise<number> {
    let n = 0;
    if (proposals.length) {
        // A proposal after dormant epochs: those epochs did not count against any DRep's activity.
        const st = (await db`SELECT dormant_epochs FROM gov_state WHERE id = 1`.values()) as unknown[][];
        const dormant = Number(st[0]?.[0] ?? 0);
        if (dormant > 0) {
            // cardano-ledger `updateDormantDRepExpiry`: an already expired DRep is not revived.
            await db`UPDATE gov_dreps SET expiry_epoch = expiry_epoch + ${dormant} WHERE expiry_epoch IS NOT NULL AND expiry_epoch + ${dormant} >= ${epoch}`;
            await db`UPDATE gov_dreps SET last_active_epoch = last_active_epoch + ${dormant}`;
            await db`UPDATE gov_state SET dormant_epochs = 0 WHERE id = 1`;
        }
    }
    for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        const kind = actionKind(p?.govAction);
        if (!kind) continue;
        const rawChanges = kind === "ParameterChange" && bodyBytes ? paramChangesOfProposal(bodyBytes, i) : null;
        const prev = p.govAction?.govActionId;
        const prevId = prev ? `${hex(prev.id)}:${Number(prev.index)}` : null;
        const seqRows = (await db`SELECT COALESCE(MAX(seq), 0) + 1 FROM gov_proposals`.values()) as unknown[][];
        await db`INSERT OR IGNORE INTO gov_proposals (action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch)
            VALUES (${`${txIdHex.toLowerCase()}:${i}`}, ${Number(seqRows[0]?.[0] ?? 1)}, ${kind}, ${prevId}, ${String(p.deposit ?? 0)}, ${rewardAccountTypedHex(p.rewardAccount)}, ${JSON.stringify(actionPayload(kind, p.govAction, rawChanges))}, ${epoch}, ${epoch + govActionLifetime})`;
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
            // decoded entry: { govActionId, vote: VotingProcedure { vote, anchor } } (ledger-ts 0.5.8); accept older shapes too
            const vote = Number(v.votingProcedure?.vote ?? (typeof v.vote === "object" && v.vote != null ? v.vote.vote : v.vote) ?? -1);
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
    /** Proposals removed because an action of their purpose was enacted and they do not chain on it (bug 94). */
    dropped: string[];
}

type Family = "pparams" | "hardfork" | "committee" | "constitution";
function familyOf(kind: ActionKind): Family | null {
    switch (kind) {
        case "ParameterChange": return "pparams";
        case "InitHardFork": return "hardfork";
        case "UpdateCommittee": case "NoConfidence": return "committee";
        case "NewConstitution": return "constitution";
        default: return null;
    }
}

/**
 * After enactment, proposals of the same purpose that do not chain on the new head — directly or
 * through other surviving proposals — are removed and their deposits refunded (Conway EPOCH:
 * orphans join `removed`). Bug 94: they stayed active until expiry; preview 994 enacted
 * UpdateCommittee f4188b86… and the chain dropped two sibling committee actions (Koios
 * `dropped_epoch` 994) whose 200 k ADA we refunded at 1019 instead.
 */
async function dropOrphans(db: SqlClient, epoch: number, out: EnactmentResult, heads: Record<Family, string | null>, touched: Set<Family>): Promise<void> {
    if (touched.size === 0) return;
    const active = await activeProposals();
    for (const fam of touched) {
        const mine = active.filter((p) => familyOf(p.kind) === fam);
        const kept = new Set<string>();
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of mine) {
                if (kept.has(p.action_id)) continue;
                if ((p.prev_action_id != null && p.prev_action_id === heads[fam]) || (p.prev_action_id != null && kept.has(p.prev_action_id))) { kept.add(p.action_id); changed = true; }
            }
        }
        for (const p of mine) {
            if (kept.has(p.action_id)) continue;
            await db`UPDATE gov_proposals SET status = 'dropped', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
            out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
            out.dropped.push(p.action_id);
        }
    }
}

interface ProposalRow { action_id: string; seq: number; kind: ActionKind; prev_action_id: string | null; deposit: bigint; return_account: string; payload: any; proposed_epoch: number; expires_epoch: number }

async function activeProposals(): Promise<ProposalRow[]> {
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch FROM gov_proposals WHERE status = 'active' ORDER BY seq`.values()) as unknown[][];
    return rows.map((r) => ({ action_id: String(r[0]), seq: Number(r[1]), kind: String(r[2]) as ActionKind, prev_action_id: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), return_account: String(r[5]), payload: JSON.parse(String(r[6])), proposed_epoch: Number(r[7]), expires_epoch: Number(r[8]) }));
}

/** DRep voting stake: per DRep credential → stake, plus the two default buckets, from the epoch snapshot. */
/**
 * DReps whose stake and votes count: registered and not expired. cardano-ledger keeps a
 * per-DRep expiry (last activity + drep_activity); an expired DRep is dropped from the
 * voting stake distribution and its votes carry no power (bug 71: with every registered
 * DRep in the denominator, preview's cost-model change of epoch 1270 tallied 11 % yes
 * instead of the chain's 83 %).
 */
/**
 * The DRep stake distribution the pulser set up at boundary `takenAt` works from (Conway
 * `mkStakeDistrs`: the stake snapshot's per-credential stake, i.e. UTxO plus reward balance of
 * every registered credential, plus the deposits of live governance actions credited to their
 * return address, aggregated by vote delegation). Bug 90: it was derived from `epoch_stake_cred`,
 * which holds only credentials delegated to a registered pool, so credentials that delegated a
 * vote but no stake — 8 400 of them on preview at epoch 1048, 2 415 DReps with power on the
 * chain against 216 in ours, 146.8 T against 117.3 T — and every proposal deposit were missing.
 * Idempotent per `takenAt`; the state must be that of the boundary (call before the tally).
 */
export async function takeDRepStakeSnapshot(db: SqlClient, takenAt: number): Promise<number> {
    const have = (await db`SELECT COUNT(*) FROM epoch_drep_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (Number(have[0]?.[0] ?? 0) > 0) return 0;
    await db`INSERT INTO epoch_drep_stake (taken_at, drep_type, drep_hash, stake)
        SELECT ${takenAt}, d.drep_type, COALESCE(d.drep_hash, ''), CAST(SUM(x.amount) AS TEXT) FROM (
            SELECT b.stake_key AS stake_key, b.lovelace AS amount FROM stake_balance b WHERE b.lovelace <> 0
            UNION ALL
            SELECT lower(hex(r.stake_credentials)), r.amount FROM rewards r WHERE r.amount <> 0
            UNION ALL
            SELECT p.return_account, p.deposit FROM gov_proposals p WHERE p.status IN ('active', 'ratified')
        ) x JOIN gov_drep_delegations d ON d.stake_key = x.stake_key
        GROUP BY d.drep_type, COALESCE(d.drep_hash, '')`;
    const n = (await db`SELECT COUNT(*) FROM epoch_drep_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    return Number(n[0]?.[0] ?? 0);
}

async function drepDistribution(takenAt: number, currentEpoch: number, drepActivity: number): Promise<{ byDrep: Map<string, bigint>; alwaysAbstain: bigint; alwaysNoConfidence: bigint; registered: Set<string> }> {
    let rows = (await sql`SELECT drep_type, drep_hash, stake FROM epoch_drep_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (rows.length === 0) {
        // databases from before bug 90 (no snapshot at this boundary): the pool-delegated approximation
        logger.warn(`DRep stake snapshot ${takenAt} missing; tallying from the pool stake snapshot (pre-bug-90 approximation)`);
        rows = (await sql`
            SELECT d.drep_type, d.drep_hash, COALESCE(SUM(s.stake), 0) FROM gov_drep_delegations d
            JOIN epoch_stake_cred s ON s.stake_key = d.stake_key AND s.taken_at = ${takenAt}
            GROUP BY d.drep_type, d.drep_hash`.values()) as unknown[][];
    }
    const byDrep = new Map<string, bigint>();
    let alwaysAbstain = 0n, alwaysNoConfidence = 0n;
    for (const r of rows) {
        const t = Number(r[0]), h = r[1] == null ? "" : String(r[1]), st = BigInt(String(r[2]));
        if (t === 2) alwaysAbstain += st;
        else if (t === 3) alwaysNoConfidence += st;
        else if (h) byDrep.set(h, (byDrep.get(h) ?? 0n) + st);
    }
    const registered = await activeDRepCredentials(currentEpoch, drepActivity);
    for (const h of [...byDrep.keys()]) if (!registered.has(h)) byDrep.delete(h); // expired or unregistered: no voting power
    return { byDrep, alwaysAbstain, alwaysNoConfidence, registered };
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

/** What one boundary ratified, to be enacted at the next (the ledger's DRep pulser: set up at `epoch`, completed one epoch later). */
type PendingRatification = { epoch: number; ratified: string[]; expired: string[] };

type ChainIds = { prevPP: string | null; prevHF: string | null; prevCC: string | null; prevCons: string | null };

async function proposalById(id: string): Promise<ProposalRow | null> {
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch FROM gov_proposals WHERE action_id = ${id}`.values()) as unknown[][];
    const r = rows[0];
    if (!r) return null;
    return { action_id: String(r[0]), seq: Number(r[1]), kind: String(r[2]) as ActionKind, prev_action_id: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), return_account: String(r[5]), payload: JSON.parse(String(r[6])), proposed_epoch: Number(r[7]), expires_epoch: Number(r[8]) };
}

/** Apply one ratified action's effects at the boundary into `epoch` (cardano-ledger ENACT). */
async function enactOne(db: SqlClient, p: ProposalRow, epoch: number, out: EnactmentResult, ids: ChainIds): Promise<void> {
    switch (p.kind) {
        case "ParameterChange":
            Object.assign(out.paramChanges, p.payload.changes ?? {});
            ids.prevPP = p.action_id;
            break;
        case "InitHardFork":
            out.protocolVersion = { major: Number(p.payload.major), minor: Number(p.payload.minor) };
            out.paramChanges.protocol_major_ver = out.protocolVersion.major;
            out.paramChanges.protocol_minor_ver = out.protocolVersion.minor;
            ids.prevHF = p.action_id;
            break;
        case "TreasuryWithdrawals":
            for (const w of (p.payload.withdrawals ?? []) as Array<{ account: string; amount: string }>) out.withdrawals.set(w.account, (out.withdrawals.get(w.account) ?? 0n) + BigInt(w.amount));
            break;
        case "NoConfidence":
            await db`UPDATE gov_state SET no_confidence = 1 WHERE id = 1`;
            ids.prevCC = p.action_id;
            break;
        case "UpdateCommittee":
            for (const c of (p.payload.remove ?? []) as string[]) await db`DELETE FROM gov_committee WHERE cold_credential = ${c}`;
            for (const a of (p.payload.add ?? []) as Array<{ cred: string; expires: number }>) {
                const auth = (await db`SELECT hot_credential, resigned FROM gov_committee_auth WHERE cold_credential = ${a.cred}`.values()) as unknown[][];
                const hot = auth.length && Number(auth[0]![1]) === 0 ? (auth[0]![0] == null ? null : String(auth[0]![0])) : null;
                await db`INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${a.cred}, ${a.expires}, ${hot}, 0) ON CONFLICT(cold_credential) DO UPDATE SET expires_epoch = excluded.expires_epoch, hot_credential = COALESCE(excluded.hot_credential, gov_committee.hot_credential), resigned = 0`;
            }
            await db`UPDATE gov_state SET committee_threshold_num = ${Number(p.payload.thresholdNum ?? 2)}, committee_threshold_den = ${Number(p.payload.thresholdDen ?? 3)}, no_confidence = 0 WHERE id = 1`;
            ids.prevCC = p.action_id;
            break;
        case "NewConstitution":
            await db`UPDATE gov_state SET constitution_hash = ${p.payload.hash ?? null}, constitution_script = ${p.payload.script ?? null} WHERE id = 1`;
            ids.prevCons = p.action_id;
            break;
        case "Info":
            break;
    }
    await db`UPDATE gov_proposals SET status = 'enacted', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
    await db`INSERT OR REPLACE INTO gov_enacted (epoch, action_id, kind, detail) VALUES (${epoch}, ${p.action_id}, ${p.kind}, ${JSON.stringify(p.payload)})`;
    out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
    out.enacted.push(`${p.kind} ${p.action_id.slice(0, 12)}…`);
}

/** One proposal's tally at the boundary into `epoch` with the stake snapshot `takenAt` (diagnostic: `scripts/gov-tally.ts`). */
export async function tallyProposal(db: SqlClient, epoch: number, actionId: string, prevRaw: Record<string, unknown>, takenAt = epoch, votesUntilSlot = Number.MAX_SAFE_INTEGER): Promise<{ ct: CommitteeTally; dt: DRepTally; pt: PoolTally; ccOk: boolean; drepOk: boolean; poolOk: boolean; ratified: boolean; thr: ReturnType<typeof thresholdsFor> }> {
    const p = await proposalById(actionId);
    if (!p) throw new Error(`proposal ${actionId} not stored`);
    const params = await thresholdParams(prevRaw);
    const activity = Number(prevRaw.drep_activity ?? 20);
    const dreps = await drepDistribution(takenAt, epoch - 1, activity);
    const pools = await poolDistribution(takenAt);
    const committee = (await db`SELECT c.cold_credential, c.expires_epoch, COALESCE(a.hot_credential, c.hot_credential), COALESCE(a.resigned, c.resigned) FROM gov_committee c LEFT JOIN gov_committee_auth a ON a.cold_credential = c.cold_credential`.values()) as unknown[][];
    const activeMembers = committee.filter((r) => Number(r[3]) === 0 && Number(r[1]) >= epoch && r[2] != null);
    const hotToCold = new Map<string, string>(activeMembers.map((r) => [String(r[2]), String(r[0])]));
    const nc = (await db`SELECT no_confidence FROM gov_state WHERE id = 1`.values()) as unknown[][];
    const noConfidence = Number(nc[0]?.[0]) === 1;
    const changedKeys = p.kind === "ParameterChange" ? Object.keys(p.payload.changes ?? {}) : [];
    const thr = thresholdsFor(p.kind, params, changedKeys, noConfidence ? "noConfidence" : "normal");
    const votes = (await db`SELECT voter_kind, voter_hash, vote FROM gov_votes WHERE action_id = ${p.action_id} AND slot <= ${votesUntilSlot}`.values()) as unknown[][];
    const ct: CommitteeTally = { yes: 0, no: 0, abstain: 0, active: activeMembers.length };
    const dt: DRepTally = { yes: 0n, no: 0n, abstain: 0n, unvoted: 0n, alwaysNoConfidence: dreps.alwaysNoConfidence, alwaysAbstain: dreps.alwaysAbstain };
    const pt: PoolTally = { yes: 0n, no: 0n, abstain: 0n, unvoted: 0n, unvotedAbstain: 0n, unvotedNoConfidence: 0n };
    const votedDreps = new Set<string>(), votedPools = new Set<string>();
    for (const v of votes) {
        const kind = Number(v[0]), h = String(v[1]), vote = Number(v[2]);
        if (kind === 0 || kind === 1) { if (!hotToCold.has(h)) continue; if (vote === 1) ct.yes++; else if (vote === 0) ct.no++; else ct.abstain++; }
        else if (kind === 2 || kind === 3) { if (!dreps.registered.has(h)) continue; const st = dreps.byDrep.get(h) ?? 0n; votedDreps.add(h); if (vote === 1) dt.yes += st; else if (vote === 0) dt.no += st; else dt.abstain += st; }
        else if (kind === 4) { const st = pools.byPool.get(h) ?? 0n; votedPools.add(h); if (vote === 1) pt.yes += st; else if (vote === 0) pt.no += st; else pt.abstain += st; }
    }
    for (const [h, st] of dreps.byDrep) if (!votedDreps.has(h) && dreps.registered.has(h)) dt.unvoted += st;
    for (const [pool, st] of pools.byPool) { if (votedPools.has(pool)) continue; pt.unvoted += st; const d = pools.rewardDrep.get(pool); if (d === 2) pt.unvotedAbstain += st; if (d === 3) pt.unvotedNoConfidence += st; }
    const ccRequired = p.kind !== "NoConfidence" && p.kind !== "UpdateCommittee";
    const ccOk = !ccRequired ? true : noConfidence ? false : committeeAccepts(ct, thr.committee, params.committeeMinSize);
    const drepOk = thr.drep == null || drepAccepts(dt, thr.drep, p.kind);
    const poolOk = thr.pool == null || poolAccepts(pt, thr.pool, p.kind);
    return { ct, dt, pt, ccOk, drepOk, poolOk, ratified: ccOk && drepOk && poolOk && p.kind !== "Info", thr };
}

/**
 * Governance at the start of `epoch`, in the ledger's two steps:
 *
 * 1. Enact what the previous boundary ratified. cardano-ledger sets up the DRep pulser at the
 *    start of an epoch (proposals, votes and stake as of that boundary) and completes it at the
 *    next boundary, where the ratified actions take effect and expired ones are dropped and
 *    refunded (bug 81: enacting at ratification put a new cost model one epoch early — preview
 *    epoch 735, action 1f47f3cf…, ratified 735, enacted 736 on the chain).
 * 2. Ratify for this boundary with the parameters of `epoch − 1` and the stake snapshot the
 *    ledger uses for voting (taken at the start of `epoch − 1`); record the result as pending.
 *
 * Returns the effects of step 1 for the caller to apply (parameters, hard fork, treasury
 * withdrawals, deposit refunds).
 */
export async function ratifyAndEnact(db: SqlClient, epoch: number, prevRaw: Record<string, unknown>, takenAt = epoch - 1): Promise<EnactmentResult> {
    const out = await enactPending(db, epoch);
    await ratifyForNext(db, epoch, prevRaw, takenAt);
    return out;
}

async function chainIds(db: SqlClient): Promise<{ ids: ChainIds; noConfidence: boolean; pending: PendingRatification | null } | null> {
    const state = (await db`SELECT prev_pparams, prev_hardfork, prev_committee, prev_constitution, no_confidence, pending FROM gov_state WHERE id = 1`.values()) as unknown[][];
    if (!state.length) return null;
    const ids: ChainIds = { prevPP: state[0]![0] == null ? null : String(state[0]![0]), prevHF: state[0]![1] == null ? null : String(state[0]![1]), prevCC: state[0]![2] == null ? null : String(state[0]![2]), prevCons: state[0]![3] == null ? null : String(state[0]![3]) };
    let pending: PendingRatification | null = null;
    try { pending = state[0]![5] == null ? null : (JSON.parse(String(state[0]![5])) as PendingRatification); } catch { pending = null; }
    return { ids, noConfidence: Number(state[0]![4]) === 1, pending };
}

/** Step 1: enact what the previous boundary ratified (before the epoch's parameters are derived). */
export async function enactPending(db: SqlClient, epoch: number): Promise<EnactmentResult> {
    const out: EnactmentResult = { paramChanges: {}, protocolVersion: null, withdrawals: new Map(), refunds: new Map(), enacted: [], expired: [], dropped: [] };
    const st = await chainIds(db);
    if (!st) return out;
    const { ids, pending } = st;
    if (pending) {
        if (pending.epoch !== epoch - 1) logger.warn(`Epoch ${epoch} governance: enacting the ratification recorded at epoch ${pending.epoch} (expected ${epoch - 1})`);
        const touched = new Set<Family>();
        for (const id of pending.ratified) {
            const p = await proposalById(id);
            if (!p) { logger.warn(`Epoch ${epoch} governance: ratified action ${id} no longer stored`); continue; }
            await enactOne(db, p, epoch, out, ids);
            const fam = familyOf(p.kind);
            if (fam) touched.add(fam);
        }
        // Expired first, so the orphan sweep below (which reads the still-active set) cannot
        // refund an expiring proposal a second time (bug 98: preview 999 — 573b7228… expired and
        // orphaned by 602d8572… in the same boundary, 100 k ADA refunded twice to 8ff4073b…).
        for (const id of pending.expired) {
            const p = await proposalById(id);
            if (!p) continue;
            await db`UPDATE gov_proposals SET status = 'expired', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
            out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
            out.expired.push(p.action_id);
        }
        await dropOrphans(db, epoch, out, { pparams: ids.prevPP ?? null, hardfork: ids.prevHF ?? null, committee: ids.prevCC ?? null, constitution: ids.prevCons ?? null }, touched);
        await db`UPDATE gov_state SET prev_pparams = ${ids.prevPP}, prev_hardfork = ${ids.prevHF}, prev_committee = ${ids.prevCC}, prev_constitution = ${ids.prevCons}, pending = NULL WHERE id = 1`;
    }
    return out;
}

/**
 * Step 2: ratify for this boundary — the pulser the ledger sets up once the epoch's parameters
 * are in force and the stake snapshot is taken (bug 82: the pool and DRep distributions are the
 * snapshot of *this* boundary and the thresholds this epoch's parameters; with the previous
 * snapshot the preview hard fork 049ae5d6… tallied 46 % of pool stake at 742 instead of the
 * chain's 62 % and moved one epoch late). `raw` = parameters of `epoch`; `takenAt` = snapshot
 * epoch (default `epoch`). The result is recorded as pending and enacted at the next boundary.
 */
export async function ratifyForNext(db: SqlClient, epoch: number, raw: Record<string, unknown>, takenAt = epoch): Promise<PendingRatification> {
    const st = await chainIds(db);
    const next: PendingRatification = { epoch, ratified: [], expired: [] };
    if (!st) return next;
    const { ids, noConfidence } = st;
    const prevRaw = raw;
    const params = await thresholdParams(prevRaw);
    // A DRep is active for this pulser when its last activity plus drep_activity reaches the
    // previous epoch (the expiry the ledger evaluates when the pulser is set up).
    const activity = Number(prevRaw.drep_activity ?? 20);
    await takeDRepStakeSnapshot(db, takenAt); // bug 90: the pulser's DRep stake, as of this boundary
    const dreps = await drepDistribution(takenAt, epoch - 1, activity);
    const pools = await poolDistribution(takenAt);
    const committee = (await db`SELECT c.cold_credential, c.expires_epoch, COALESCE(a.hot_credential, c.hot_credential), COALESCE(a.resigned, c.resigned) FROM gov_committee c LEFT JOIN gov_committee_auth a ON a.cold_credential = c.cold_credential`.values()) as unknown[][];
    const activeMembers = committee.filter((r) => Number(r[3]) === 0 && Number(r[1]) >= epoch && r[2] != null);
    const hotToCold = new Map<string, string>(activeMembers.map((r) => [String(r[2]), String(r[0])]));
    const ratifiedThisEpoch = new Set<"pparams" | "hardfork" | "committee" | "constitution">();
    const proposals = await activeProposals();
    // Bug 96: once a delaying action (NoConfidence, UpdateCommittee, NewConstitution, InitHardFork)
    // is accepted in a round, every later proposal of the round is delayed to the next boundary
    // (Conway RATIFY `delayingAction`; preview 997: UpdateCommittee 6214314b… ratified, the
    // ParameterChange 602d8572… behind it only at 998).
    let delayed = false;

    for (const p of proposals) {
        if (p.expires_epoch < epoch) {
            // dropped and refunded when this boundary's pulser completes (next boundary)
            next.expired.push(p.action_id);
            continue;
        }
        if (delayed) continue; // a delaying action was accepted earlier in this round
        // chained purposes: the proposal must build on the last enacted action of its purpose
        const purpose = p.kind === "ParameterChange" ? "pparams" : p.kind === "InitHardFork" ? "hardfork" : (p.kind === "NoConfidence" || p.kind === "UpdateCommittee") ? "committee" : p.kind === "NewConstitution" ? "constitution" : null;
        if (purpose) {
            const prevEnacted = purpose === "pparams" ? ids.prevPP : purpose === "hardfork" ? ids.prevHF : purpose === "committee" ? ids.prevCC : ids.prevCons;
            if ((p.prev_action_id ?? null) !== (prevEnacted ?? null)) continue; // not (yet) buildable
            if (ratifiedThisEpoch.has(purpose)) continue; // one per purpose per epoch
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
        // The committee does not vote on its own replacement (NoConfidence, UpdateCommittee):
        // cardano-ledger's votingCommitteeThreshold is Nothing for both. Every other kind needs
        // it, and none of them can pass while the committee is in a state of no confidence.
        const ccRequired = p.kind !== "NoConfidence" && p.kind !== "UpdateCommittee";
        const ccOk = !ccRequired ? true : noConfidence ? false : committeeAccepts(ct, thr.committee, params.committeeMinSize);
        const drepOk = thr.drep == null || drepAccepts(dt, thr.drep, p.kind);
        const poolOk = thr.pool == null || poolAccepts(pt, thr.pool, p.kind);
        // NoConfidence / UpdateCommittee cannot be ratified by the CC when the CC is the subject
        const ratified = ccOk && drepOk && poolOk && (p.kind !== "Info");
        // One line per proposal so a tally that differs from the chain can be examined afterwards
        // (per-credential snapshots are pruned; `scripts/gov-tally.ts` cannot recompute old epochs).
        const pctOf = (a: bigint, b: bigint) => (b === 0n ? "n/a" : `${(Number((a * 10000n) / b) / 100).toFixed(2)}%`);
        logger.info(`Epoch ${epoch} tally ${p.kind} ${p.action_id.slice(0, 12)}…: ${ratified ? "RATIFIED" : "not ratified"} — cc ${ct.yes}/${ct.no}/${ct.abstain} of ${ct.active} (${ccOk ? "ok" : "no"}), drep yes ${pctOf(dt.yes, dt.yes + dt.no + dt.unvoted)} of ${dt.yes + dt.no + dt.unvoted} (${dt.yes}/${dt.no}/abstain ${dt.abstain}/unvoted ${dt.unvoted}; ${drepOk ? "ok" : "no"}, thr ${thr.drep ? `${thr.drep.num}/${thr.drep.den}` : "none"}), pool yes ${pctOf(pt.yes, pt.yes + pt.no + pt.unvoted - pt.unvotedAbstain)} (${pt.yes}/${pt.no}/unvoted ${pt.unvoted}; ${poolOk ? "ok" : "no"}, thr ${thr.pool ? `${thr.pool.num}/${thr.pool.den}` : "none"})`);
        if (!ratified) continue;
        if (p.kind === "NoConfidence" || p.kind === "UpdateCommittee" || p.kind === "NewConstitution" || p.kind === "InitHardFork") delayed = true;

        // ratified: enacted at the next boundary; the chain ids advance now so the next pulser
        // (set up after that enactment) sees them, and so a second action of the purpose waits
        switch (purpose) {
            case "pparams": ids.prevPP = p.action_id; break;
            case "hardfork": ids.prevHF = p.action_id; break;
            case "committee": ids.prevCC = p.action_id; break;
            case "constitution": ids.prevCons = p.action_id; break;
        }
        if (purpose) ratifiedThisEpoch.add(purpose);
        await db`UPDATE gov_proposals SET status = 'ratified', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
        next.ratified.push(p.action_id);
    }
    await db`UPDATE gov_state SET prev_pparams = ${ids.prevPP}, prev_hardfork = ${ids.prevHF}, prev_committee = ${ids.prevCC}, prev_constitution = ${ids.prevCons}, pending = ${JSON.stringify(next)} WHERE id = 1`;
    if (next.ratified.length || next.expired.length) logger.info(`Epoch ${epoch} governance: ratified [${next.ratified.map((a) => a.slice(0, 12) + "…").join(", ")}], expiring ${next.expired.length} — enacted at the next boundary`);
    // An epoch with no proposal to vote on is dormant: it must not age the DReps.
    if (proposals.length === 0) await db`UPDATE gov_state SET dormant_epochs = dormant_epochs + 1 WHERE id = 1`;
    return next;
}
