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
import { type ActionKind } from "./tally";
import { getLedgerStore, ledgerGov, ledgerGovReads, ledgerStake, ledgerStakeReads, sqlLedgerWrites } from "../../ledger/nodeLedgerStore";
import { primaryBlockStore } from "../../storage/nodeBlockStore";
import { snapshotAtBoundary, storePulserSnapshot } from "./govPulser";
import type { ProposalRow as StoreProposalRow } from "../../ledger/govStore";
import { ccCredsOf, ccKey, drepCredOfRow, loadCommitteeView, loadLiveProposals, payloadCcAdd, payloadCcRemove } from "./govLedgerView";
import { ratifyRound, type ProposalTally, type Purpose } from "./ratify";
import { gatherRatifyInput, ratifyProposalOf } from "./ratifyInputs";
import { typedOf } from "./govTxDecode";

/** A stored proposal in the shape this module works with (payload parsed, deposit as bigint). */
function fromStoreProposal(p: StoreProposalRow): ProposalRow {
    return { action_id: p.actionId, seq: p.seq, kind: p.kind as ActionKind, prev_action_id: p.prevActionId, deposit: BigInt(p.deposit), return_account: p.returnAccount, payload: JSON.parse(p.payload), proposed_epoch: p.proposedEpoch, expires_epoch: p.expiresEpoch };
}

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
    // Protocol-9 reverse delegations (the DRep's `drepDelegs`), kept until the protocol-10 hard fork (bug 165).
    await sql`CREATE TABLE IF NOT EXISTS gov_drep_boot_delegs (
        drep_key TEXT NOT NULL,       -- typed DRep credential
        stake_key TEXT NOT NULL,      -- typed stake credential
        PRIMARY KEY (drep_key, stake_key)
    )`;
    // The DRep pulser's frozen snapshot per epoch (bug 167), JSON of govStore.ts `PulserSnapshot`.
    await sql`CREATE TABLE IF NOT EXISTS gov_pulser_snapshot (epoch INTEGER PRIMARY KEY, snapshot TEXT NOT NULL)`;
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

/** Typed credential of a Conway genesis key (`keyHash-…` / `scriptHash-…`, as cardano-ledger's JSON `Credential`). */
export function genesisCred(k: string): string | null {
    const m = /^(keyHash|scriptHash)-([0-9a-fA-F]{56})$/.exec(String(k));
    if (m) return typedOf(m[1] === "scriptHash" ? 1 : 0, m[2]!);
    return /^[0-9a-fA-F]{56}$/.test(String(k)) ? String(k).toLowerCase() : null; // untyped (old test genesis files): a key hash
}

/**
 * Seed committee, constitution and thresholds from the Conway genesis once (idempotent). The
 * committee's cold credentials are typed from the genesis keys (bug 153: the `scriptHash-` prefix
 * was stripped and every member stored as a bare hash).
 *
 * `initialDReps` and `delegs` (bug 157): cardano-node injects them only into the initial ledger
 * state of a chain that starts in Conway (consensus `mkInitExtLedgerStateCardano` →
 * `injectIntoTestState` → `registerDRepsThenDelegs`), never on mainnet and never at a
 * Babbage→Conway translation (`translateEra` sets committee and constitution only). `fromGenesis`
 * says the chain starts in Conway; the delegations apply to registered stake credentials only
 * (`processDelegation` adjusts an existing account).
 */
