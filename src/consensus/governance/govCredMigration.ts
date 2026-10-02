/**
 * Bug 153, stored data: DReps and committee credentials were keyed by the bare hash. The readers
 * (govLedgerView.ts) accept both forms, so this migration is tidying, never a precondition:
 *
 *   gov_dreps          a script DRep's row (`is_script` = 1) moves to its typed key ("01" + hash);
 *   gov_committee /    a cold credential whose type is known — from the Conway genesis
 *   gov_committee_auth (`keyHash-` / `scriptHash-`) — moves to "00"/"01" + hash; a hot key whose
 *                      type is known from its committee votes (voter kinds 0 / 1) is rewritten typed.
 *                      Credentials of unknown type stay bare and match both types until a
 *                      certificate names them (recordCommitteeHot / Resign retype on the way).
 *
 * It runs once per database (`gov_cred_typed_v1`: SQLite `schema_migrations`, LMDB `gov_state`),
 * at the start of the first block applied by this build, inside that block: the LMDB writes are
 * part of the block's diff (a direct write beside the volatile diffs would break their promotion,
 * bug 126) and the SQLite writes go through the block's journal. A rollback of that block undoes
 * it; the readers do not care.
 */
import { sql } from "../../sql";
import { ledgerGov, sqlLedgerWrites } from "../../ledger/nodeLedgerStore";
import { logger } from "../../utils/logger";
import { eraGenesisFilesFor } from "../pparams";
import { typedOf } from "./govTxDecode";
import { ccKey } from "./govLedgerView";
import { repairLiveProposalVotesOnce, resetGovVotesRepairForTests } from "./govVotesRepair";
import { backfillPulserSnapshotOnce, fixPulserPoolDistrOnce, resetPulserBackfillForTests, resetPulserPoolDistrFixForTests } from "./govPulser";
import { migrateDRepExpiryOnce, resetDRepExpiryMigrationForTests } from "./govStoreSync";

const MARKER = "gov_cred_typed_v1";
let done = false;
let genesisFile: string | null = null;

/** The node config (for the Conway genesis path); called by the body validator. */
export function noteGovGenesisConfig(config: any): void { if (!genesisFile) { const f = eraGenesisFilesFor(config).conway; if (f) genesisFile = String(f); } }

async function genesisColdTypes(): Promise<Map<string, 0 | 1>> {
    const out = new Map<string, 0 | 1>();
    if (!genesisFile) return out;
    try {
        const g = JSON.parse(await Bun.file(genesisFile).text());
        for (const k of Object.keys(g?.committee?.members ?? {})) { const m = /^(keyHash|scriptHash)-([0-9a-fA-F]{56})$/.exec(k); if (m) out.set(m[2]!.toLowerCase(), m[1] === "scriptHash" ? 1 : 0); }
    } catch { /* no genesis at hand */ }
    return out;
}

/** The governance store migrations, in order: typed credentials (bug 153), then the vote repair (bug 166). */
export async function migrateGovCredentials(): Promise<{ dreps: number; committee: number } | null> {
    const r = await migrateCredentials();
    // Each repair is one-off tidying of derived governance data, never a condition of applying the
    // block: a failure is logged and retried at the next restart, the block goes on.
    const guarded = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (err) { logger.warn(`governance ${name} failed (retried at the next restart):`, err); } };
    await guarded("votes repair (bug 166)", repairLiveProposalVotesOnce);
    await guarded("DRep expiry migration (bug 246)", migrateDRepExpiryOnce); // credSchema levels run in this order: 1, 2, 3
    await guarded("pulser backfill (bug 167)", backfillPulserSnapshotOnce);
    await guarded("pulser pool distribution fix (bug 247)", fixPulserPoolDistrOnce);
    return r;
}

