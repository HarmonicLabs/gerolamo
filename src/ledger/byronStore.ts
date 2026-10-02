/**
 * Persistence of the Byron chain-validation state (consensus/byron/ByronLedger) with the ledger's
 * rollback discipline, in both stores:
 *
 *   LMDB    database `byron`, keys `core` (update + delegation state + transition info, JSON) and
 *           `tip` (`lastSlot|blockNo`), written inside the block's diff: a rollback drops the
 *           block's diff and with it the block's Byron effects; promotion verifies before-images.
 *   SQLite  table `byron_ledger (key, value)`, same two rows, journaled (db/ledgerJournal.ts):
 *           `rollbackChainTo` restores the before-images block by block.
 *
 * `core` is written only when it changed (a few blocks per update proposal; every epoch that
 * adopts a version); `tip` moves with every Byron block and is a few bytes.
 */
import { sql } from "../sql";
import { getLedgerStore, ledgerStoreMode, sqlLedgerWrites } from "./nodeLedgerStore";

export const BYRON_DB = "byron";
const enc = new TextEncoder(), dec = new TextDecoder();
const CORE = enc.encode("core"), TIP = enc.encode("tip");

export interface ByronLedgerRecord { core: string; tip: string }

/** The SQLite table (created before the journal triggers are, see db.ts ensureInitialized). */
export const BYRON_LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS byron_ledger (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

/** The record at the selected tip (open block included), or null when none was ever written. */
export async function loadByronLedgerRecord(): Promise<ByronLedgerRecord | null> {
    if (ledgerStoreMode() === "lmdb") {
        const st = getLedgerStore();
        if (!st) return null;
        const core = st.get(BYRON_DB, CORE);
        if (!core) return null;
        const tip = st.get(BYRON_DB, TIP);
        return { core: dec.decode(core), tip: tip ? dec.decode(tip) : "" };
    }
    try {
        const rows = (await sql`SELECT key, value FROM byron_ledger WHERE key IN ('core', 'tip')`.values()) as unknown[][];
        const m = new Map(rows.map((r) => [String(r[0]), String(r[1])]));
        const core = m.get("core");
        return core ? { core, tip: m.get("tip") ?? "" } : null;
    } catch {
        return null; // table not created yet (a database that never ran ensureInitialized)
    }
}

/**
 * Write the block's Byron state (inside the applier's block scope: the LMDB diff is open and the
 * SQLite journal names the block). `core` undefined = unchanged.
 */
export async function saveByronLedgerRecord(rec: { core?: string; tip: string }): Promise<void> {
    const st = ledgerStoreMode() !== "sqlite" ? getLedgerStore() : null;
    if (st) {
        if (rec.core !== undefined) st.put(BYRON_DB, CORE, enc.encode(rec.core));
        st.put(BYRON_DB, TIP, enc.encode(rec.tip));
    }
    if (sqlLedgerWrites()) {
        if (rec.core !== undefined) await sql`INSERT INTO byron_ledger (key, value) VALUES ('core', ${rec.core}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
        await sql`INSERT INTO byron_ledger (key, value) VALUES ('tip', ${rec.tip}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    }
}

/** Seed: copy the SQLite rows into a fresh LMDB environment (nodeLedgerStore.seedAllFromSqlite). */
export async function seedByronFromSqlite(put: (key: Uint8Array, value: Uint8Array) => void): Promise<number> {
    let rows: unknown[][] = [];
    try { rows = (await sql`SELECT key, value FROM byron_ledger`.values()) as unknown[][]; } catch { return 0; }
    for (const r of rows) put(enc.encode(String(r[0])), enc.encode(String(r[1])));
    return rows.length;
}