export async function seedGovernance(db: SqlClient, conwayGenesis: any, epoch: number, opts: { chainStartsInConway?: boolean; mainnet?: boolean } = {}): Promise<void> {
    const gr = ledgerGovReads(), gw = ledgerGov();
    const rows = gr ? (gr.state() ? [[1]] : []) : (await db`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][];
    if (rows.length) return;
    const thr = conwayGenesis?.committee?.threshold ?? { numerator: 2, denominator: 3 };
    const cons = conwayGenesis?.constitution ?? {};
    const members: Array<[string, number]> = [];
    for (const [cred, expiry] of Object.entries(conwayGenesis?.committee?.members ?? {})) { const c = genesisCred(cred); if (c) members.push([ccKey(c), Number(expiry)]); }
    if (gw && !gw.reads.state()) {
        if (cons.anchor?.url && cons.anchor?.dataHash) gw.putConstitutionAnchor({ url: String(cons.anchor.url), hash: String(cons.anchor.dataHash).toLowerCase() });
        gw.putState({ thrNum: Number(thr.numerator ?? 2), thrDen: Number(thr.denominator ?? 3), constitutionHash: cons.anchor?.dataHash ?? null, constitutionScript: cons.script ?? null, noConfidence: 0, prevPP: null, prevHF: null, prevCC: null, prevCons: null, seededEpoch: epoch, dormantEpochs: 0, pending: null });
        for (const [c, expiry] of members) if (!gw.reads.committee().has(c)) gw.putCommittee(c, { expiresEpoch: expiry, hot: null, resigned: 0 });
    }
    if (sqlLedgerWrites()) await db`INSERT INTO gov_state (id, committee_threshold_num, committee_threshold_den, constitution_hash, constitution_script, no_confidence, seeded_epoch)
        VALUES (1, ${Number(thr.numerator ?? 2)}, ${Number(thr.denominator ?? 3)}, ${cons.anchor?.dataHash ?? null}, ${cons.script ?? null}, 0, ${epoch})`;
    for (const [c, expiry] of members) if (sqlLedgerWrites()) await db`INSERT OR IGNORE INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${c}, ${expiry}, NULL, 0)`;
    let dreps = 0, delegs = 0;
    if (opts.chainStartsInConway && !opts.mainnet) {
        for (const [k, st] of Object.entries(conwayGenesis?.initialDReps ?? {}) as Array<[string, any]>) {
            const c = genesisCred(k);
            if (!c) continue;
            const expiry = Number(st?.expiry ?? 0);
            const isScript = c.length === 58 ? 1 : 0;
            gw?.putDRep(c, { isScript, deposit: String(st?.deposit ?? 0), registeredSlot: 0, lastActiveEpoch: expiry - Number(conwayGenesis?.dRepActivity ?? 0), expiryEpoch: expiry });
            if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (${c}, ${isScript}, ${String(st?.deposit ?? 0)}, 0, ${expiry - Number(conwayGenesis?.dRepActivity ?? 0)}, ${expiry})`;
            dreps++;
        }
        for (const [k, d] of Object.entries(conwayGenesis?.delegs ?? {}) as Array<[string, any]>) {
            const c = genesisCred(k);
            const drep = parseGenesisDRep(d?.dRep);
            if (!c || !drep) continue;
            if (!(await stakeRegistered(c))) continue;
            ledgerGov()?.putDRepDelegation(c, drep);
            if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO gov_drep_delegations (stake_key, drep_type, drep_hash) VALUES (${c}, ${drep.type}, ${drep.hash})`;
            delegs++;
        }
    }
    logger.info(`Governance seeded from the Conway genesis: ${members.length} committee member(s), threshold ${thr.numerator}/${thr.denominator}${dreps || delegs ? `, ${dreps} initial DRep(s), ${delegs} vote delegation(s)` : ""}`);
}

/** A genesis `Delegatee`'s DRep (`drep-alwaysAbstain`, `drep-alwaysNoConfidence`, `drep-keyHash-…`, `drep-scriptHash-…`) as a delegation row. */
export function parseGenesisDRep(t: unknown): { type: number; hash: string | null } | null {
    if (typeof t !== "string") return null;
    if (t === "drep-alwaysAbstain") return { type: 2, hash: null };
    if (t === "drep-alwaysNoConfidence") return { type: 3, hash: null };
    const m = /^drep-(keyHash|scriptHash)-([0-9a-fA-F]{56})$/.exec(t);
    return m ? { type: m[1] === "scriptHash" ? 1 : 0, hash: m[2]!.toLowerCase() } : null;
}

async function stakeRegistered(typed: string): Promise<boolean> {
    const { ledgerStakeReads } = await import("../../ledger/nodeLedgerStore");
    const sr = ledgerStakeReads();
    if (sr) return sr.isRegistered(typed);
    const script = typed.length === 58, hash = script ? typed.slice(2) : typed;
    const r = (await sql`SELECT 1 FROM stake WHERE stake_credentials = ${Uint8Array.from(Buffer.from(hash, "hex"))} AND (cred_type IS NULL OR cred_type = ${script ? 1 : 0}) LIMIT 1`.values()) as unknown[][];
    return r.length > 0;
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
    const gr = ledgerGovReads();
    const dormant = gr ? Number(gr.state()?.dormantEpochs ?? 0) : Number(((await db`SELECT dormant_epochs FROM gov_state WHERE id = 1`.values()) as unknown[][])[0]?.[0] ?? 0);
    return epoch + activity - (registration && major < 10 ? 0 : dormant);
}

/** Typed credential (db/stakeCred.ts convention: hash, or "01" + hash for a script) of a ledger-ts DRep credential. */
function drepTyped(cred: any): string { return typedCredHexOf(cred) ?? hex(cred?.hash); }

/**
 * The stored row of a DRep (typed key; a row written before bug 153 is keyed by the bare hash and
 * identified by `is_script`): [storage key, row] or null.
 */
async function drepStored(db: SqlClient, typed: string): Promise<{ key: string; isScript: number; registeredSlot: number } | null> {
    const script = typed.length === 58, bare = script ? typed.slice(2) : typed;
    const gr = ledgerGovReads();
    if (gr) {
        const a = gr.drep(typed); if (a && (a.isScript ? 1 : 0) === (script ? 1 : 0)) return { key: typed, isScript: a.isScript, registeredSlot: a.registeredSlot };
        if (script) { const b = gr.drep(bare); if (b && b.isScript) return { key: bare, isScript: 1, registeredSlot: b.registeredSlot }; }
        return null;
    }
    const rows = (await db`SELECT credential, is_script, registered_slot FROM gov_dreps WHERE credential IN (${typed}, ${bare})`.values()) as unknown[][];
    const r = rows.find((x) => (Number(x[1]) ? 1 : 0) === (script ? 1 : 0));
    return r ? { key: String(r[0]), isScript: Number(r[1]), registeredSlot: Number(r[2]) } : null;
}

/** A DRep registration: keyed by the typed credential (bug 153: a script DRep and a key DRep with the same hash are two DReps). */
export async function recordDRepRegistration(db: SqlClient, cred: any, deposit: bigint, slot: number, epoch: number, expiryEpoch?: number): Promise<void> {
    const typed = drepTyped(cred);
    const isScript = typed.length === 58 ? 1 : 0;
    const expiry = expiryEpoch ?? (await drepExpiryFor(db, epoch, true));
    const cur = await drepStored(db, typed);
    if (!cur) await bootClear(db, typed); // a registration starts with no delegators (`drepDelegs = mempty`)
    const gw = ledgerGov();
    if (gw) { if (cur && cur.key !== typed) gw.delDRep(cur.key); gw.putDRep(typed, { isScript, deposit: deposit.toString(), registeredSlot: cur?.registeredSlot ?? slot, lastActiveEpoch: epoch, expiryEpoch: expiry }); }
    if (sqlLedgerWrites()) {
        if (cur && cur.key !== typed) await db`DELETE FROM gov_dreps WHERE credential = ${cur.key}`;
        await db`INSERT INTO gov_dreps (credential, is_script, deposit, registered_slot, last_active_epoch, expiry_epoch) VALUES (${typed}, ${isScript}, ${deposit.toString()}, ${cur?.registeredSlot ?? slot}, ${epoch}, ${expiry})
        ON CONFLICT(credential) DO UPDATE SET deposit = excluded.deposit, last_active_epoch = excluded.last_active_epoch, expiry_epoch = excluded.expiry_epoch`;
    }
}
/**
 * A DRep's unregistration also clears every vote delegation to it (cardano-ledger GOVCERT,
 * `ConwayUnRegDRep`: `clearDRepDelegations` over the DRep's delegator set, no protocol-version
 * guard). Bug 101: only the DRep row was dropped, so the delegations survived; when the DRep
 * registered again its old delegators counted for it without re-delegating (preview epoch 1415:
 * 1 339 registered credentials with a delegation the chain no longer has, 4.1 M ADA on one
 * re-registered DRep; found by the snapshot decoder against the node's unified map).
 * Bug 156: its votes go too — GOV removes an unregistering DRep's votes from every proposal
 * (`GovRemovedVotes`); ours stayed and counted again if the DRep registered anew before the vote's
 * action was decided.
 */
export async function recordDRepUnregistration(db: SqlClient, cred: any, epoch?: number): Promise<void> {
    const typed = drepTyped(cred);
    const isScript = typed.length === 58 ? 1 : 0;
    const h = isScript ? typed.slice(2) : typed;
    const cur = await drepStored(db, typed);
    const gw = ledgerGov();
    const live = await loadLiveProposals();
    // Protocol 9: the accounts of the DRep's reverse set lose their delegation, whatever it is now (bug 165);
    // from protocol 10 the set is exactly the accounts delegated to it.
    const boot = (await protocolMajorAt(epoch)) === 9 ? await bootMembers(db, typed) : null;
    if (gw) {
        if (cur) gw.delDRep(cur.key);
        if (boot) for (const a of boot) gw.delDRepDelegation(a); else gw.clearDelegationsTo(isScript, h);
        for (const p of live) gw.delVote(p.id, 2 + isScript, h);
    }
    if (sqlLedgerWrites()) {
        if (cur) await db`DELETE FROM gov_dreps WHERE credential = ${cur.key}`;
        if (boot) { for (const a of boot) await db`DELETE FROM gov_drep_delegations WHERE stake_key = ${a}`; }
        else await db`DELETE FROM gov_drep_delegations WHERE drep_type = ${isScript} AND drep_hash = ${h}`;
        for (const p of live) await db`DELETE FROM gov_votes WHERE action_id = ${p.id} AND voter_kind = ${2 + isScript} AND voter_hash = ${h}`;
    }
    if (boot) await bootClear(db, typed);
}
/** A DRep's vote or update certificate refreshes its expiry; `credHex` is the typed credential. */
export async function recordDRepActivity(db: SqlClient, credHex: string, epoch: number): Promise<void> {
    const expiry = await drepExpiryFor(db, epoch, false);
    const cur = await drepStored(db, credHex.toLowerCase());
    if (!cur) return;
    const gw = ledgerGov();
    if (gw) { const r = gw.reads.drep(cur.key); if (r) gw.putDRep(cur.key, { ...r, lastActiveEpoch: epoch, expiryEpoch: expiry }); }
    if (sqlLedgerWrites()) await db`UPDATE gov_dreps SET last_active_epoch = ${epoch}, expiry_epoch = ${expiry} WHERE credential = ${cur.key}`;
}

/** Credentials of the DReps whose expiry reaches `currentEpoch` (registered and not expired). */
export async function activeDRepCredentials(currentEpoch: number, drepActivity: number): Promise<Set<string>> {
    const gr = ledgerGovReads();
    if (gr) { const out = new Set<string>(); for (const [k, d] of gr.dreps()) if ((d.expiryEpoch ?? d.lastActiveEpoch + drepActivity) >= currentEpoch) out.add(drepCredOfRow(k, d.isScript)); return out; }
    const reg = (await sql`SELECT credential, is_script FROM gov_dreps WHERE COALESCE(expiry_epoch, last_active_epoch + ${drepActivity}) >= ${currentEpoch}`.values()) as unknown[][];
    return new Set(reg.map((r) => drepCredOfRow(String(r[0]), Number(r[1]))));
}
// ── protocol-9 reverse delegations (bug 165) ──
//
// cardano-ledger keeps, per DRep, the set of accounts delegated to it (`drepDelegs`) and clears their
// delegations when the DRep unregisters. In the bootstrap phase (protocol 9) a re-delegation from
// one DRep to another left the account in the old DRep's set (`preserveIncorrectDelegation`,
// cardano-ledger issue 4772), and a delegation to a DRep that was not registered was allowed and
// entered no set. So a protocol-9 unregistration cleared the delegation of every account in the set
// — whatever it delegated to by then — and none of the others. The protocol-10 hard fork rebuilt the
// sets from the accounts and dropped the delegations to unregistered DReps (`updateDRepDelegations`).
// Preview: account 0a047809… delegated to DRep fd160e2b…, then to 9b239a50…; fd160e2b… unregistered
// at epoch 724 and the chain cleared the account's delegation (NES at 1415/1420/1434: none), where
// ours kept 9b239a50…; acab7e49… likewise.

async function protocolMajorAt(epoch: number | undefined | null): Promise<number | null> {
    if (epoch == null || !Number.isFinite(epoch)) return null;
    const raw = await readEpochParamsRaw(epoch);
    return raw?.protocol_major_ver == null ? null : Number(raw.protocol_major_ver);
}
async function bootAdd(db: SqlClient, drep: string, stake: string): Promise<void> {
    ledgerGov()?.addBootDelegator(drep, stake);
    if (sqlLedgerWrites()) await db`INSERT OR IGNORE INTO gov_drep_boot_delegs (drep_key, stake_key) VALUES (${drep}, ${stake})`;
}
async function bootDel(db: SqlClient, drep: string, stake: string): Promise<void> {
    ledgerGov()?.delBootDelegator(drep, stake);
    if (sqlLedgerWrites()) await db`DELETE FROM gov_drep_boot_delegs WHERE drep_key = ${drep} AND stake_key = ${stake}`;
}
async function bootMembers(db: SqlClient, drep: string): Promise<string[]> {
    const gr = ledgerGovReads();
    if (gr) return gr.bootDelegators(drep);
    return ((await db`SELECT stake_key FROM gov_drep_boot_delegs WHERE drep_key = ${drep}`.values()) as unknown[][]).map((r) => String(r[0]));
}
async function bootClear(db: SqlClient, drep: string): Promise<void> {
    const gw = ledgerGov(); if (gw) gw.clearBootDelegators(drep);
    if (sqlLedgerWrites()) await db`DELETE FROM gov_drep_boot_delegs WHERE drep_key = ${drep}`;
}
async function drepDelegationOf(db: SqlClient, stakeKey: string): Promise<{ type: number; hash: string | null } | null> {
    const gr = ledgerGovReads();
    if (gr) return gr.drepDelegation(stakeKey);
    const r = ((await db`SELECT drep_type, drep_hash FROM gov_drep_delegations WHERE stake_key = ${stakeKey}`.values()) as unknown[][])[0];
    return r ? { type: Number(r[0]), hash: r[1] == null ? null : String(r[1]) } : null;
}

/**
 * A vote delegation (certificate types 9, 10, 12, 13). `epoch` selects the bootstrap-phase reverse-set
 * semantics (bug 165); `newAccount` for the registering certificates 12 / 13.
 */
export async function recordVoteDelegation(db: SqlClient, stakeCred: any, drep: any, epoch?: number, newAccount = false): Promise<void> {
    const t = Number(drep?.drepType ?? drep?.type ?? -1);
    const h = t === 0 || t === 1 ? hex(drep?.hash) : null;
    const key = typedCredHexOf(stakeCred) ?? hex(stakeCred?.hash);
    if ((await protocolMajorAt(epoch)) === 9) {
        if (h) { const target = typedOf(t, h); if (await drepStored(db, target)) await bootAdd(db, target, key); } // the old DRep keeps the account
        else if (!newAccount) { const cur = await drepDelegationOf(db, key); if (cur && (cur.type === 0 || cur.type === 1) && cur.hash) await bootDel(db, typedOf(cur.type, cur.hash), key); }
    }
    ledgerGov()?.putDRepDelegation(key, { type: t, hash: h });
    if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO gov_drep_delegations (stake_key, drep_type, drep_hash) VALUES (${key}, ${t}, ${h})`;
}
/**
 * A stake credential's deregistration removes its DRep delegation with its pool delegation and
 * reward balance (Conway DELEG rule, `dereg`: vDelegs, sDelegs and rwds all lose the credential).
 * Bug 89: only the pool delegation was dropped, so a credential that deregistered and
 * re-registered without a new vote delegation kept voting through its old DRep (preview
 * epochs 960–962: a 91 T whale counted for drep1yg2dvrjv…, the chain counted nothing; 35b81b42…
 * ratified one epoch early). It leaves its current DRep's reverse set only (bug 165).
 */
