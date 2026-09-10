/**
 * Snapshot bootstrap phase C: a decoded `NewEpochState` (nesDecoder.ts) → the ledger tables of a
 * database with our schema, so that block application and the epoch-boundary code continue from
 * the snapshot slot exactly as after a genesis replay (docs/PLAN_SNAPSHOT_BOOTSTRAP.md, "The
 * importer"). The UTxO set comes from `importUtxo.ts`, the blocks from `mithril-bootstrap`.
 *
 * What each table gets (E = the snapshot's epoch, S = its slot):
 *   rewards / stake / delegations / gov_drep_delegations ← the unified map
 *   pool_params (+ retiring_epoch), pool_params_pending ← PState
 *   epoch_stake_cred / epoch_pool_stake / epoch_stake_totals / epoch_pool_params for
 *     taken_at ∈ {E (mark), E−1 (set), E−2 (go)} ← the three snapshots
 *   blocks_made_by_epoch for E−1 and E ← nesBprev / nesBcur
 *   reward_pots ← treasury, reserves; fee_pot = utxosFees − the frozen snapshot fee (the node
 *     keeps the previous epoch's fees in the pot until its reward update is applied)
 *   pot_snapshots[E] ← the pots after the boundary into E and the frozen fee
 *   epoch_params[E], [E−1] ← current / previous parameters
 *   epoch_nonces[E] ← Praos nonces at S, with start_slot = S so the evolver replays only later headers
 *   opcert_counters ← Praos counters (slot = S)
 *   gov_dreps (expiry as stored by the ledger) / gov_committee / gov_committee_auth / gov_state
 *     (pending = the completed pulser's ratification) / gov_proposals / gov_votes ← GovState
 *   epoch_drep_stake[E] ← the pulser's DRep distribution
 *   genesis_delegs ← genesis delegations; schema_migrations ← the one-off repair markers
 * Not imported: the pulsing reward update (recomputed by our reward code at the next boundary),
 * non-myopic likelihoods (unused), stashed AVVM addresses (mainnet only; refused for now).
 */
import { Database } from "bun:sqlite";
import { paramChangesOfUpdateMap } from "../consensus/governance/costModelUpdate";
import { conwayPParamsToRaw, typedHex, type Cred, type DRep, type GovAction, type LedgerSnapshot, type PoolState, type SnapshotPool, type StakeSnapshot } from "./nesDecoder";

export interface ImportStateOptions {
    dbPath: string;
    snapshot: LedgerSnapshot;
    /** From the artifact's ancillary metadata (informational; recorded in the log). */
    nodeVersion?: string | null;
    log?: (msg: string) => void;
}

export interface ImportStateResult {
    counts: Record<string, number>;
    feePot: bigint;
    warnings: string[];
    seconds: number;
}

const MIGRATION_MARKERS = ["stake_cred_types_rebuilt", "delegations_rebuilt_poolreap", "utxo_byron_addresses_rebuilt", "orphaned_utxo_deltas_reverted", "stake_pointers_built", "utxo_stake_key_typed"];

function credBytes(c: Cred): Uint8Array { return Buffer.from(c.hash, "hex"); }
function typedCredBytes(c: Cred): Uint8Array { return Buffer.from(typedHex(c), "hex"); }
function poolParamsJson(p: { pledge: bigint; cost: bigint; marginNum: bigint; marginDen: bigint; rewardAccount: Cred; owners: string[] }): string {
    return JSON.stringify({ pledge: String(p.pledge), cost: String(p.cost), marginNum: String(p.marginNum), marginDen: String(p.marginDen), rewardAccount: typedHex(p.rewardAccount), owners: p.owners });
}
/**
 * The node's snapshot record keeps only the owners delegated to the pool (the ones whose stake
 * counts toward the pledge), which is reward-equivalent; the replay's rows carry every owner of
 * the registration. When the current registration is otherwise the same, restore the full list.
 */
