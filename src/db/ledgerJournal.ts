/**
 * Before-image journal for the ledger state a block writes outside the UTxO set
 * (stake registrations, delegations, pool set, reward accounts, pots, governance),
 * so `rollbackChainTo` can undo those writes block by block. The UTxO set has its
 * own journal (`utxo_deltas`); before this the other tables were never reverted, and
 * a rollback followed by a re-apply halted on "already registered" (bug 63).
 *
 * SQLite triggers write one row per INSERT/UPDATE/DELETE while `apply_ctx.block_hash`
 * is set (the applier sets it per block, inside the range transaction) and
 * `apply_ctx.journaling` is 1 (off around the epoch boundary work, which is not
 * undoable by this journal — see PLAN_LEDGER_INTEGRITY.md). Column lists come from
 * `PRAGMA table_info`; values are stored as text with their SQLite type so integers
 * beyond 2^53 and BLOBs round-trip exactly.
 */
import type { SQL } from "bun";
import { sql as defaultSql } from "../sql";

export type SqlLike = Pick<SQL, "unsafe"> & ((...args: any[]) => any);

/** Tables whose block-time writes are journaled (rowid tables; verified against the schema). */
export const JOURNALED_TABLES = [
    "stake",
    "delegations",
    "stake_pointers",
    "pool_distr",
    "rewards",
    "reward_pots",
    "chain_account_state",
    "gov_proposals",
    "gov_votes",
    "gov_dreps",
    "gov_committee",
    "gov_drep_delegations",
    "gov_state",
    "gov_enacted",
    // Bug 104: a rolled-back block's leader stayed counted for the epoch (the tip node had 23
    // phantom blocks in preview epoch 1415 after 1-block forks) and its op-cert counter stayed.
    "blocks_made_by_epoch",
    "opcert_counters",
] as const;

const TRIGGER_VERSION = 1;