export async function recordStakeDeregistration(db: SqlClient, stakeCred: any, epoch?: number): Promise<void> {
    const key = typedCredHexOf(stakeCred) ?? hex(stakeCred?.hash);
    if (!key) return;
    if ((await protocolMajorAt(epoch)) === 9) { const cur = await drepDelegationOf(db, key); if (cur && (cur.type === 0 || cur.type === 1) && cur.hash) await bootDel(db, typedOf(cur.type, cur.hash), key); }
    ledgerGov()?.delDRepDelegation(key);
    if (sqlLedgerWrites()) await db`DELETE FROM gov_drep_delegations WHERE stake_key = ${key}`;
}

/** HARDFORK to protocol 10 (`updateDRepDelegations`): delegations to unregistered DReps go, the reverse sets are rebuilt (bug 165). */
export async function hardForkToV10(db: SqlClient): Promise<number> {
    const registered = await activeDRepCredentials(0, Number.MAX_SAFE_INTEGER / 4); // every registered DRep (expiry irrelevant)
    const gw = ledgerGov(), gr = ledgerGovReads();
    let n = 0;
    if (gw) {
        for (const [k, d] of gw.reads.drepDelegations()) if ((d.type === 0 || d.type === 1) && d.hash && !registered.has(typedOf(d.type, d.hash))) { gw.delDRepDelegation(k); n++; }
        for (const [drep, stake] of gw.allBootDelegations()) gw.delBootDelegator(drep, stake);
    }
    if (sqlLedgerWrites()) {
        const rows = (await db`SELECT stake_key, drep_type, drep_hash FROM gov_drep_delegations WHERE drep_type IN (0, 1)`.values()) as unknown[][];
        let m = 0;
        for (const r of rows) if (!registered.has(typedOf(Number(r[1]), String(r[2])))) { await db`DELETE FROM gov_drep_delegations WHERE stake_key = ${String(r[0])}`; m++; }
        await db`DELETE FROM gov_drep_boot_delegs`;
        if (!gr) n = m;
    }
    return n;
}