function withAllOwners(p: SnapshotPool, current: PoolState | undefined): SnapshotPool {
    if (!current || current.vrf !== p.vrf || current.pledge !== p.pledge || current.cost !== p.cost || current.marginNum * p.marginDen !== p.marginNum * current.marginDen
        || typedHex(current.rewardAccount) !== typedHex(p.rewardAccount) || !p.owners.every((o) => current.owners.includes(o))) return p;
    return { ...p, owners: current.owners };
}
function drepColumns(d: DRep): { type: number; hash: string | null } {
    return d.kind <= 1 ? { type: d.kind, hash: (d as { hash: string }).hash } : { type: d.kind, hash: null };
}
function payloadOf(a: GovAction): Record<string, unknown> {
    switch (a.kind) {
        case "ParameterChange": return { changes: paramChangesOfUpdateMap(a.update), policy: a.policy ?? null };
        case "InitHardFork": return { major: a.protocolVersion!.major, minor: a.protocolVersion!.minor };
        case "TreasuryWithdrawals": return { withdrawals: a.withdrawals!.map((w) => ({ account: typedHex(w.account), amount: String(w.amount) })), policy: a.policy ?? null };
        case "UpdateCommittee": return { remove: a.remove!.map((c) => c.hash), add: a.add!.map((e) => ({ cred: e.cred.hash, expires: e.expires })), thresholdNum: String(a.threshold!.num), thresholdDen: String(a.threshold!.den) };
        case "NewConstitution": return { hash: a.constitution!.anchor.hash, script: a.constitution!.script };
        default: return {};
    }
}

/** Tables the block applier fills lazily; created here so a fresh database accepts the rows. */
const LAZY_TABLES = [
    `CREATE TABLE IF NOT EXISTS epoch_params (epoch INTEGER PRIMARY KEY, params TEXT NOT NULL, source TEXT, fetched_at INTEGER DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS pot_snapshots (epoch INTEGER PRIMARY KEY, reserves TEXT NOT NULL, treasury TEXT NOT NULL, fees_collected TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS mir_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_epoch INTEGER NOT NULL, source INTEGER NOT NULL, stake_key TEXT, amount TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pool_params_pending (pool_id TEXT PRIMARY KEY, vrf_key_hash TEXT NOT NULL, registered_slot INTEGER NOT NULL, params_json TEXT)`,
    `CREATE TABLE IF NOT EXISTS epoch_pool_params (taken_at INTEGER NOT NULL, pool_id TEXT NOT NULL, vrf_key_hash TEXT NOT NULL, params_json TEXT, PRIMARY KEY (taken_at, pool_id))`,
    `CREATE TABLE IF NOT EXISTS genesis_delegs (genesis_key_hash TEXT NOT NULL, delegate_hash TEXT NOT NULL, vrf_key_hash TEXT NOT NULL, effective_slot INTEGER NOT NULL, PRIMARY KEY (genesis_key_hash, effective_slot))`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
];
const NONCE_COLUMNS: Array<[string, string]> = [["start_evolving_hex", "TEXT"], ["start_candidate_hex", "TEXT"], ["start_slot", "INTEGER"], ["start_lab_hex", "TEXT"]];

