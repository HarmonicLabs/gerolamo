/**
 * Ledger state the header rules read: registered pools (with their VRF keys and
 * retirement epochs), operational-certificate counters, genesis delegations and
 * the per-epoch stake snapshot used for slot leadership.
 *
 * Snapshot semantics (cardano-ledger SNAP/NEWEPOCH): the distribution that
 * decides leaders in epoch e is the stake as it stood at the start of epoch
 * e − 1. `takeStakeSnapshot(e)` is called when the first block of epoch e is
 * about to be applied and stores the state at that moment under `taken_at = e`;
 * `poolStakeForEpoch(e)` reads `taken_at = e − 1`.
 */
import { sql } from "../sql";
import type { SqlClient } from "../db";

export async function ensureLeaderStateTables(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS pool_params (
        pool_id TEXT PRIMARY KEY,
        vrf_key_hash TEXT NOT NULL,
        registered_slot INTEGER NOT NULL,
        retiring_epoch INTEGER,
        params_json TEXT
    )`;
    const cols = new Set(((await sql`PRAGMA table_info(pool_params)`.values()) as unknown[][]).map((r) => String(r[1])));
    if (!cols.has("params_json")) await sql`ALTER TABLE pool_params ADD COLUMN params_json TEXT`;
    await sql`CREATE TABLE IF NOT EXISTS blocks_made_by_epoch (
        epoch INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        blocks INTEGER NOT NULL,
        PRIMARY KEY (epoch, pool_id)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS opcert_counters (
        pool_id TEXT PRIMARY KEY,
        counter INTEGER NOT NULL,
        slot INTEGER NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS genesis_delegs (
        genesis_key_hash TEXT NOT NULL,
        delegate_hash TEXT NOT NULL,
        vrf_key_hash TEXT NOT NULL,
        effective_slot INTEGER NOT NULL,
        PRIMARY KEY (genesis_key_hash, effective_slot)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS epoch_pool_stake (
        taken_at INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        stake INTEGER NOT NULL,
        PRIMARY KEY (taken_at, pool_id)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS epoch_stake_cred (
        taken_at INTEGER NOT NULL,
        stake_key TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        stake INTEGER NOT NULL,
        PRIMARY KEY (taken_at, stake_key)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS reward_pots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reserves INTEGER NOT NULL,
        treasury INTEGER NOT NULL,
        fee_pot INTEGER NOT NULL,
        initialized_epoch INTEGER NOT NULL
    )`;
    try { await sql`ALTER TABLE reward_pots ADD COLUMN donation_pot INTEGER NOT NULL DEFAULT 0`; } catch { /* exists */ }
    await sql`CREATE TABLE IF NOT EXISTS pending_rewards (
        pay_at INTEGER NOT NULL,
        stake_key TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (pay_at, stake_key)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS reward_epochs (
        performance_epoch INTEGER PRIMARY KEY,
        reward_pot INTEGER NOT NULL,
        treasury_delta INTEGER NOT NULL,
        paid INTEGER NOT NULL,
        unclaimed INTEGER NOT NULL,
        pools INTEGER NOT NULL,
        accounts INTEGER NOT NULL,
        computed_at INTEGER DEFAULT (strftime('%s','now'))
    )`;
    await sql`CREATE TABLE IF NOT EXISTS epoch_stake_totals (
        taken_at INTEGER PRIMARY KEY,
        total_active INTEGER NOT NULL,
        pools INTEGER NOT NULL,
        computed_at INTEGER DEFAULT (strftime('%s','now'))
    )`;
}

/** Reward-relevant pool parameters, stored as JSON (strings for the big numbers). */
export interface PoolRewardParams {
    pledge: string;
    cost: string;
    /** margin as a rational */
    marginNum: string;
    marginDen: string;
    rewardAccount: string;
    owners: string[];
}

/**
 * Pool registration certificate. A new pool is registered at once; a
 * re-registration of a known pool only cancels a pending retirement now and
 * takes effect at the next epoch boundary (`psFutureStakePoolParams`, applied by
 * POOLREAP after the snapshot), which is when `promotePendingPoolParams` runs.
 */
export async function recordPoolRegistration(db: SqlClient, poolId: string, vrfKeyHash: string, slot: number, params?: PoolRewardParams | null): Promise<void> {
    const id = poolId.toLowerCase();
    const json = params ? JSON.stringify(params) : null;
    await ensurePendingPoolParamsTable(db);
    const existing = (await db`SELECT 1 FROM pool_params WHERE pool_id = ${id}`.values()) as unknown[][];
    if (!existing.length) {
        await db`INSERT INTO pool_params (pool_id, vrf_key_hash, registered_slot, retiring_epoch, params_json)
            VALUES (${id}, ${vrfKeyHash.toLowerCase()}, ${slot}, NULL, ${json})`;
        return;
    }
    await db`UPDATE pool_params SET retiring_epoch = NULL WHERE pool_id = ${id}`;
    await db`INSERT OR REPLACE INTO pool_params_pending (pool_id, vrf_key_hash, registered_slot, params_json)
        VALUES (${id}, ${vrfKeyHash.toLowerCase()}, ${slot}, ${json})`;
}

async function ensurePendingPoolParamsTable(db: SqlClient): Promise<void> {
    await db`CREATE TABLE IF NOT EXISTS pool_params_pending (
        pool_id TEXT PRIMARY KEY,
        vrf_key_hash TEXT NOT NULL,
        registered_slot INTEGER NOT NULL,
        params_json TEXT
    )`;
}

/** Epoch boundary: pending re-registrations become the pools' parameters (after the snapshot was taken). */
export async function promotePendingPoolParams(db: SqlClient): Promise<number> {
    await ensurePendingPoolParamsTable(db);
    const rows = (await db`SELECT pool_id, vrf_key_hash, registered_slot, params_json FROM pool_params_pending`.values()) as unknown[][];
    for (const r of rows) {
        await db`UPDATE pool_params SET vrf_key_hash = ${String(r[1])}, registered_slot = ${Number(r[2])}, params_json = COALESCE(${r[3] == null ? null : String(r[3])}, params_json) WHERE pool_id = ${String(r[0])}`;
    }
    await db`DELETE FROM pool_params_pending`;
    return rows.length;
}

/** One more block issued by `poolId` in `epoch` (reward performance input). */
export async function noteBlockMade(db: SqlClient, poolId: string, epoch: number): Promise<void> {
    await db`INSERT INTO blocks_made_by_epoch (epoch, pool_id, blocks) VALUES (${epoch}, ${poolId.toLowerCase()}, 1)
        ON CONFLICT(epoch, pool_id) DO UPDATE SET blocks = blocks + 1`;
}

export async function blocksMadeInEpoch(epoch: number): Promise<Map<string, number>> {
    const rows = (await sql`SELECT pool_id, blocks FROM blocks_made_by_epoch WHERE epoch = ${epoch}`.values()) as unknown[][];
    const out = new Map<string, number>();
    for (const r of rows) out.set(String(r[0]), Number(r[1]));
    return out;
}

export async function registeredPoolParams(): Promise<Map<string, { vrf: string; params: PoolRewardParams | null }>> {
    const rows = (await sql`SELECT pool_id, vrf_key_hash, params_json FROM pool_params`.values()) as unknown[][];
    const out = new Map<string, { vrf: string; params: PoolRewardParams | null }>();
    for (const r of rows) {
        let params: PoolRewardParams | null = null;
        try {
            params = r[2] ? (JSON.parse(String(r[2])) as PoolRewardParams) : null;
        } catch {
            params = null;
        }
        out.set(String(r[0]), { vrf: String(r[1]), params });
    }
    return out;
}

export async function recordPoolRetirement(db: SqlClient, poolId: string, epoch: number): Promise<void> {
    await db`UPDATE pool_params SET retiring_epoch = ${epoch} WHERE pool_id = ${poolId.toLowerCase()}`;
}

/** Pools whose retirement epoch has arrived leave the registered set. */
export async function retirePoolsAtEpoch(db: SqlClient, epoch: number): Promise<number> {
    return (await retirePoolsAtEpochDetailed(db, epoch)).length;
}

export interface RetiredPool {
    poolId: string;
    /** Typed credential hex of the reward account (db/stakeCred.ts), or null when unknown. */
    rewardAccount: string | null;
    delegationsRemoved: number;
}

/**
 * POOLREAP: every pool whose retirement epoch has arrived is removed together with
 * the delegations pointing at it (its delegators become undelegated; preprod pool
 * efe2f45e… re-registered later and its old delegators must not count again).
 * The caller refunds the pool deposit to the reward account.
 */
export async function retirePoolsAtEpochDetailed(db: SqlClient, epoch: number): Promise<RetiredPool[]> {
    const rows = (await db`SELECT pool_id, params_json FROM pool_params WHERE retiring_epoch IS NOT NULL AND retiring_epoch <= ${epoch}`.values()) as unknown[][];
    const out: RetiredPool[] = [];
    for (const r of rows) {
        const poolId = String(r[0]).toLowerCase();
        let rewardAccount: string | null = null;
        try {
            const p = r[1] == null ? null : JSON.parse(String(r[1]));
            const ra = p?.rewardAccount ? String(p.rewardAccount).toLowerCase() : "";
            if (/^(01)?[0-9a-f]{56}$/.test(ra)) rewardAccount = ra;
        } catch { /* no params recorded */ }
        const d = await db`DELETE FROM delegations WHERE lower(hex(pool_key_hash)) = ${poolId}`;
        await db`DELETE FROM pool_params WHERE pool_id = ${poolId}`;
        out.push({ poolId, rewardAccount, delegationsRemoved: Number((d as { count?: number })?.count ?? 0) });
    }
    return out;
}

/**
 * Pool deposit refunds at retirement: to the reward account when it is registered,
 * otherwise to the treasury (Shelley POOLREAP). Returns what went where.
 */
export async function refundPoolDeposits(db: SqlClient, retired: RetiredPool[], deposit: bigint): Promise<{ refunded: bigint; toTreasury: bigint }> {
    let refunded = 0n, toTreasury = 0n;
    if (deposit <= 0n || retired.length === 0) return { refunded, toTreasury };
    const registered = await registeredStakeKeys();
    const credit = new Map<string, bigint>();
    for (const p of retired) {
        if (p.rewardAccount && registered.has(p.rewardAccount)) {
            credit.set(p.rewardAccount, (credit.get(p.rewardAccount) ?? 0n) + deposit);
            refunded += deposit;
        } else {
            toTreasury += deposit;
        }
    }
    if (credit.size) await creditRewards(db, credit);
    if (toTreasury > 0n) {
        const pots = await readRewardPots();
        if (pots) await updateRewardPots(db, { reserves: 0n, treasury: toTreasury, resetFees: false });
    }
    return { refunded, toTreasury };
}

/**
 * Boundary payouts to reward accounts (governance deposit refunds, enacted treasury
 * withdrawals): only registered accounts are credited; the rest is "unclaimed" and stays in /
 * goes to the treasury (Conway EPOCH: `refunds = payout ∣ dom rewards`,
 * `treasury = treasury − withdrawals + donations + unclaimed`). Bug 91: every refund was
 * credited, so preview epoch 707 paid 200 k ADA of expired deposits to an unregistered return
 * account that the chain sent to the treasury (728/736/743 one action each). Keys are typed
 * credential hex; pots are the caller's business.
 */
export async function creditRegisteredAccounts(db: SqlClient, amounts: Map<string, bigint>): Promise<{ credited: bigint; unclaimed: bigint; unregistered: string[] }> {
    let credited = 0n, unclaimed = 0n;
    const unregistered: string[] = [];
    if (amounts.size === 0) return { credited, unclaimed, unregistered };
    const registered = await registeredStakeKeys();
    const credit = new Map<string, bigint>();
    for (const [account, amount] of amounts) {
        if (amount <= 0n) continue;
        if (registered.has(account.toLowerCase())) {
            credit.set(account, (credit.get(account) ?? 0n) + amount);
            credited += amount;
        } else {
            unclaimed += amount;
            unregistered.push(account);
        }
    }
    if (credit.size) await creditRewards(db, credit);
    return { credited, unclaimed, unregistered };
}

export async function registeredPoolVrf(poolId: string): Promise<string | null> {
    const rows = (await sql`SELECT vrf_key_hash FROM pool_params WHERE pool_id = ${poolId.toLowerCase()}`.values()) as unknown[][];
    return rows[0]?.[0] == null ? null : String(rows[0][0]);
}

export async function recordGenesisDelegation(db: SqlClient, genesisKeyHash: string, delegateHash: string, vrfKeyHash: string, effectiveSlot: number): Promise<void> {
    await db`INSERT OR REPLACE INTO genesis_delegs (genesis_key_hash, delegate_hash, vrf_key_hash, effective_slot)
        VALUES (${genesisKeyHash.toLowerCase()}, ${delegateHash.toLowerCase()}, ${vrfKeyHash.toLowerCase()}, ${effectiveSlot})`;
}

/** Seed the Shelley genesis delegations (effective from slot 0) once. */
export async function seedGenesisDelegs(genDelegs: Record<string, { delegate: string; vrf: string }>): Promise<void> {
    for (const [gk, d] of Object.entries(genDelegs ?? {})) {
        await sql`INSERT OR IGNORE INTO genesis_delegs (genesis_key_hash, delegate_hash, vrf_key_hash, effective_slot)
            VALUES (${gk.toLowerCase()}, ${String(d.delegate).toLowerCase()}, ${String(d.vrf).toLowerCase()}, 0)`;
    }
}

/** Genesis key → { delegate, vrf } in force at `slot` (latest effective row per key). */
export async function genesisDelegsAt(slot: number): Promise<Map<string, { delegate: string; vrf: string }>> {
    const rows = (await sql`
        SELECT g.genesis_key_hash, g.delegate_hash, g.vrf_key_hash FROM genesis_delegs g
        WHERE g.effective_slot = (SELECT MAX(effective_slot) FROM genesis_delegs x WHERE x.genesis_key_hash = g.genesis_key_hash AND x.effective_slot <= ${slot})
    `.values()) as unknown[][];
    const out = new Map<string, { delegate: string; vrf: string }>();
    for (const r of rows) out.set(String(r[0]), { delegate: String(r[1]), vrf: String(r[2]) });
    return out;
}

export async function opcertCounter(poolId: string): Promise<number | null> {
    const rows = (await sql`SELECT counter FROM opcert_counters WHERE pool_id = ${poolId.toLowerCase()}`.values()) as unknown[][];
    return rows[0]?.[0] == null ? null : Number(rows[0][0]);
}

// Per-pool cache of the opcert counter row: read for every validated header and written for
// every applied block (a SELECT and an upsert per block, ≈ 4 % of the applier's SQL time).
// Rollbacks restore the table from the journal, so the orchestrator clears the cache then.
const opcertCache = new Map<string, { counter: number; slot: number }>();
export function resetOpcertCounterCache(): void { opcertCache.clear(); }

/** Last applied operational-certificate counter of a pool and the slot of the block that set it. */
export async function opcertCounterState(poolId: string): Promise<{ counter: number; slot: number } | null> {
    const key = poolId.toLowerCase();
    const hit = opcertCache.get(key);
    if (hit) return hit;
    const rows = (await sql`SELECT counter, slot FROM opcert_counters WHERE pool_id = ${key}`.values()) as unknown[][];
    if (!rows.length || rows[0]?.[0] == null) return null;
    const state = { counter: Number(rows[0][0]), slot: Number(rows[0][1] ?? 0) };
    opcertCache.set(key, state);
    return state;
}

/**
 * Record a block's opcert counter. Unchanged counter: nothing to write — the stored slot stays
 * the block that first carried this counter, which is what the "headers after the block that
 * set it" comparison in leaderCheck wants.
 */
export async function setOpcertCounter(db: SqlClient, poolId: string, counter: number, slot: number): Promise<void> {
    const key = poolId.toLowerCase();
    const cur = opcertCache.get(key) ?? await opcertCounterState(key);
    if (cur && cur.counter === counter) return;
    await db`INSERT INTO opcert_counters (pool_id, counter, slot) VALUES (${key}, ${counter}, ${slot})
        ON CONFLICT(pool_id) DO UPDATE SET counter = excluded.counter, slot = excluded.slot`;
    opcertCache.set(key, { counter, slot });
}

/**
 * Stake per registered pool from the current state: every UTxO whose address
 * carries a stake credential delegated to a registered pool, plus that
 * credential's reward balance. Stored under `taken_at` = the epoch that begins.
 */
export async function takeStakeSnapshot(db: SqlClient, takenAt: number): Promise<{ pools: number; total: bigint }> {
    const exists = (await db`SELECT 1 FROM epoch_stake_totals WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (exists.length) {
        const t = (await db`SELECT total_active, pools FROM epoch_stake_totals WHERE taken_at = ${takenAt}`.values()) as unknown[][];
        return { pools: Number(t[0]?.[1] ?? 0), total: BigInt(String(t[0]?.[0] ?? 0)) };
    }
    await db`DROP TABLE IF EXISTS tmp_deleg_hex`;
    await db`CREATE TEMP TABLE tmp_deleg_hex (stake_key TEXT PRIMARY KEY, pool_id TEXT NOT NULL)`;
    // Latest delegation per credential (the table keeps history rows; the newest id wins).
    // Keys are typed credential hex (db/stakeCred.ts): "01" + hash for script credentials.
    await db`INSERT OR REPLACE INTO tmp_deleg_hex (stake_key, pool_id)
        SELECT CASE WHEN d.cred_type = 1 THEN '01' ELSE '' END || lower(hex(d.stake_credentials)), lower(hex(d.pool_key_hash)) FROM delegations d
        JOIN pool_params p ON p.pool_id = lower(hex(d.pool_key_hash))
        WHERE d.id = (SELECT MAX(d2.id) FROM delegations d2 WHERE d2.stake_credentials = d.stake_credentials AND d2.cred_type IS d.cred_type)`;
    // Rows from before the type was recorded (cred_type NULL) may be script credentials:
    // let them match script-stake outputs too, as they did before typing.
    await db`INSERT OR IGNORE INTO tmp_deleg_hex (stake_key, pool_id)
        SELECT '01' || lower(hex(d.stake_credentials)), lower(hex(d.pool_key_hash)) FROM delegations d
        JOIN pool_params p ON p.pool_id = lower(hex(d.pool_key_hash))
        WHERE d.cred_type IS NULL AND d.id = (SELECT MAX(d2.id) FROM delegations d2 WHERE d2.stake_credentials = d.stake_credentials AND d2.cred_type IS NULL)`;
    await db`INSERT OR REPLACE INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake)
        SELECT ${takenAt}, t.stake_key, t.pool_id, SUM(x.amount) FROM (
            SELECT b.stake_key AS stake_key, b.lovelace AS amount FROM stake_balance b WHERE b.lovelace <> 0
            UNION ALL
            SELECT lower(hex(r.stake_credentials)), r.amount FROM rewards r
        ) x JOIN tmp_deleg_hex t ON t.stake_key = x.stake_key
        GROUP BY t.stake_key, t.pool_id
        HAVING SUM(x.amount) <> 0`; // the ledger's snapshot holds no zero-stake credential (a pool with none has no distribution entry)
    await db`INSERT OR REPLACE INTO epoch_pool_stake (taken_at, pool_id, stake)
        SELECT ${takenAt}, pool_id, SUM(stake) FROM epoch_stake_cred WHERE taken_at = ${takenAt} GROUP BY pool_id`;
    // Pool parameters as of this snapshot: rewards for the epoch this snapshot leads use
    // these (owners, cost, margin, pledge, reward account), not whatever is current later.
    await db`CREATE TABLE IF NOT EXISTS epoch_pool_params (
        taken_at INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        vrf_key_hash TEXT NOT NULL,
        params_json TEXT,
        PRIMARY KEY (taken_at, pool_id)
    )`;
    await db`INSERT OR REPLACE INTO epoch_pool_params (taken_at, pool_id, vrf_key_hash, params_json)
        SELECT ${takenAt}, pool_id, vrf_key_hash, params_json FROM pool_params`;
    await db`DROP TABLE IF EXISTS tmp_deleg_hex`;
    // The ledger keeps three snapshots (mark / set / go); the per-credential rows
    // follow that. The per-pool totals are kept for every epoch (small) so headers
    // replayed by a lagging verifier peer can still be checked against their epoch.
    await db`DELETE FROM epoch_stake_cred WHERE taken_at < ${takenAt - 3}`;
    await db`DELETE FROM epoch_pool_params WHERE taken_at < ${takenAt - 3}`;
    const tot = (await db`SELECT COALESCE(SUM(stake), 0), COUNT(*) FROM epoch_pool_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    const total = BigInt(String(tot[0]?.[0] ?? 0));
    const pools = Number(tot[0]?.[1] ?? 0);
    await db`INSERT OR REPLACE INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (${takenAt}, ${total.toString()}, ${pools})`;
    return { pools, total };
}

export interface PoolStakeDistribution {
    takenAt: number;
    total: bigint;
    stake: Map<string, bigint>;
}

/** The distribution that decides leaders in `epoch` (snapshot taken at the start of epoch − 1), or null if absent. */
/**
 * Boundary diagnostic: registered pools that have delegations but no stake in the
 * snapshot just taken. Preprod boundaries 30 and 32 each lost one pool this way
 * (registered and retired within the epoch); the cause is still open.
 */
export async function poolsMissingFromSnapshot(takenAt: number): Promise<Array<{ poolId: string; retiringEpoch: number | null; delegators: number }>> {
    const rows = (await sql`
        SELECT p.pool_id, p.retiring_epoch, COUNT(d.id) FROM pool_params p
        JOIN delegations d ON lower(hex(d.pool_key_hash)) = p.pool_id
        WHERE NOT EXISTS (SELECT 1 FROM epoch_pool_stake s WHERE s.taken_at = ${takenAt} AND s.pool_id = p.pool_id)
          AND EXISTS (SELECT 1 FROM utxo u WHERE u.stake_key = CASE WHEN d.cred_type = 1 THEN '01' ELSE '' END || lower(hex(d.stake_credentials)) AND u.lovelace > 0)
        GROUP BY p.pool_id`.values()) as unknown[][];
    return rows.map((r) => ({ poolId: String(r[0]), retiringEpoch: r[1] == null ? null : Number(r[1]), delegators: Number(r[2]) }));
}

/**
 * Move-instantaneous-rewards certificates (pre-Conway, type 6). They are queued
 * when applied and take effect at the next epoch boundary, after the reward
 * update and before the snapshot (NEWEPOCH: applyRUpd → MIR → SNAP):
 *  - to accounts: the pot is debited by the sum credited to *registered*
 *    accounts; a pot whose queued total exceeds its balance pays nothing;
 *  - to the other pot (Alonzo+): reserves ⇄ treasury by the amount.
 */
export async function ensureMirTable(db: SqlClient): Promise<void> {
    await db`CREATE TABLE IF NOT EXISTS mir_pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_epoch INTEGER NOT NULL,
        source INTEGER NOT NULL,
        stake_key TEXT,
        amount TEXT NOT NULL
    )`;
}

export async function queueMir(db: SqlClient, recordedEpoch: number, source: number, entries: Array<{ stakeKey: string | null; amount: bigint }>): Promise<void> {
    await ensureMirTable(db);
    for (const e of entries) {
        await db`INSERT INTO mir_pending (recorded_epoch, source, stake_key, amount) VALUES (${recordedEpoch}, ${source}, ${e.stakeKey}, ${e.amount.toString()})`;
    }
}

export async function applyPendingMir(db: SqlClient, epoch: number): Promise<{ credited: bigint; transferred: bigint; dropped: number }> {
    await ensureMirTable(db);
    const rows = (await db`SELECT id, source, stake_key, amount FROM mir_pending WHERE recorded_epoch < ${epoch} ORDER BY id`.values()) as unknown[][];
    const out = { credited: 0n, transferred: 0n, dropped: 0 };
    if (!rows.length) return out;
    const pots = await readRewardPots();
    const registered = await registeredStakeKeys();
    let reserves = pots?.reserves ?? 0n, treasury = pots?.treasury ?? 0n;
    for (const source of [0, 1]) {
        const mine = rows.filter((r) => Number(r[1]) === source);
        if (!mine.length) continue;
        // per credential net amount (later certificates may lower an earlier credit)
        const perCred = new Map<string, bigint>();
        let transfer = 0n;
        for (const r of mine) {
            const amt = BigInt(String(r[3]));
            if (r[2] == null) transfer += amt;
            else perCred.set(String(r[2]), (perCred.get(String(r[2])) ?? 0n) + amt);
        }
        const credit = new Map<string, bigint>();
        let total = 0n;
        for (const [k, v] of perCred) {
            if (v <= 0n || !registered.has(k)) continue;
            credit.set(k, v);
            total += v;
        }
        // Checked against the pots as they stood at the boundary (the transfers of this
        // epoch are applied together, not one after the other).
        const balance = source === 0 ? (pots?.reserves ?? 0n) : (pots?.treasury ?? 0n);
        if (total + transfer > balance) {
            out.dropped += mine.length;
            continue;
        }
        if (credit.size) await creditRewards(db, credit);
        if (source === 0) { reserves -= total + transfer; treasury += transfer; }
        else { treasury -= total + transfer; reserves += transfer; }
        out.credited += total;
        out.transferred += transfer;
    }
    if (pots) await updateRewardPots(db, { reserves: reserves - pots.reserves, treasury: treasury - pots.treasury, resetFees: false });
    await db`DELETE FROM mir_pending WHERE recorded_epoch < ${epoch}`;
    return out;
}

export async function poolStakeForEpoch(epoch: number): Promise<PoolStakeDistribution | null> {
    const takenAt = epoch - 1;
    const tot = (await sql`SELECT total_active FROM epoch_stake_totals WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (!tot.length) return null;
    const rows = (await sql`SELECT pool_id, stake FROM epoch_pool_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    const stake = new Map<string, bigint>();
    for (const r of rows) stake.set(String(r[0]), BigInt(String(r[1])));
    return { takenAt, total: BigInt(String(tot[0]![0])), stake };
}

export async function latestSnapshotEpoch(): Promise<number | null> {
    const rows = (await sql`SELECT MAX(taken_at) FROM epoch_stake_totals`.values()) as unknown[][];
    return rows[0]?.[0] == null ? null : Number(rows[0][0]);
}

export interface RewardPots {
    reserves: bigint;
    treasury: bigint;
    feePot: bigint;
    initializedEpoch: number;
}

export async function readRewardPots(): Promise<RewardPots | null> {
    const rows = (await sql`SELECT reserves, treasury, fee_pot, initialized_epoch FROM reward_pots WHERE id = 1`.values()) as unknown[][];
    if (!rows.length) return null;
    return { reserves: BigInt(String(rows[0]![0])), treasury: BigInt(String(rows[0]![1])), feePot: BigInt(String(rows[0]![2])), initializedEpoch: Number(rows[0]![3]) };
}

/** Reserves = max supply − everything in the UTxO set at the first Shelley boundary; treasury and fees start at 0. */
export async function initRewardPots(db: SqlClient, epoch: number, maxSupply: bigint): Promise<RewardPots> {
    const existing = await readRewardPots();
    if (existing) return existing;
    const rows = (await db`SELECT COALESCE(SUM(lovelace), 0) FROM utxo`.values()) as unknown[][];
    const circulating = BigInt(String(rows[0]?.[0] ?? 0));
    const reserves = maxSupply - circulating;
    await db`INSERT INTO reward_pots (id, reserves, treasury, fee_pot, initialized_epoch) VALUES (1, ${reserves.toString()}, 0, 0, ${epoch})`;
    return { reserves, treasury: 0n, feePot: 0n, initializedEpoch: epoch };
}

export async function addFeeToPot(db: SqlClient, fee: bigint): Promise<void> {
    await db`UPDATE reward_pots SET fee_pot = fee_pot + ${fee.toString()} WHERE id = 1`;
}

/**
 * Treasury donations (Conway tx body field 22) accumulate during the epoch and join the
 * treasury at the boundary (Conway EPOCH: `treasury = treasury − withdrawals + donations +
 * unclaimed`). Bug 92: they were checked for value conservation and then dropped.
 */
export async function addDonationToPot(db: SqlClient, amount: bigint): Promise<void> {
    if (amount <= 0n) return;
    await db`UPDATE reward_pots SET donation_pot = donation_pot + ${amount.toString()} WHERE id = 1`;
}

/** Move the epoch's donations into the treasury; returns the amount moved. */
export async function settleDonations(db: SqlClient): Promise<bigint> {
    const rows = (await db`SELECT donation_pot FROM reward_pots WHERE id = 1`.values()) as unknown[][];
    const donated = BigInt(String(rows[0]?.[0] ?? 0));
    if (donated > 0n) await db`UPDATE reward_pots SET treasury = treasury + ${donated.toString()}, donation_pot = 0 WHERE id = 1`;
    return donated;
}

export async function updateRewardPots(db: SqlClient, delta: { reserves: bigint; treasury: bigint; resetFees: boolean }): Promise<void> {
    if (delta.resetFees) await db`UPDATE reward_pots SET reserves = reserves + ${delta.reserves.toString()}, treasury = treasury + ${delta.treasury.toString()}, fee_pot = 0 WHERE id = 1`;
    else await db`UPDATE reward_pots SET reserves = reserves + ${delta.reserves.toString()}, treasury = treasury + ${delta.treasury.toString()} WHERE id = 1`;
}

export async function stakeSnapshotMembers(takenAt: number): Promise<Map<string, Array<{ credential: string; stake: bigint }>>> {
    const rows = (await sql`SELECT pool_id, stake_key, stake FROM epoch_stake_cred WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    const out = new Map<string, Array<{ credential: string; stake: bigint }>>();
    for (const r of rows) {
        const pool = String(r[0]);
        let list = out.get(pool);
        if (!list) { list = []; out.set(pool, list); }
        list.push({ credential: String(r[1]), stake: BigInt(String(r[2])) });
    }
    return out;
}

/** Stake credentials currently registered (their reward accounts can receive rewards). */
export async function registeredStakeKeys(): Promise<Set<string>> {
    const rows = (await sql`SELECT lower(hex(stake_credentials)), cred_type FROM stake`.values()) as unknown[][];
    const out = new Set<string>();
    for (const r of rows) {
        const hex = String(r[0]);
        const type = r[1] == null ? null : Number(r[1]);
        if (type === 1) out.add(`01${hex}`);
        else {
            out.add(hex);
            if (type == null) out.add(`01${hex}`); // untyped legacy row: could be either
        }
    }
    return out;
}

export async function queuePendingRewards(db: SqlClient, payAt: number, paid: Map<string, bigint>): Promise<void> {
    for (const [cred, amount] of paid) {
        if (amount <= 0n) continue;
        await db`INSERT INTO pending_rewards (pay_at, stake_key, amount) VALUES (${payAt}, ${cred}, ${amount.toString()})
            ON CONFLICT(pay_at, stake_key) DO UPDATE SET amount = amount + excluded.amount`;
    }
}

/** Pay the rewards queued for `epoch` into the reward accounts; returns accounts paid and total. */
export async function payPendingRewards(db: SqlClient, epoch: number): Promise<{ accounts: number; total: bigint }> {
    const rows = (await db`SELECT stake_key, amount FROM pending_rewards WHERE pay_at = ${epoch}`.values()) as unknown[][];
    let total = 0n;
    for (const r of rows) {
        const cred = Buffer.from(String(r[0]), "hex");
        const amount = BigInt(String(r[1]));
        total += amount;
        const has = (await db`SELECT 1 FROM rewards WHERE stake_credentials = ${cred}`.values()) as unknown[][];
        if (has.length) await db`UPDATE rewards SET amount = amount + ${amount.toString()} WHERE stake_credentials = ${cred}`;
        else await db`INSERT INTO rewards (stake_credentials, amount) VALUES (${cred}, ${amount.toString()})`;
    }
    await db`DELETE FROM pending_rewards WHERE pay_at = ${epoch}`;
    return { accounts: rows.length, total };
}

export async function recordRewardEpoch(db: SqlClient, performanceEpoch: number, r: { rewardPot: bigint; treasuryDelta: bigint; paid: bigint; unclaimed: bigint; pools: number; accounts: number }): Promise<void> {
    await db`INSERT OR REPLACE INTO reward_epochs (performance_epoch, reward_pot, treasury_delta, paid, unclaimed, pools, accounts)
        VALUES (${performanceEpoch}, ${r.rewardPot.toString()}, ${r.treasuryDelta.toString()}, ${r.paid.toString()}, ${r.unclaimed.toString()}, ${r.pools}, ${r.accounts})`;
}

/** Credit lovelace to reward accounts now (treasury withdrawals, deposit refunds). */
/** Rows per statement when a payout is written as one JSON-driven upsert (53 k accounts per preview boundary). */
const REWARD_BATCH = 8192;

export async function creditRewards(db: SqlClient, amounts: Map<string, bigint>): Promise<bigint> {
    let total = 0n;
    const entries: Array<[string, string]> = [];
    for (const [credHex, amount] of amounts) {
        if (amount <= 0n) continue;
        entries.push([credHex.toLowerCase(), amount.toString()]);
        total += amount;
    }
    // One upsert per batch instead of a SELECT + UPDATE/INSERT per account (which also
    // scanned the table before idx_rewards_stake_credentials existed): 160 s → well under a
    // second for a preview boundary. Amounts stay within SQLite's 64-bit integers.
    for (let i = 0; i < entries.length; i += REWARD_BATCH) {
        const json = JSON.stringify(Object.fromEntries(entries.slice(i, i + REWARD_BATCH)));
        await db`INSERT INTO rewards (stake_credentials, amount)
            SELECT unhex(j.key), CAST(j.value AS INTEGER) FROM json_each(${json}) AS j WHERE true
            ON CONFLICT(stake_credentials) DO UPDATE SET amount = amount + excluded.amount`; // WHERE true: SQLite would read ON as a join clause
    }
    return total;
}

/** Reserves at the start of `epoch` and the fees collected during `epoch − 1` (recorded at the boundary into `epoch`). */
export async function ensurePotSnapshotsTable(db: SqlClient): Promise<void> {
    await db`CREATE TABLE IF NOT EXISTS pot_snapshots (
        epoch INTEGER PRIMARY KEY,
        reserves TEXT NOT NULL,
        treasury TEXT NOT NULL,
        fees_collected TEXT NOT NULL
    )`;
}

export async function recordPotSnapshot(db: SqlClient, epoch: number, pots: { reserves: bigint; treasury: bigint; feesCollected: bigint }): Promise<void> {
    await db`INSERT OR REPLACE INTO pot_snapshots (epoch, reserves, treasury, fees_collected)
        VALUES (${epoch}, ${pots.reserves.toString()}, ${pots.treasury.toString()}, ${pots.feesCollected.toString()})`;
}

/**
 * The reserves/treasury a later reward update reads for this epoch are the pots
 * *after* the whole boundary (reward update, MIR, POOLREAP refunds), not the
 * values right after the reward update: mainnet's epoch-210 update used the
 * pre-MIR reserves and came out 356·10⁹ high on the treasury. Called at the end
 * of the boundary; keeps the fee figure recorded by the reward update.
 */
export async function refreshPotSnapshot(db: SqlClient, epoch: number): Promise<void> {
    const pots = await readRewardPots();
    if (!pots) return;
    await db`UPDATE pot_snapshots SET reserves = ${pots.reserves.toString()}, treasury = ${pots.treasury.toString()} WHERE epoch = ${epoch}`;
}

export async function readPotSnapshot(epoch: number): Promise<{ reserves: bigint; treasury: bigint; feesCollected: bigint } | null> {
    const rows = (await sql`SELECT reserves, treasury, fees_collected FROM pot_snapshots WHERE epoch = ${epoch}`.values()) as unknown[][];
    if (!rows.length) return null;
    return { reserves: BigInt(String(rows[0]![0])), treasury: BigInt(String(rows[0]![1])), feesCollected: BigInt(String(rows[0]![2])) };
}

/** Per-account reward payouts by performance epoch, for verification against a reference. */
export async function recordRewardPayouts(db: SqlClient, performanceEpoch: number, paid: Map<string, bigint>): Promise<void> {
    await db`CREATE TABLE IF NOT EXISTS reward_payouts (
        performance_epoch INTEGER NOT NULL,
        stake_key TEXT NOT NULL,
        amount TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'total',
        pool_id TEXT,
        PRIMARY KEY (performance_epoch, stake_key)
    )`;
    const entries: Array<[string, string]> = [];
    for (const [cred, amount] of paid) if (amount > 0n) entries.push([cred, amount.toString()]);
    for (let i = 0; i < entries.length; i += REWARD_BATCH) {
        const json = JSON.stringify(Object.fromEntries(entries.slice(i, i + REWARD_BATCH)));
        await db`INSERT OR REPLACE INTO reward_payouts (performance_epoch, stake_key, amount, kind, pool_id)
            SELECT ${performanceEpoch}, j.key, j.value, 'total', NULL FROM json_each(${json}) AS j`;
    }
}

/** Per-pool reward breakdown by performance epoch, for verification against a reference. */
export async function recordPoolRewards(db: SqlClient, performanceEpoch: number, pools: Array<{ poolId: string; maxPool: bigint; poolReward: bigint; operator: bigint; members: bigint; ownerStake: bigint; stake: bigint; blocks: bigint }>): Promise<void> {
    await db`CREATE TABLE IF NOT EXISTS reward_pool_epochs (
        performance_epoch INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        max_pool TEXT NOT NULL,
        pool_reward TEXT NOT NULL,
        operator TEXT NOT NULL,
        members TEXT NOT NULL,
        owner_stake TEXT NOT NULL,
        stake TEXT NOT NULL,
        blocks INTEGER NOT NULL,
        PRIMARY KEY (performance_epoch, pool_id)
    )`;
    for (const p of pools) {
        await db`INSERT OR REPLACE INTO reward_pool_epochs (performance_epoch, pool_id, max_pool, pool_reward, operator, members, owner_stake, stake, blocks)
            VALUES (${performanceEpoch}, ${p.poolId}, ${p.maxPool.toString()}, ${p.poolReward.toString()}, ${p.operator.toString()}, ${p.members.toString()}, ${p.ownerStake.toString()}, ${p.stake.toString()}, ${Number(p.blocks)})`;
    }
}

/** Pool parameters as they were at the snapshot `takenAt` (falls back to the current table for older DBs). */
export async function poolParamsAt(takenAt: number): Promise<Map<string, { vrf: string; params: PoolRewardParams | null }>> {
    const rows = (await sql`SELECT pool_id, vrf_key_hash, params_json FROM epoch_pool_params WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (!rows.length) return registeredPoolParams();
    const out = new Map<string, { vrf: string; params: PoolRewardParams | null }>();
    for (const r of rows) {
        let params: PoolRewardParams | null = null;
        try {
            params = r[2] == null ? null : (JSON.parse(String(r[2])) as PoolRewardParams);
        } catch {
            params = null;
        }
        out.set(String(r[0]), { vrf: String(r[1]), params });
    }
    return out;
}