async function migrateCredentials(): Promise<{ dreps: number; committee: number } | null> {
    if (done) return null;
    const gw = ledgerGov();
    // credSchema: 1 = typed credentials, 2 = and the votes repaired (govVotesRepair.ts)
    if (gw) { const st = gw.reads.state(); if (!st) { done = true; return null; } if ((st.credSchema ?? 0) >= 1) { done = true; return null; } }
    else {
        try { const m = (await sql`SELECT 1 FROM schema_migrations WHERE name = ${MARKER}`.values()) as unknown[][]; if (m.length) { done = true; return null; } }
        catch { done = true; return null; }
        const st = (await sql`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][];
        if (!st.length) return null; // governance not seeded yet: nothing to migrate
    }
    const t0 = performance.now();
    let dreps = 0, committee = 0;
    const cold = await genesisColdTypes();
    // hot key types from the committee's votes
    const hotType = new Map<string, 0 | 1>();
    if (gw) {
        for (const p of gw.reads.proposals()) for (const v of gw.reads.votes(p.actionId)) if (v.voterKind === 0 || v.voterKind === 1) hotType.set(v.voterHash, v.voterKind as 0 | 1);
    } else if (sqlLedgerWrites()) {
        for (const r of (await sql`SELECT DISTINCT voter_kind, voter_hash FROM gov_votes WHERE voter_kind IN (0, 1)`.values()) as unknown[][]) hotType.set(String(r[1]), Number(r[0]) as 0 | 1);
    }
    const typedHot = (h: string | null): string | null => (h == null ? null : h.length === 56 && hotType.has(h) ? ccKey(typedOf(hotType.get(h)!, h)) : h);
    const typedCold = (k: string): string => (k.length === 56 && cold.has(k) ? ccKey(typedOf(cold.get(k)!, k)) : k);

    if (gw) {
        for (const [k, d] of gw.reads.dreps()) if (d.isScript && k.length === 56 && !gw.reads.drep(`01${k}`)) { gw.putDRep(`01${k}`, d); gw.delDRep(k); dreps++; }
        for (const [k, c] of gw.reads.committee()) {
            const nk = typedCold(k), nh = typedHot(c.hot);
            if (nk === k && nh === c.hot) continue;
            if (nk !== k) gw.delCommittee(k);
            gw.putCommittee(nk, { ...c, hot: nh }); committee++;
        }
        for (const [k, a] of gw.reads.committeeAuths()) {
            const nk = typedCold(k), nh = typedHot(a.hot);
            if (nk === k && nh === a.hot) continue;
            if (nk !== k) gw.delCommitteeAuth(k);
            gw.putCommitteeAuth(nk, { ...a, hot: nh }); committee++;
        }
        gw.updateState({ credSchema: 1 });
    }
    if (sqlLedgerWrites()) {
        const scripts = (await sql`SELECT credential FROM gov_dreps WHERE is_script = 1 AND length(credential) = 56`.values()) as unknown[][];
        for (const r of scripts) {
            const k = String(r[0]);
            const taken = (await sql`SELECT 1 FROM gov_dreps WHERE credential = ${"01" + k}`.values()) as unknown[][];
            if (taken.length) continue;
            await sql`UPDATE gov_dreps SET credential = ${"01" + k} WHERE credential = ${k}`;
            if (!gw) dreps++;
        }
        for (const table of ["gov_committee", "gov_committee_auth"] as const) {
            const rows = (await sql.unsafe(`SELECT cold_credential, hot_credential FROM ${table}`).values()) as unknown[][];
            for (const r of rows) {
                const k = String(r[0]), h = r[1] == null ? null : String(r[1]);
                const nk = typedCold(k), nh = typedHot(h);
                if (nk === k && nh === h) continue;
                await sql.unsafe(`UPDATE ${table} SET cold_credential = ?, hot_credential = ? WHERE cold_credential = ?`, [nk, nh, k] as any);
                if (!gw) committee++;
            }
        }
        try { await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${MARKER})`; } catch { /* table absent in a bare test DB */ }
    }
    done = true;
    logger.info(`Governance credentials typed (bug 153): ${dreps} script DRep row(s) rekeyed, ${committee} committee row(s) typed (${cold.size} genesis cold type(s), ${hotType.size} hot key type(s) from votes) in ${(performance.now() - t0).toFixed(0)} ms`);
    return { dreps, committee };
}

/** Tests: forget that this process already ran the migration. */
export function resetGovCredMigrationForTests(): void { done = false; resetGovVotesRepairForTests(); resetDRepExpiryMigrationForTests(); resetPulserBackfillForTests(); resetPulserPoolDistrFixForTests(); }
