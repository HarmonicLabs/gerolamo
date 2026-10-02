/**
 * Keeping the SQLite governance mirror and the LMDB governance state interchangeable (bug 246): a
 * dual-mode rebuild (`rebuildFromSqlite` → `seedGovFromSqlite`) must reproduce the LMDB state the
 * node would have written itself. Three things did not survive the round trip on the producer:
 *
 *   1. `gov_dreps.expiry_epoch` is NULL for rows from before bug 102 (8 980 of 9 165 on the producer):
 *      the readers derived `last_active + drep_activity` with today's parameter (31), where the
 *      ledger's stored value is `last_active + drep_activity as of the last activity` (20 before
 *      preview epoch 964) — +11 on every DRep last active before 964 (all long expired: no effect
 *      on RATIFY's active set, a byte difference in GetDRepState). `legacyDRepExpiry` materialises
 *      the ledger's value from the parameter history; `migrateDRepExpiryOnce` writes it into both
 *      stores once, and the seed applies it to NULL rows.
 *   2. The pulser snapshot (bug 167) was mirrored to SQLite but the seed never read it back, and in
 *      dual mode the boundary and the backfill skipped it altogether (they read the lmdb-only
 *      accessors): the rebuilt store answered 24/26/31 from the live state again.
 *   3. `gov_state.credSchema` (which migrations ran) is LMDB-only: a rebuilt store re-ran them.
 *      The seed derives it from `schema_migrations`.
 */
import { sql } from "../../sql";
import { ledgerGov, ledgerGovReads, sqlLedgerWrites } from "../../ledger/nodeLedgerStore";
import { logger } from "../../utils/logger";
import { drepCredOfRow } from "./govLedgerView";

/** The migration markers SQLite keeps and the `credSchema` level each stands for. */
export const CRED_SCHEMA_MARKERS: Array<[marker: string, level: number]> = [["gov_cred_typed_v1", 1], ["gov_votes_repaired_v1", 2], ["gov_drep_expiry_v1", 3]];
export function credSchemaOfMarkers(markers: Iterable<string>): number { const m = new Set(markers); let lvl = 0; for (const [k, l] of CRED_SCHEMA_MARKERS) if (m.has(k)) lvl = Math.max(lvl, l); return lvl; }

/**
 * The expiry the ledger stored for a DRep whose last activity was at `lastActive`
 * (`computeDRepExpiry`: epoch + drepActivity of the parameters in force then − numDormantEpochs then;
 * the dormant epochs are added back by the next proposal unless the DRep had expired — on preview
 * every checked epoch had 0, so the term is left out and noted).
 */
export function legacyDRepExpiry(lastActive: number, activityAt: (epoch: number) => number | null): number {
    return lastActive + (activityAt(lastActive) ?? activityAt(lastActive - 1) ?? 20);
}

/** `drep_activity` per epoch from the stored parameters (SQLite `epoch_params`), memoised. */
export async function activityLookupSql(): Promise<(epoch: number) => number | null> {
    let rows: unknown[][] = [];
    try { rows = (await sql`SELECT epoch, json_extract(params, '$.drep_activity') FROM epoch_params`.values()) as unknown[][]; } catch { /* no parameter table (bare test DB): the Conway genesis default applies */ }
    const m = new Map<number, number>();
    for (const r of rows) if (r[1] != null) m.set(Number(r[0]), Number(r[1]));
    return (e) => m.get(e) ?? null;
}

const MARKER = "gov_drep_expiry_v1";
let done = false;
/** One-time (inside the first Conway block a new build applies): materialise the NULL expiries in both stores. */
export async function migrateDRepExpiryOnce(): Promise<number | null> {
    if (done) return null;
    const gw = ledgerGov();
    if (gw) { const st = gw.reads.state(); if (!st) return null; if ((st.credSchema ?? 0) >= 3) { done = true; return null; } }
    else {
        try { const m = (await sql`SELECT 1 FROM schema_migrations WHERE name = ${MARKER}`.values()) as unknown[][]; if (m.length) { done = true; return null; } } catch { done = true; return null; }
        if (!((await sql`SELECT 1 FROM gov_state WHERE id = 1`.values()) as unknown[][]).length) return null;
    }
    done = true;
    const activity = gw ? ((e: number) => { const p = gw.reads.epochParams(e)?.params; return p?.drep_activity == null ? null : Number(p.drep_activity); }) : await activityLookupSql();
    let n = 0;
    if (gw) for (const [k, d] of gw.reads.dreps()) if (d.expiryEpoch == null) { gw.putDRep(k, { ...d, expiryEpoch: legacyDRepExpiry(d.lastActiveEpoch, activity) }); n++; }
    if (sqlLedgerWrites()) {
        const sqlActivity = await activityLookupSql();
        const rows = (await sql`SELECT credential, last_active_epoch FROM gov_dreps WHERE expiry_epoch IS NULL`.values()) as unknown[][];
        for (const r of rows) await sql`UPDATE gov_dreps SET expiry_epoch = ${legacyDRepExpiry(Number(r[1]), sqlActivity)} WHERE credential = ${String(r[0])}`;
        if (!gw) n = rows.length;
        try { await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${MARKER})`; } catch { /* bare test DB */ }
    }
    gw?.updateState({ credSchema: 3 });
    if (n) logger.info(`governance DRep expiries materialised (bug 246): ${n} row(s) without a stored expiry set to last activity + the drep_activity in force then`);
    return n;
}
export function resetDRepExpiryMigrationForTests(): void { done = false; }

/** Every DRep's typed credential and stored (or legacy-derived) expiry, for diagnostics. */
export function drepExpiries(reads: ReturnType<typeof ledgerGovReads> & object, activity: (e: number) => number | null): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, d] of reads.dreps()) out.set(drepCredOfRow(k, d.isScript), d.expiryEpoch ?? legacyDRepExpiry(d.lastActiveEpoch, activity));
    return out;
}