export function importLedgerState(opts: ImportStateOptions): ImportStateResult {
    const t0 = performance.now();
    const s = opts.snapshot;
    const log = opts.log ?? (() => {});
    const warnings: string[] = [];
    const counts: Record<string, number> = {};
    const E = s.epoch, S = s.slot;
    if (s.stashedAvvm) throw new Error("import-state: stashed AVVM addresses present (mainnet Byron-era state) — not supported yet");
    if (!s.irwdEmpty) throw new Error("import-state: pending MIR transfers present — not supported in Conway");
    if (opts.nodeVersion && !/^11\.0\./.test(opts.nodeVersion)) warnings.push(`snapshot written by cardano-node ${opts.nodeVersion}; the decoder is pinned to 11.0.x`);

    // Deposit accounting cross-check (the node's total against what our tables will hold).
    let deposits = 0n;
    for (const u of s.umap) deposits += u.deposit;
    for (const p of s.pools.values()) deposits += p.deposit;
    for (const d of s.dreps) deposits += d.deposit;
    for (const p of s.gov.proposals) deposits += p.deposit;
    if (deposits !== s.deposited) warnings.push(`deposits: node ${s.deposited}, sum of the imported deposits ${deposits}`);

    const db = new Database(opts.dbPath); // exists: the CLI ran ensureInitialized on it
    try {
        db.exec("PRAGMA journal_mode = WAL");
        for (const ddl of LAZY_TABLES) db.exec(ddl);
        for (const [col, type] of NONCE_COLUMNS) { try { db.exec(`ALTER TABLE epoch_nonces ADD COLUMN ${col} ${type}`); } catch { /* exists */ } }
        try { db.exec(`ALTER TABLE gov_dreps ADD COLUMN expiry_epoch INTEGER`); } catch { /* exists */ }
        try { db.exec(`ALTER TABLE reward_pots ADD COLUMN donation_pot INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

        const run = db.transaction(() => {
            const count = (t: string, n: number) => { counts[t] = (counts[t] ?? 0) + n; };
            // ── accounts ──
            db.exec("DELETE FROM rewards; DELETE FROM stake; DELETE FROM delegations; DELETE FROM gov_drep_delegations; DELETE FROM stake_pointers; DELETE FROM mir_pending");
            const insReward = db.prepare("INSERT INTO rewards (stake_credentials, amount) VALUES (?, ?)");
            const insStake = db.prepare("INSERT INTO stake (stake_credentials, cred_type, amount) VALUES (?, ?, 0)");
            const insDeleg = db.prepare("INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (?, ?, ?)");
            const insVote = db.prepare("INSERT INTO gov_drep_delegations (stake_key, drep_type, drep_hash) VALUES (?, ?, ?)");
            for (const u of s.umap) {
                insReward.run(typedCredBytes(u.cred), u.reward);
                insStake.run(credBytes(u.cred), u.cred.type);
                count("rewards", 1); count("stake", 1);
                if (u.pool) { insDeleg.run(credBytes(u.cred), u.cred.type, Buffer.from(u.pool, "hex")); count("delegations", 1); }
                if (u.drep) { const d = drepColumns(u.drep); insVote.run(typedHex(u.cred), d.type, d.hash); count("gov_drep_delegations", 1); }
            }
            // ── pools ──
            db.exec("DELETE FROM pool_params; DELETE FROM pool_params_pending");
            const insPool = db.prepare("INSERT INTO pool_params (pool_id, vrf_key_hash, registered_slot, retiring_epoch, params_json) VALUES (?, ?, 0, ?, ?)");
            for (const [id, p] of s.pools) { insPool.run(id, p.vrf, s.retiring.get(id) ?? null, poolParamsJson(p)); count("pool_params", 1); }
            const insPending = db.prepare("INSERT INTO pool_params_pending (pool_id, vrf_key_hash, registered_slot, params_json) VALUES (?, ?, ?, ?)");
            for (const [id, p] of s.futurePools) { insPending.run(id, p.vrf, S, poolParamsJson(p)); count("pool_params_pending", 1); }
            for (const id of s.retiring.keys()) if (!s.pools.has(id)) warnings.push(`retiring pool ${id} is not registered`);
            // ── stake snapshots ──
            const snaps: Array<[number, StakeSnapshot]> = [[E, s.snapshots.mark], [E - 1, s.snapshots.set], [E - 2, s.snapshots.go]];
            const delSnap = (t: string) => db.prepare(`DELETE FROM ${t} WHERE taken_at = ?`);
            const dels = ["epoch_stake_cred", "epoch_pool_stake", "epoch_stake_totals", "epoch_pool_params"].map(delSnap);
            const insCred = db.prepare("INSERT INTO epoch_stake_cred (taken_at, stake_key, pool_id, stake) VALUES (?, ?, ?, ?)");
            const insPoolStake = db.prepare("INSERT INTO epoch_pool_stake (taken_at, pool_id, stake) VALUES (?, ?, ?)");
            const insTotals = db.prepare("INSERT INTO epoch_stake_totals (taken_at, total_active, pools) VALUES (?, ?, ?)");
            const insEpp = db.prepare("INSERT INTO epoch_pool_params (taken_at, pool_id, vrf_key_hash, params_json) VALUES (?, ?, ?, ?)");
            for (const [takenAt, snap] of snaps) {
                for (const d of dels) d.run(takenAt);
                const perPool = new Map<string, bigint>();
                let total = 0n;
                for (const [key, e] of snap.stake) {
                    insCred.run(takenAt, key, e.pool, e.stake);
                    perPool.set(e.pool, (perPool.get(e.pool) ?? 0n) + e.stake);
                    total += e.stake;
                }
                for (const [pool, st] of perPool) insPoolStake.run(takenAt, pool, st);
                insTotals.run(takenAt, String(total), perPool.size);
                for (const [id, p] of snap.pools) insEpp.run(takenAt, id, p.vrf, poolParamsJson(withAllOwners(p, s.pools.get(id))));
                count("epoch_stake_cred", snap.stake.size); count("epoch_pool_stake", perPool.size); count("epoch_pool_params", snap.pools.size);
                for (const [pool, p] of snap.pools) { const st = perPool.get(pool) ?? 0n; if (st !== p.stake) warnings.push(`snapshot ${takenAt}: pool ${pool.slice(0, 12)} stake ${p.stake} vs summed ${st}`); }
            }
            // ── blocks made, op-cert counters ──
            const delBlocks = db.prepare("DELETE FROM blocks_made_by_epoch WHERE epoch = ?");
            const insBlocks = db.prepare("INSERT INTO blocks_made_by_epoch (epoch, pool_id, blocks) VALUES (?, ?, ?)");
            for (const [epoch, m] of [[E - 1, s.blocksPrev], [E, s.blocksCur]] as Array<[number, Map<string, number>]>) {
                delBlocks.run(epoch);
                for (const [pool, n] of m) insBlocks.run(epoch, pool, n);
                count("blocks_made_by_epoch", m.size);
            }
            db.exec("DELETE FROM opcert_counters");
            const insOcert = db.prepare("INSERT INTO opcert_counters (pool_id, counter, slot) VALUES (?, ?, ?)");
            for (const [pool, c] of s.praos.ocertCounters) insOcert.run(pool, c, S);
            count("opcert_counters", s.praos.ocertCounters.size);
            // ── pots ──
            const feePot = s.fees - s.snapshots.fee;
            if (feePot < 0n) throw new Error(`import-state: fee pot ${s.fees} smaller than the frozen snapshot fee ${s.snapshots.fee}`);
            db.exec("DELETE FROM reward_pots");
            db.prepare("INSERT INTO reward_pots (id, reserves, treasury, fee_pot, initialized_epoch, donation_pot) VALUES (1, ?, ?, ?, ?, ?)").run(s.reserves, s.treasury, feePot, E, s.donation);
            db.prepare("INSERT OR REPLACE INTO pot_snapshots (epoch, reserves, treasury, fees_collected) VALUES (?, ?, ?, ?)").run(E, String(s.reserves), String(s.treasury), String(s.snapshots.fee));
            count("reward_pots", 1); count("pot_snapshots", 1);
            // ── parameters ──
            const insParams = db.prepare("INSERT OR REPLACE INTO epoch_params (epoch, params, source) VALUES (?, ?, 'local')");
            for (const [epoch, pp] of [[E, s.gov.curPParams], [E - 1, s.gov.prevPParams]] as const) {
                insParams.run(epoch, JSON.stringify({ ...conwayPParamsToRaw(pp), epoch, source: "local" }));
                count("epoch_params", 1);
            }
            if (s.gov.futurePParams.kind !== "none") warnings.push(`future parameters (${s.gov.futurePParams.kind}) present: our boundary derives them from the enacted proposals`);
            // ── nonces ──
            if (!s.praos.epochNonce || !s.praos.evolving || !s.praos.candidate) throw new Error("import-state: neutral Praos nonces");
            db.prepare("DELETE FROM epoch_nonces WHERE epoch IN (?, ?)").run(E, E - 1);
            db.prepare("INSERT INTO epoch_nonces (epoch, nonce_hex, source, evolving_hex, candidate_hex, start_evolving_hex, start_candidate_hex, start_slot, start_lab_hex) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?)")
                .run(E, s.praos.epochNonce, s.praos.evolving, s.praos.candidate, s.praos.evolving, s.praos.candidate, S, s.praos.lastEpochBlock);
            if (s.praos.previousEpochNonce) db.prepare("INSERT INTO epoch_nonces (epoch, nonce_hex, source) VALUES (?, ?, 'local')").run(E - 1, s.praos.previousEpochNonce);
            count("epoch_nonces", s.praos.previousEpochNonce ? 2 : 1);
            // ── governance ──
            const raw = conwayPParamsToRaw(s.gov.curPParams);
            const activity = Number(raw.drep_activity ?? 20);
            db.exec("DELETE FROM gov_dreps; DELETE FROM gov_committee; DELETE FROM gov_committee_auth; DELETE FROM gov_state; DELETE FROM gov_proposals; DELETE FROM gov_votes");
            const insDrep = db.prepare("INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (?, ?, ?, 0, ?, ?)");
            for (const d of s.dreps) insDrep.run(d.cred.hash, d.cred.type, d.deposit, d.expiry - activity, d.expiry);
            count("gov_dreps", s.dreps.length);
            const hotOf = (coldTyped: string): { hot: string | null; resigned: number } => {
                const a = s.committeeState.get(coldTyped);
                if (!a) return { hot: null, resigned: 0 };
                return "hot" in a ? { hot: a.hot.hash, resigned: 0 } : { hot: null, resigned: 1 };
            };
            const insMember = db.prepare("INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (?, ?, ?, ?)");
            if (s.gov.committee) for (const [cold, expiry] of s.gov.committee.members) { const h = hotOf(cold); insMember.run(cold.replace(/^01/, "").slice(-56), expiry, h.hot, h.resigned); count("gov_committee", 1); }
            const insAuth = db.prepare("INSERT INTO gov_committee_auth (cold_credential, hot_credential, resigned) VALUES (?, ?, ?)");
            for (const [cold, a] of s.committeeState) { insAuth.run(cold.slice(-56), "hot" in a ? a.hot.hash : null, "hot" in a ? 0 : 1); count("gov_committee_auth", 1); }
            const pending = { epoch: E, ratified: s.gov.pulsing.enacted, expired: s.gov.pulsing.expired };
            db.prepare("INSERT INTO gov_state (id, committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, prev_pparams, prev_hardfork, prev_committee, prev_constitution, seeded_epoch, dormant_epochs, pending) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(String(s.gov.committee?.thresholdNum ?? 0n), String(s.gov.committee?.thresholdDen ?? 1n), s.gov.constitution.anchor.hash, s.gov.constitution.script, s.gov.committee ? 0 : 1,
                    s.gov.roots.pparams, s.gov.roots.hardFork, s.gov.roots.committee, s.gov.roots.constitution, E, s.dormantEpochs, JSON.stringify(pending));
            count("gov_state", 1);
            const ratified = new Set(s.gov.pulsing.enacted);
            const insProposal = db.prepare("INSERT INTO gov_proposals (action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status, decided_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            const insVoteRow = db.prepare("INSERT INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES (?, ?, ?, ?, ?)");
            s.gov.proposals.forEach((p, i) => {
                const isRatified = ratified.has(p.id);
                insProposal.run(p.id, i + 1, p.action.kind, p.action.prev, p.deposit, typedHex(p.returnAccount), JSON.stringify(payloadOf(p.action)), p.proposedIn, p.expiresAfter, isRatified ? "ratified" : "active", isRatified ? E : null);
                count("gov_proposals", 1);
                for (const [cred, v] of p.ccVotes) { insVoteRow.run(p.id, cred.length > 56 ? 1 : 0, cred.slice(-56), v, S); count("gov_votes", 1); }
                for (const [cred, v] of p.drepVotes) { insVoteRow.run(p.id, cred.length > 56 ? 3 : 2, cred.slice(-56), v, S); count("gov_votes", 1); }
                for (const [pool, v] of p.spoVotes) { insVoteRow.run(p.id, 4, pool, v, S); count("gov_votes", 1); }
            });
            for (const id of s.gov.pulsing.enacted) if (!s.gov.proposals.some((p) => p.id === id)) warnings.push(`ratified action ${id} is not among the live proposals`);
            db.prepare("DELETE FROM epoch_drep_stake WHERE taken_at = ?").run(E);
            const insDrepStake = db.prepare("INSERT INTO epoch_drep_stake (taken_at, drep_type, drep_hash, stake) VALUES (?, ?, ?, ?)");
            for (const [key, st] of s.gov.pulsing.drepDistr) { const [t, h] = key.split(":"); insDrepStake.run(E, Number(t), h ?? "", String(st)); count("epoch_drep_stake", 1); }
            // ── genesis delegations, markers ──
            db.exec("DELETE FROM genesis_delegs");
            const insGen = db.prepare("INSERT INTO genesis_delegs (genesis_key_hash, delegate_hash, vrf_key_hash, effective_slot) VALUES (?, ?, ?, 0)");
            for (const [g, d] of s.genDelegs) insGen.run(g, d.delegate, d.vrf);
            count("genesis_delegs", s.genDelegs.size);
            const insMarker = db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)");
            for (const m of MIGRATION_MARKERS) insMarker.run(m);
            return feePot;
        });
        const feePot = run();
        log(`import-state: epoch ${E} slot ${S} block ${s.blockNo} ${s.blockHash.slice(0, 12)}…: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; fee pot ${feePot}`);
        for (const w of warnings) log(`import-state: warning: ${w}`);
        return { counts, feePot, warnings, seconds: (performance.now() - t0) / 1000 };
    } finally {
        db.close();
    }
}