/**
 * A committee cold key's state (`csCommitteeCreds`: an authorised hot key, or a resignation) under
 * its typed key ("00"/"01" + hash, bug 153). A row stored before typing under the bare hash moves
 * to the typed key — the certificate names the type — together with the member row of that cold key.
 */
async function putCommitteeCred(db: SqlClient, coldTyped: string, hotTyped: string | null, resigned: 0 | 1): Promise<void> {
    const key = ccKey(coldTyped), bare = coldTyped.length === 58 ? coldTyped.slice(2) : coldTyped;
    const hot = hotTyped ? ccKey(hotTyped) : null;
    const gw = ledgerGov();
    if (gw) {
        if (gw.reads.committeeAuth(bare)) gw.delCommitteeAuth(bare);
        gw.putCommitteeAuth(key, { hot, resigned });
        const members = gw.reads.committee();
        const m = members.get(key) ?? members.get(bare);
        if (m) { if (members.has(bare)) gw.delCommittee(bare); gw.putCommittee(key, { ...m, hot, resigned }); }
    }
    if (sqlLedgerWrites()) {
        await db`DELETE FROM gov_committee_auth WHERE cold_credential = ${bare}`;
        await db`INSERT INTO gov_committee_auth (cold_credential, hot_credential, resigned) VALUES (${key}, ${hot}, ${resigned}) ON CONFLICT(cold_credential) DO UPDATE SET hot_credential = excluded.hot_credential, resigned = excluded.resigned`;
        await db`UPDATE gov_committee SET cold_credential = ${key}, hot_credential = ${hot}, resigned = ${resigned} WHERE cold_credential IN (${key}, ${bare})`;
    }
}
export async function recordCommitteeHot(db: SqlClient, cold: any, hot: any): Promise<void> {
    await putCommitteeCred(db, typedCredHexOf(cold) ?? hex(cold?.hash), typedCredHexOf(hot) ?? hex(hot?.hash), 0);
}
export async function recordCommitteeResign(db: SqlClient, cold: any): Promise<void> {
    await putCommitteeCred(db, typedCredHexOf(cold) ?? hex(cold?.hash), null, 1);
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
            // typed credentials (bug 153); payloads without `typed` hold bare hashes of unknown type
            return {
                typed: true,
                remove: ((a.toRemove ?? []) as any[]).map((c) => typedCredHexOf(c) ?? hex(c?.hash)),
                add: ((a.toAdd ?? []) as any[]).map((e) => ({ cred: typedCredHexOf(e.coldCredential) ?? hex(e.coldCredential?.hash), expires: Number(e.expiration ?? e.epoch ?? 0) })),
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
    const gr = ledgerGovReads(), gw = ledgerGov();
    if (proposals.length && gw) {
        const dormant = Number(gw.reads.state()?.dormantEpochs ?? 0);
        if (dormant > 0) {
            for (const [c, d] of gw.reads.dreps()) gw.putDRep(c, { ...d, expiryEpoch: d.expiryEpoch != null && d.expiryEpoch + dormant >= epoch ? d.expiryEpoch + dormant : d.expiryEpoch, lastActiveEpoch: d.lastActiveEpoch + dormant });
            gw.updateState({ dormantEpochs: 0 });
        }
    }
    if (proposals.length) {
        // A proposal after dormant epochs: those epochs did not count against any DRep's activity.
        const st = gr ? [[gr.state()?.dormantEpochs ?? 0]] : (await db`SELECT dormant_epochs FROM gov_state WHERE id = 1`.values()) as unknown[][];
        const dormant = Number(st[0]?.[0] ?? 0);
        if (dormant > 0) {
            // cardano-ledger `updateDormantDRepExpiry`: an already expired DRep is not revived.
            if (sqlLedgerWrites()) await db`UPDATE gov_dreps SET expiry_epoch = expiry_epoch + ${dormant} WHERE expiry_epoch IS NOT NULL AND expiry_epoch + ${dormant} >= ${epoch}`;
            if (sqlLedgerWrites()) await db`UPDATE gov_dreps SET last_active_epoch = last_active_epoch + ${dormant}`;
            if (sqlLedgerWrites()) await db`UPDATE gov_state SET dormant_epochs = 0 WHERE id = 1`;
        }
    }
    for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        const kind = actionKind(p?.govAction);
        if (!kind) continue;
        const rawChanges = kind === "ParameterChange" && bodyBytes ? paramChangesOfProposal(bodyBytes, i) : null;
        const prev = p.govAction?.govActionId;
        const prevId = prev ? `${hex(prev.id)}:${Number(prev.index)}` : null;
        const actionId = `${txIdHex.toLowerCase()}:${i}`;
        if (gw && !gw.reads.proposal(actionId)) gw.putProposal({ actionId, seq: gw.reads.maxSeq() + 1, kind, prevActionId: prevId, deposit: String(p.deposit ?? 0), returnAccount: rewardAccountTypedHex(p.rewardAccount), payload: JSON.stringify(actionPayload(kind, p.govAction, rawChanges)), proposedEpoch: epoch, expiresEpoch: epoch + govActionLifetime, status: "active", decidedEpoch: null });
        const seqRows = gr ? [[gr.maxSeq() + 1]] : (await db`SELECT COALESCE(MAX(seq), 0) + 1 FROM gov_proposals`.values()) as unknown[][];
        if (sqlLedgerWrites()) await db`INSERT OR IGNORE INTO gov_proposals (action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch)
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
            ledgerGov()?.putVote({ actionId, voterKind: kind, voterHash: vh, vote, slot });
            if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO gov_votes (action_id, voter_kind, voter_hash, vote, slot) VALUES (${actionId}, ${kind}, ${vh}, ${vote}, ${slot})`;
            if (kind === 2 || kind === 3) await recordDRepActivity(db, typedOf(kind - 2, vh), epoch);
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
            ledgerGov()?.updateProposal(p.action_id, { status: "dropped", decidedEpoch: epoch });
            if (sqlLedgerWrites()) await db`UPDATE gov_proposals SET status = 'dropped', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
            out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
            out.dropped.push(p.action_id);
        }
    }
}

interface ProposalRow { action_id: string; seq: number; kind: ActionKind; prev_action_id: string | null; deposit: bigint; return_account: string; payload: any; proposed_epoch: number; expires_epoch: number }

async function activeProposals(): Promise<ProposalRow[]> {
    const gr = ledgerGovReads();
    if (gr) return gr.proposals("active").map(fromStoreProposal);
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch FROM gov_proposals WHERE status = 'active' ORDER BY seq`.values()) as unknown[][];
    return rows.map((r) => ({ action_id: String(r[0]), seq: Number(r[1]), kind: String(r[2]) as ActionKind, prev_action_id: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), return_account: String(r[5]), payload: JSON.parse(String(r[6])), proposed_epoch: Number(r[7]), expires_epoch: Number(r[8]) }));
}

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
    const fromStore = ledgerGov()?.takeDRepStakeSnapshot(takenAt);
    if (ledgerGovReads() && fromStore != null) { if (sqlLedgerWrites()) await takeDRepStakeSnapshotSql(db, takenAt); return fromStore; }
    return takeDRepStakeSnapshotSql(db, takenAt);
}