function q(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** `json_object('c', text-or-hex, 'c$t', typeof, …)` over OLD.* for the table's columns. */
function beforeImageExpr(cols: string[]): string {
    const parts: string[] = [];
    for (const c of cols) {
        const ref = `OLD.${q(c)}`;
        parts.push(`'${c}', CASE typeof(${ref}) WHEN 'blob' THEN hex(${ref}) WHEN 'null' THEN NULL ELSE CAST(${ref} AS TEXT) END`);
        parts.push(`'${c}$t', typeof(${ref})`);
    }
    return `json_object(${parts.join(", ")})`;
}

const GUARD = `(SELECT block_hash FROM apply_ctx WHERE id = 1) IS NOT NULL AND (SELECT journaling FROM apply_ctx WHERE id = 1) = 1`;

async function tableColumns(db: SqlLike, table: string): Promise<string[]> {
    const rows = (await db.unsafe(`PRAGMA table_info(${q(table)})`).values()) as unknown[][];
    return rows.map((r) => String(r[1]));
}

async function tableExists(db: SqlLike, table: string): Promise<boolean> {
    const rows = (await db.unsafe(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).values()) as unknown[][];
    return rows.length > 0;
}

/** Create the context row, the journal table and the triggers (idempotent). */
export async function ensureLedgerJournal(db: SqlLike = defaultSql as unknown as SqlLike): Promise<void> {
    await db.unsafe(`CREATE TABLE IF NOT EXISTS apply_ctx (id INTEGER PRIMARY KEY CHECK (id = 1), block_hash BLOB, journaling INTEGER NOT NULL DEFAULT 1)`);
    await db.unsafe(`INSERT OR IGNORE INTO apply_ctx (id, block_hash, journaling) VALUES (1, NULL, 1)`);
    await db.unsafe(`CREATE TABLE IF NOT EXISTS ledger_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_hash BLOB NOT NULL,
        tbl TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('I','U','D')),
        row_id INTEGER NOT NULL,
        before TEXT
    )`);
    await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_ledger_journal_block ON ledger_journal(block_hash)`);
    for (const table of JOURNALED_TABLES) {
        if (!(await tableExists(db, table))) continue;
        const cols = await tableColumns(db, table);
        if (cols.length === 0) continue;
        const img = beforeImageExpr(cols);
        const base = `lj_${table}_v${TRIGGER_VERSION}`;
        await db.unsafe(`CREATE TRIGGER IF NOT EXISTS ${q(`${base}_i`)} AFTER INSERT ON ${q(table)} WHEN ${GUARD}
            BEGIN INSERT INTO ledger_journal (block_hash, tbl, op, row_id, before) SELECT block_hash, '${table}', 'I', NEW.rowid, NULL FROM apply_ctx WHERE id = 1; END`);
        await db.unsafe(`CREATE TRIGGER IF NOT EXISTS ${q(`${base}_u`)} AFTER UPDATE ON ${q(table)} WHEN ${GUARD}
            BEGIN INSERT INTO ledger_journal (block_hash, tbl, op, row_id, before) SELECT block_hash, '${table}', 'U', OLD.rowid, ${img} FROM apply_ctx WHERE id = 1; END`);
        await db.unsafe(`CREATE TRIGGER IF NOT EXISTS ${q(`${base}_d`)} AFTER DELETE ON ${q(table)} WHEN ${GUARD}
            BEGIN INSERT INTO ledger_journal (block_hash, tbl, op, row_id, before) SELECT block_hash, '${table}', 'D', OLD.rowid, ${img} FROM apply_ctx WHERE id = 1; END`);
    }
}

/** The block whose writes are being journaled (null = none: writes outside a block are not journaled). */
export async function setApplyBlock(db: SqlLike, blockHash: Uint8Array | null): Promise<void> {
    await db.unsafe(`UPDATE apply_ctx SET block_hash = ? WHERE id = 1`, [blockHash ? Buffer.from(blockHash) : null] as any);
}

export async function setJournaling(db: SqlLike, on: boolean): Promise<void> {
    await db.unsafe(`UPDATE apply_ctx SET journaling = ? WHERE id = 1`, [on ? 1 : 0] as any);
}

/** Run `fn` with journaling off (epoch boundary work, migrations, repairs). */
export async function withJournalingOff<T>(db: SqlLike, fn: () => Promise<T>): Promise<T> {
    await setJournaling(db, false);
    try {
        return await fn();
    } finally {
        await setJournaling(db, true);
    }
}

function decodeValue(text: unknown, type: unknown): unknown {
    if (text == null || type === "null") return null;
    const s = String(text);
    switch (type) {
        case "blob": return Buffer.from(s, "hex");
        case "integer": { const n = BigInt(s); return n >= -(2n ** 53n) && n <= 2n ** 53n ? Number(n) : n; }
        case "real": return Number(s);
        default: return s;
    }
}

export interface JournalUndoCounts { inserted: number; updated: number; deleted: number; rows: number }

/**
 * Undo every journaled write of `blockHashes` (newest journal row first) and drop
 * those journal rows. Must run inside the caller's transaction, with journaling off
 * (the undo statements must not journal themselves).
 */
export async function undoLedgerJournal(db: SqlLike, blockHashes: Uint8Array[]): Promise<JournalUndoCounts> {
    const counts: JournalUndoCounts = { inserted: 0, updated: 0, deleted: 0, rows: 0 };
    if (blockHashes.length === 0) return counts;
    const rows: Array<[number, string, string, number, string | null]> = [];
    for (const h of blockHashes) {
        const r = (await db.unsafe(`SELECT id, tbl, op, row_id, before FROM ledger_journal WHERE block_hash = ?`, [Buffer.from(h)] as any).values()) as unknown[][];
        for (const x of r) rows.push([Number(x[0]), String(x[1]), String(x[2]), Number(x[3]), x[4] == null ? null : String(x[4])]);
    }
    rows.sort((a, b) => b[0] - a[0]);
    await setJournaling(db, false);
    try {
        for (const [, tbl, op, rowId, before] of rows) {
            counts.rows++;
            if (!(JOURNALED_TABLES as readonly string[]).includes(tbl)) continue;
            if (op === "I") {
                await db.unsafe(`DELETE FROM ${q(tbl)} WHERE rowid = ?`, [rowId] as any);
                counts.deleted++;
                continue;
            }
            const img = JSON.parse(before ?? "{}") as Record<string, unknown>;
            const cols = Object.keys(img).filter((k) => !k.endsWith("$t"));
            const values = cols.map((c) => decodeValue(img[c], img[`${c}$t`]));
            if (op === "D") {
                await db.unsafe(`INSERT OR REPLACE INTO ${q(tbl)} (rowid, ${cols.map(q).join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`, [rowId, ...values] as any);
                counts.inserted++;
            } else {
                await db.unsafe(`UPDATE ${q(tbl)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE rowid = ?`, [...values, rowId] as any);
                counts.updated++;
            }
        }
        for (const h of blockHashes) await db.unsafe(`DELETE FROM ledger_journal WHERE block_hash = ?`, [Buffer.from(h)] as any);
    } finally {
        await setJournaling(db, true);
    }
    return counts;
}

/**
 * Drop journal rows of blocks more than `keepBlocks` behind the tip (rollbacks are
 * bounded by k). Joins from the journal side: the journal holds a few thousand rows,
 * `blocks` millions (a first version scanned `blocks` on every call and cost 80 % of
 * the applier's time).
 */
export async function pruneLedgerJournal(db: SqlLike, keepBlocks = 4320): Promise<number> {
    const ids = (await db.unsafe(
        `SELECT j.id FROM ledger_journal j JOIN blocks b ON b.hash = lower(hex(j.block_hash)) WHERE b.slot < (SELECT MAX(slot) FROM blocks) - ? * 20`,
        [keepBlocks] as any,
    ).values()) as unknown[][];
    if (ids.length === 0) return 0;
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500).map((r) => Number(r[0]));
        await db.unsafe(`DELETE FROM ledger_journal WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk as any);
    }
    return ids.length;
}
