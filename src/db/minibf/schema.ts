/**
 * MiniBF projection schema (non-poisoning).
 *
 * mb_* tables are derived indexes for HTTP Mini-Blockfrost only.
 * Consensus/apply NEVER reads these to decide tip or validity.
 * Ledger tables (blocks, utxo, utxo_deltas) stay authoritative.
 *
 * DDL must NOT use Bun SQL template ${} interpolation — that becomes
 * `DEFAULT ?` and SQLite rejects placeholders in CREATE TABLE.
 */

import type { SQL } from "bun";
import { logger } from "../../utils/logger";

export const MINIBF_SCHEMA_VERSION = 1;

/** Bun SQL client or open transaction handle. */
export type MbSql = SQL | {
    (strings: TemplateStringsArray, ...values: any[]): any;
    unsafe?: (q: string) => any;
    exec?: (q: string) => any;
};

function runDdl(db: MbSql, q: string): void | Promise<unknown> {
    const anyDb = db as any;
    if (typeof anyDb.unsafe === "function") return anyDb.unsafe(q);
    if (typeof anyDb.exec === "function") return anyDb.exec(q);
    // Last resort: template with no placeholders (literal SQL only)
    return (db as any)([q] as unknown as TemplateStringsArray);
}

/**
 * Create mb_* tables if missing. Safe to call every boot.
 * Does not touch ledger tables.
 */
export async function ensureMinibfSchema(db: MbSql): Promise<void> {
    const v = Number(MINIBF_SCHEMA_VERSION) | 0;

    // Cursor (single row) — literal DEFAULT, never bound ?
    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_cursor (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			tip_slot INTEGER NOT NULL DEFAULT 0,
			tip_hash BLOB,
			schema_version INTEGER NOT NULL DEFAULT ${v},
			updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
		)`,
    );

    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_tx (
			tx_hash TEXT PRIMARY KEY,
			block_hash BLOB NOT NULL,
			slot INTEGER NOT NULL,
			block_height INTEGER,
			tx_index INTEGER NOT NULL DEFAULT 0,
			fee TEXT,
			size INTEGER,
			invalid_before TEXT,
			invalid_hereafter TEXT,
			valid_contract INTEGER,
			metadata_label_count INTEGER DEFAULT 0,
			body_cbor BLOB,
			created_at INTEGER DEFAULT (strftime('%s','now'))
		)`,
    );
    await runDdl(db, `CREATE INDEX IF NOT EXISTS idx_mb_tx_slot ON mb_tx(slot)`);
    await runDdl(
        db,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_block ON mb_tx(block_hash)`,
    );

    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_tx_out (
			tx_hash TEXT NOT NULL,
			output_index INTEGER NOT NULL,
			address TEXT NOT NULL,
			payment_cred TEXT,
			stake_cred TEXT,
			lovelace TEXT NOT NULL,
			assets_json TEXT,
			datum_hash TEXT,
			inline_datum_cbor BLOB,
			script_ref_hash TEXT,
			spent_by_tx TEXT,
			spent_at_slot INTEGER,
			PRIMARY KEY (tx_hash, output_index)
		)`,
    );
    await runDdl(
        db,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_out_addr ON mb_tx_out(address)`,
    );
    await runDdl(
        db,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_out_unspent
		ON mb_tx_out(address) WHERE spent_by_tx IS NULL`,
    );

    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_tx_in (
			tx_hash TEXT NOT NULL,
			input_index INTEGER NOT NULL,
			prev_tx_hash TEXT NOT NULL,
			prev_output_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, input_index)
		)`,
    );
    await runDdl(
        db,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_in_prev
		ON mb_tx_in(prev_tx_hash, prev_output_index)`,
    );

    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_address_tx (
			address TEXT NOT NULL,
			tx_hash TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER DEFAULT 0,
			direction TEXT CHECK(direction IN ('in','out','both')),
			PRIMARY KEY (address, tx_hash)
		)`,
    );
    await runDdl(
        db,
        `CREATE INDEX IF NOT EXISTS idx_mb_address_tx_slot
		ON mb_address_tx(address, slot DESC)`,
    );

    await runDdl(
        db,
        `CREATE TABLE IF NOT EXISTS mb_block_tx (
			block_hash BLOB NOT NULL,
			tx_hash TEXT NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (block_hash, tx_hash)
		)`,
    );

    // Seed cursor row if empty (INSERT values may use binds — OK outside DDL)
    try {
        const rows = await (db as any)`SELECT id FROM mb_cursor WHERE id = 1`.values();
        if (!rows?.length) {
            await runDdl(
                db,
                `INSERT INTO mb_cursor (id, tip_slot, schema_version, updated_at)
				VALUES (1, 0, ${v}, strftime('%s','now'))`,
            );
        }
    } catch (e: any) {
        try {
            const rows2 = await (db as any)`SELECT id FROM mb_cursor WHERE id = 1`;
            if (!Array.isArray(rows2) || rows2.length === 0) {
                await runDdl(
                    db,
                    `INSERT OR IGNORE INTO mb_cursor (id, tip_slot, schema_version, updated_at)
					VALUES (1, 0, ${v}, strftime('%s','now'))`,
                );
            }
        } catch (e2: any) {
            logger.warn(
                `mb_cursor seed: ${e2?.message || e2 || e?.message || e}`,
            );
        }
    }

    logger.debug(
        `MiniBF schema ready (v${MINIBF_SCHEMA_VERSION}) — derived projections only`,
    );
}