async function takeDRepStakeSnapshotSql(db: SqlClient, takenAt: number): Promise<number> {
    const have = (await db`SELECT COUNT(*) FROM epoch_drep_stake WHERE taken_at = ${takenAt}`.values()) as unknown[][];
    if (Number(have[0]?.[0] ?? 0) > 0) return 0;
    if (sqlLedgerWrites()) await db`INSERT INTO epoch_drep_stake (taken_at, drep_type, drep_hash, stake)
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

/** What one boundary ratified, to be enacted at the next (the ledger's DRep pulser: set up at `epoch`, completed one epoch later). */
type PendingRatification = { epoch: number; ratified: string[]; expired: string[] };

type ChainIds = { prevPP: string | null; prevHF: string | null; prevCC: string | null; prevCons: string | null };

async function proposalById(id: string): Promise<ProposalRow | null> {
    const gr = ledgerGovReads();
    if (gr) { const p = gr.proposal(id); return p ? fromStoreProposal(p) : null; }
    const rows = (await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch FROM gov_proposals WHERE action_id = ${id}`.values()) as unknown[][];
    const r = rows[0];
    if (!r) return null;
    return { action_id: String(r[0]), seq: Number(r[1]), kind: String(r[2]) as ActionKind, prev_action_id: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), return_account: String(r[5]), payload: JSON.parse(String(r[6])), proposed_epoch: Number(r[7]), expires_epoch: Number(r[8]) };
}

/** Apply one ratified action's effects at the boundary into `epoch` (cardano-ledger ENACT). */
async function enactOne(db: SqlClient, p: ProposalRow, epoch: number, out: EnactmentResult, ids: ChainIds): Promise<void> {
    const gw = ledgerGov();
    switch (p.kind) {
        case "ParameterChange": {
            // Two parameter changes enacted at one boundary (a chained pair ratified in one round,
            // bug 151): the later wins per key, cost models per language (Conway `applyPPUpdates`).
            const changes = { ...(p.payload.changes ?? {}) } as Record<string, unknown>;
            const prevCm = out.paramChanges.cost_models as Record<string, unknown> | undefined;
            if (prevCm && changes.cost_models) changes.cost_models = { ...prevCm, ...(changes.cost_models as Record<string, unknown>) };
            Object.assign(out.paramChanges, changes);
            ids.prevPP = p.action_id;
            break;
        }
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
            // ENACT: `ensCommitteeL .~ SNothing` — the committee is gone, not just distrusted (bug 162)
            gw?.updateState({ noConfidence: 1 });
            if (gw) for (const k of gw.reads.committee().keys()) gw.delCommittee(k);
            if (sqlLedgerWrites()) { await db`UPDATE gov_state SET no_confidence = 1 WHERE id = 1`; await db`DELETE FROM gov_committee`; }
            ids.prevCC = p.action_id;
            break;
        case "UpdateCommittee": {
            // `updatedCommittee`: (members ∖ remove) ∪ add, or just add after a no-confidence (bug 162)
            const st = await chainIds(db);
            const fresh = st?.noConfidence === true;
            const remove = payloadCcRemove(p.payload);
            const add = payloadCcAdd(p.payload);
            const typed = p.payload?.typed === true;
            const view = await loadCommitteeView();
            const hotFor = (creds: string[]): { hot: string | null } => {
                // an untyped legacy hot key (it has an other-type reading) stays as stored
                for (const c of creds) { const s = view.creds.get(c); if (s && !s.resigned && s.hot) return { hot: s.hotAlt ? s.hot : ccKey(s.hot) }; }
                return { hot: null };
            };
            const keysOf = (creds: string[]) => (typed ? creds.map(ccKey) : [creds[0]!]); // legacy payload: the bare hash as stored
            const removeKeys = new Set<string>();
            for (const c of remove) { removeKeys.add(ccKey(c)); removeKeys.add(c.length === 58 ? c.slice(2) : c); }
            if (gw) {
                if (fresh) for (const k of gw.reads.committee().keys()) gw.delCommittee(k);
                else for (const k of gw.reads.committee().keys()) if (removeKeys.has(k) || ccCredsOf(k).some((c) => removeKeys.has(ccKey(c)))) gw.delCommittee(k);
                for (const a of add) for (const k of keysOf(a.creds)) gw.putCommittee(k, { expiresEpoch: a.expires, hot: hotFor(a.creds).hot, resigned: 0 });
                gw.updateState({ thrNum: Number(p.payload.thresholdNum ?? 2), thrDen: Number(p.payload.thresholdDen ?? 3), noConfidence: 0 });
            }
            if (sqlLedgerWrites()) {
                if (fresh) await db`DELETE FROM gov_committee`;
                else for (const k of removeKeys) await db`DELETE FROM gov_committee WHERE cold_credential = ${k} OR cold_credential = ${k.length === 58 ? k.slice(2) : k}`;
                for (const a of add) for (const k of keysOf(a.creds)) {
                    const hot = hotFor(a.creds).hot;
                    await db`INSERT INTO gov_committee (cold_credential, expires_epoch, hot_credential, resigned) VALUES (${k}, ${a.expires}, ${hot}, 0) ON CONFLICT(cold_credential) DO UPDATE SET expires_epoch = excluded.expires_epoch, hot_credential = COALESCE(excluded.hot_credential, gov_committee.hot_credential), resigned = 0`;
                }
                await db`UPDATE gov_state SET committee_threshold_num = ${Number(p.payload.thresholdNum ?? 2)}, committee_threshold_den = ${Number(p.payload.thresholdDen ?? 3)}, no_confidence = 0 WHERE id = 1`;
            }
            ids.prevCC = p.action_id;
            break;
        }
        case "NewConstitution":
            gw?.updateState({ constitutionHash: p.payload.hash ?? null, constitutionScript: p.payload.script ?? null });
            { const a = gw?.reads.constitutionProposalAnchor(p.action_id); if (gw && a) gw.putConstitutionAnchor(a); }
            if (sqlLedgerWrites()) await db`UPDATE gov_state SET constitution_hash = ${p.payload.hash ?? null}, constitution_script = ${p.payload.script ?? null} WHERE id = 1`;
            ids.prevCons = p.action_id;
            break;
        case "Info":
            break;
    }
    gw?.updateProposal(p.action_id, { status: "enacted", decidedEpoch: epoch });
    gw?.putEnacted(epoch, p.action_id, p.kind, JSON.stringify(p.payload));
    if (sqlLedgerWrites()) await db`UPDATE gov_proposals SET status = 'enacted', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
    if (sqlLedgerWrites()) await db`INSERT OR REPLACE INTO gov_enacted (epoch, action_id, kind, detail) VALUES (${epoch}, ${p.action_id}, ${p.kind}, ${JSON.stringify(p.payload)})`;
    out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
    out.enacted.push(`${p.kind} ${p.action_id.slice(0, 12)}…`);
}

/**
 * One proposal's tally at the boundary into `epoch` with the stake snapshot `takenAt`, as the
 * round would count it on its own (diagnostic: `scripts/gov-tally.ts`; the chain, delay and
 * treasury conditions of the round are reported, not applied).
 */
export async function tallyProposal(db: SqlClient, epoch: number, actionId: string, raw: Record<string, unknown>, takenAt = epoch, votesUntilSlot = Number.MAX_SAFE_INTEGER): Promise<ProposalTally> {
    const live = await loadLiveProposals();
    const p = live.find((x) => x.id === actionId) ?? (await loadAnyProposal(actionId));
    if (!p) throw new Error(`proposal ${actionId} not stored`);
    const roots = { pparams: null, hardfork: null, committee: null, constitution: null } as Record<Purpose, string | null>;
    const input = await gatherRatifyInput(epoch, raw, roots, { takenAt, votesUntilSlot });
    const one = await ratifyProposalOf(p, votesUntilSlot);
    one.prev = null; one.expiresAfter = Number.MAX_SAFE_INTEGER; // judge the votes alone
    input.proposals = [one];
    input.treasury = input.treasury > (one.withdrawalTotal ?? 0n) ? input.treasury : (one.withdrawalTotal ?? 0n);
    const purpose = one.kind === "ParameterChange" ? "pparams" : one.kind === "InitHardFork" ? "hardfork" : one.kind === "NoConfidence" || one.kind === "UpdateCommittee" ? "committee" : one.kind === "NewConstitution" ? "constitution" : null;
    if (purpose) input.roots[purpose] = null;
    return ratifyRound(input).tallies[0]!;
}

async function loadAnyProposal(id: string) {
    const gr = ledgerGovReads();
    if (gr) { const p = gr.proposal(id); return p ? { id: p.actionId, seq: p.seq, kind: p.kind, prev: p.prevActionId, deposit: BigInt(p.deposit), returnAccount: p.returnAccount, payload: JSON.parse(p.payload), proposedEpoch: p.proposedEpoch, expiresEpoch: p.expiresEpoch, status: p.status } : null; }
    const r = ((await sql`SELECT action_id, seq, kind, prev_action_id, deposit, return_account, payload, proposed_epoch, expires_epoch, status FROM gov_proposals WHERE action_id = ${id}`.values()) as unknown[][])[0];
    return r ? { id: String(r[0]), seq: Number(r[1]), kind: String(r[2]), prev: r[3] == null ? null : String(r[3]), deposit: BigInt(String(r[4])), returnAccount: String(r[5]), payload: JSON.parse(String(r[6])), proposedEpoch: Number(r[7]), expiresEpoch: Number(r[8]), status: String(r[9]) } : null;
}

/**
 * Governance at the start of `epoch`, in the ledger's two steps:
 *
 * 1. Enact what the previous boundary ratified. cardano-ledger sets up the DRep pulser at the
 *    start of an epoch (proposals, votes and stake as of that boundary) and completes it at the
 *    next boundary, where the ratified actions take effect and expired ones are dropped and
 *    refunded (bug 81: enacting at ratification put a new cost model one epoch early — preview
 *    epoch 735, action 1f47f3cf…, ratified 735, enacted 736 on the chain).
 * 2. Ratify for this boundary with the parameters of `epoch` and the stake snapshot the
 *    ledger uses for voting (taken at `takenAt`); record the result as pending.
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
    const gr = ledgerGovReads();
    const gs = gr?.state();
    const state = gr ? (gs ? [[gs.prevPP, gs.prevHF, gs.prevCC, gs.prevCons, gs.noConfidence, gs.pending]] : []) : (await db`SELECT prev_pparams, prev_hardfork, prev_committee, prev_constitution, no_confidence, pending FROM gov_state WHERE id = 1`.values()) as unknown[][];
    if (!state.length) return null;
    const ids: ChainIds = { prevPP: state[0]![0] == null ? null : String(state[0]![0]), prevHF: state[0]![1] == null ? null : String(state[0]![1]), prevCC: state[0]![2] == null ? null : String(state[0]![2]), prevCons: state[0]![3] == null ? null : String(state[0]![3]) };
    let pending: PendingRatification | null = null;
    try { pending = state[0]![5] == null ? null : (JSON.parse(String(state[0]![5])) as PendingRatification); } catch { pending = null; }
    return { ids, noConfidence: Number(state[0]![4]) === 1, pending };
}

/**
 * Descendants of `roots` among the active proposals (a chain of `prev` links within one purpose):
 * EPOCH removes an expiring proposal with its whole subtree (`proposalsRemoveWithDescendants`).
 * Bug 159: only the expiring proposal itself was removed; a child submitted later stayed active —
 * unratifiable, its parent gone — until its own expiry, and its deposit came back that much later.
 */
function descendantsOf(rootIds: Iterable<string>, active: ProposalRow[]): string[] {
    const byPrev = new Map<string, ProposalRow[]>();
    for (const p of active) if (p.prev_action_id) { const l = byPrev.get(p.prev_action_id) ?? []; l.push(p); byPrev.set(p.prev_action_id, l); }
    const out: string[] = [], seen = new Set<string>(rootIds), todo = [...seen];
    while (todo.length) {
        const id = todo.pop()!;
        for (const c of byPrev.get(id) ?? []) { if (seen.has(c.action_id) || familyOf(c.kind) == null) continue; seen.add(c.action_id); out.push(c.action_id); todo.push(c.action_id); }
    }
    return out;
}

/**
 * EPOCH's `updateCommitteeState`: after enactment the committee state keeps only the cold keys of
 * the (new) committee's members — every other authorisation or resignation is forgotten, all of them
 * after a no-confidence. Bug 160: authorisations of cold keys that never became members (or left)
 * stayed forever; a key re-added later counted its old hot key where the chain has none.
 */
async function pruneCommitteeState(db: SqlClient): Promise<number> {
    const view = await loadCommitteeView();
    const memberCreds = new Set<string>(); if (view.members) for (const c of view.members.keys()) memberCreds.add(c);
    const gw = ledgerGov();
    let n = 0;
    const stale = (k: string) => !ccCredsOf(k).some((c) => memberCreds.has(c));
    if (gw) for (const k of gw.reads.committeeAuths().keys()) if (stale(k)) { gw.delCommitteeAuth(k); n++; }
    if (sqlLedgerWrites()) {
        const rows = (await db`SELECT cold_credential FROM gov_committee_auth`.values()) as unknown[][];
        let m = 0;
        for (const r of rows) { const k = String(r[0]); if (stale(k)) { await db`DELETE FROM gov_committee_auth WHERE cold_credential = ${k}`; m++; } }
        if (!gw) n = m;
    }
    return n;
}

/** Step 1: enact what the previous boundary ratified (before the epoch's parameters are derived). */
export async function enactPending(db: SqlClient, epoch: number): Promise<EnactmentResult> {
    const out: EnactmentResult = { paramChanges: {}, protocolVersion: null, withdrawals: new Map(), refunds: new Map(), enacted: [], expired: [], dropped: [] };
    const st = await chainIds(db);
    if (!st) return out;
    const { ids, pending } = st;
    if (pending) {
        if (pending.epoch !== epoch - 1) logger.warn(`Epoch ${epoch} governance: enacting the ratification recorded at epoch ${pending.epoch} (expected ${epoch - 1})`);
        // Expired first, with their descendants (bug 159), so the orphan sweep below (which reads the
        // still-active set) cannot refund an expiring proposal a second time (bug 98: preview 999 —
        // 573b7228… expired and orphaned by 602d8572… in the same boundary, 100 k ADA refunded twice).
        const activeBefore = await activeProposals();
        const expiring = [...pending.expired, ...descendantsOf(pending.expired, activeBefore)];
        for (const id of expiring) {
            const p = await proposalById(id);
            if (!p) continue;
            ledgerGov()?.updateProposal(p.action_id, { status: "expired", decidedEpoch: epoch });
            if (sqlLedgerWrites()) await db`UPDATE gov_proposals SET status = 'expired', decided_epoch = ${epoch} WHERE action_id = ${p.action_id}`;
            out.refunds.set(p.return_account, (out.refunds.get(p.return_account) ?? 0n) + p.deposit);
            out.expired.push(p.action_id);
        }
        const touched = new Set<Family>();
        for (const id of pending.ratified) {
            const p = await proposalById(id);
            if (!p) { logger.warn(`Epoch ${epoch} governance: ratified action ${id} no longer stored`); continue; }
            await enactOne(db, p, epoch, out, ids);
            const fam = familyOf(p.kind);
            if (fam) touched.add(fam);
        }
        await dropOrphans(db, epoch, out, { pparams: ids.prevPP ?? null, hardfork: ids.prevHF ?? null, committee: ids.prevCC ?? null, constitution: ids.prevCons ?? null }, touched);
        ledgerGov()?.updateState({ prevPP: ids.prevPP, prevHF: ids.prevHF, prevCC: ids.prevCC, prevCons: ids.prevCons, pending: null });
        if (sqlLedgerWrites()) await db`UPDATE gov_state SET prev_pparams = ${ids.prevPP}, prev_hardfork = ${ids.prevHF}, prev_committee = ${ids.prevCC}, prev_constitution = ${ids.prevCons}, pending = NULL WHERE id = 1`;
    }
    if (out.protocolVersion?.major === 10) {
        const dropped = await hardForkToV10(db);
        logger.info(`Epoch ${epoch} governance: protocol 10 hard fork — ${dropped} vote delegation(s) to unregistered DReps dropped, reverse delegation sets rebuilt`);
    }
    const pruned = await pruneCommitteeState(db);
    if (pruned) logger.info(`Epoch ${epoch} governance: ${pruned} committee credential state(s) of non-members forgotten`);
    return out;
}

/**
 * Step 2: ratify for this boundary — the pulser the ledger sets up once the epoch's parameters
 * are in force and the stake snapshot is taken (bug 82). `raw` = parameters of `epoch`; `takenAt` =
 * snapshot epoch (default `epoch`). The round is `ratifyRound` (ratify.ts, bugs 151–155 and 158);
 * the result is recorded as pending and enacted at the next boundary, and the chain ids advance
 * now so the next pulser (set up after that enactment) sees them. Call it after the boundary's
 * refunds and withdrawals are credited: the pulser's DRep distribution includes them (bug 155).
 */
export async function ratifyForNext(db: SqlClient, epoch: number, raw: Record<string, unknown>, takenAt = epoch, opts: { treasury?: bigint; drepDistr?: Map<string, bigint>; poolDistr?: Map<string, bigint> } = {}): Promise<PendingRatification> {
    const st = await chainIds(db);
    const next: PendingRatification = { epoch, ratified: [], expired: [] };
    if (!st) return next;
    const { ids } = st;
    await takeDRepStakeSnapshot(db, takenAt); // bug 90: the pulser's DRep stake, as of this boundary
    const roots: Record<Purpose, string | null> = { pparams: ids.prevPP, hardfork: ids.prevHF, committee: ids.prevCC, constitution: ids.prevCons };
    const input = await gatherRatifyInput(epoch, raw, roots, { takenAt, ...opts });
    // The pulser's frozen snapshot of this epoch (bug 167): the very proposals, votes and distributions
    // this round is tallied with, kept for the node-to-client queries until the next boundary.
    try {
        // lmdb mode reads the store; dual mode reads it through the block's writers (bug 246: the
        // lmdb-only accessors left the dual-mode store without a snapshot)
        const gr = ledgerGovReads() ?? ledgerGov()?.reads ?? null, sr = ledgerStakeReads() ?? ledgerStake()?.reads ?? null;
        if (gr && sr) {
            const tipHash = getLedgerStore()?.selectedTip() ?? null;
            const b = tipHash ? await primaryBlockStore()?.byHash(tipHash) : null;
            const live = (await loadLiveProposals()).filter((p) => p.status === "active");
            await storePulserSnapshot(snapshotAtBoundary(input, { gov: gr, stake: sr, now: { gov: gr, stake: sr } }, b ? { slot: b.slot, hash: Buffer.from(b.hash).toString("hex") } : null, new Map(live.map((p) => [p.id, { returnAccount: p.returnAccount, deposit: p.deposit }]))));
        }
    } catch (err) { logger.warn(`Epoch ${epoch} governance: pulser snapshot not stored:`, err); }
    const result = ratifyRound(input);
    // One line per proposal so a tally that differs from the chain can be examined afterwards.
    for (const t of result.tallies) logger.info(`Epoch ${epoch} tally ${t.kind} ${t.id.slice(0, 12)}…: ${t.ratified ? "RATIFIED" : "not ratified"} (${t.reason}) — cc ${t.cc}, drep ${t.drep}, spo ${t.spo}`);
    next.ratified = result.ratified;
    next.expired = result.expired;
    for (const id of result.ratified) {
        ledgerGov()?.updateProposal(id, { status: "ratified", decidedEpoch: epoch });
        if (sqlLedgerWrites()) await db`UPDATE gov_proposals SET status = 'ratified', decided_epoch = ${epoch} WHERE action_id = ${id}`;
    }
    ids.prevPP = result.roots.pparams; ids.prevHF = result.roots.hardfork; ids.prevCC = result.roots.committee; ids.prevCons = result.roots.constitution;
    ledgerGov()?.updateState({ prevPP: ids.prevPP, prevHF: ids.prevHF, prevCC: ids.prevCC, prevCons: ids.prevCons, pending: JSON.stringify(next) });
    if (sqlLedgerWrites()) await db`UPDATE gov_state SET prev_pparams = ${ids.prevPP}, prev_hardfork = ${ids.prevHF}, prev_committee = ${ids.prevCC}, prev_constitution = ${ids.prevCons}, pending = ${JSON.stringify(next)} WHERE id = 1`;
    if (next.ratified.length || next.expired.length) logger.info(`Epoch ${epoch} governance: ratified [${next.ratified.map((a) => a.slice(0, 12) + "…").join(", ")}], expiring ${next.expired.length} — enacted at the next boundary`);
    // `updateNumDormantEpochs`: an epoch whose proposals have all expired (none with expiresAfter ≥ epoch)
    // does not age the DReps (bug 161: any stored active proposal, even one expiring at this very
    // boundary, kept the epoch from counting as dormant).
    if (!input.proposals.some((p) => p.expiresAfter >= epoch)) {
        const gw = ledgerGov(); if (gw) gw.updateState({ dormantEpochs: Number(gw.reads.state()?.dormantEpochs ?? 0) + 1 });
        if (sqlLedgerWrites()) await db`UPDATE gov_state SET dormant_epochs = dormant_epochs + 1 WHERE id = 1`;
    }
    return next;
}
