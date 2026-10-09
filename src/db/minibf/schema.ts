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

/**
 * v1: transactions, inputs, outputs, address and block links.
 * v2 (bug 500): block rows, metadata, mint and asset aggregates, output assets, certificates,
 * MIR transfers, withdrawals, redeemers, scripts, datums, votes and proposals (Blockfrost history
 * endpoints), plus payment / stake credentials on outputs. Rows of v1 history have none of these
 * until scripts/explorer-backfill.ts --extras runs; `mb_meta.extras_since` records the first slot
 * the live indexer wrote them for.
 */
export const MINIBF_SCHEMA_VERSION = 2;

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
export async function ensureMinibfSchema(db: MbSql, opts: { mainThread?: boolean; deferOutIndexes?: boolean } = {}): Promise<void> {
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

    await ensureMinibfV2Tables(db, opts.mainThread === true, opts.deferOutIndexes === true);

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

    // record the version and, on an upgrade of a populated file, where the v2 history starts
    try {
        const cur = await (db as any)`SELECT schema_version, tip_slot FROM mb_cursor WHERE id = 1`.values();
        const r = cur?.[0];
        const was = Number(Array.isArray(r) ? r[0] : r?.schema_version ?? 0);
        const tip = Number(Array.isArray(r) ? r[1] : r?.tip_slot ?? 0);
        if (was < 2) {
            if (tip > 0) await runDdl(db, `INSERT OR IGNORE INTO mb_meta (key, value) VALUES ('extras_since', '${Math.trunc(tip)}')`);
            await runDdl(db, `UPDATE mb_cursor SET schema_version = ${v} WHERE id = 1`);
        }
    } catch (e: any) {
        logger.warn(`mb_cursor version: ${e?.message || e}`);
    }

    logger.debug(
        `MiniBF schema ready (v${MINIBF_SCHEMA_VERSION}) — derived projections only`,
    );
}

/** v2 tables (see MINIBF_SCHEMA_VERSION). Every statement is idempotent. */
const OUT_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_mb_tx_out_stake ON mb_tx_out(stake_cred) WHERE stake_cred IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_mb_tx_out_pay ON mb_tx_out(payment_cred) WHERE payment_cred IS NOT NULL`,
];

/** The credential indexes over mb_tx_out (one table scan on a populated file; the worker builds them after it reported ready). */
export async function ensureMinibfOutIndexes(db: MbSql): Promise<void> {
    for (const q of OUT_INDEXES) await runDdl(db, q);
}

async function ensureMinibfV2Tables(db: MbSql, mainThread: boolean, deferOutIndexes: boolean): Promise<void> {
    // On the node's main thread (the ledger database's legacy mb_* tables) an index over a large
    // mb_tx_out would stall startup; there the explorer worker's own file carries them.
    let bigOut = false;
    if (mainThread) {
        try {
            const r = await (db as any)`SELECT COUNT(*) FROM (SELECT 1 FROM mb_tx_out LIMIT 100001)`.values();
            bigOut = Number(Array.isArray(r?.[0]) ? r[0][0] : Object.values(r?.[0] ?? { c: 0 })[0]) > 100_000;
        } catch { /* table missing: nothing to index */ }
    }
    const ddl = [
        `CREATE TABLE IF NOT EXISTS mb_meta (key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS mb_block (
			hash BLOB PRIMARY KEY,
			slot INTEGER NOT NULL,
			height INTEGER,
			epoch INTEGER,
			epoch_slot INTEGER,
			era INTEGER,
			size INTEGER,
			tx_count INTEGER NOT NULL DEFAULT 0,
			fees TEXT,
			output TEXT,
			slot_leader TEXT,
			vrf_key TEXT,
			op_cert TEXT,
			op_cert_counter INTEGER,
			prev_hash BLOB
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_block_slot ON mb_block(slot)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_block_height ON mb_block(height)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_block_leader ON mb_block(slot_leader, slot)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_block_epoch ON mb_block(epoch, slot)`,
        `CREATE TABLE IF NOT EXISTS mb_tx_meta (
			tx_hash TEXT NOT NULL,
			label TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			cbor BLOB NOT NULL,
			PRIMARY KEY (tx_hash, label)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_meta_label ON mb_tx_meta(label, slot, tx_index)`,
        // per-label transaction counts (/metadata/txs/labels without a GROUP BY over every row)
        `CREATE TABLE IF NOT EXISTS mb_meta_label (label TEXT PRIMARY KEY, count INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS mb_mint (
			tx_hash TEXT NOT NULL,
			unit TEXT NOT NULL,
			policy TEXT NOT NULL,
			quantity TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, unit)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_mint_unit ON mb_mint(unit, slot, tx_index)`,
        `CREATE TABLE IF NOT EXISTS mb_asset (
			unit TEXT PRIMARY KEY,
			policy TEXT NOT NULL,
			name TEXT NOT NULL,
			quantity TEXT NOT NULL,
			mint_count INTEGER NOT NULL,
			first_tx TEXT NOT NULL,
			first_slot INTEGER NOT NULL,
			first_tx_index INTEGER NOT NULL
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_asset_policy ON mb_asset(policy, first_slot, first_tx_index)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_asset_first ON mb_asset(first_slot, first_tx_index)`,
        `CREATE TABLE IF NOT EXISTS mb_tx_out_asset (
			tx_hash TEXT NOT NULL,
			output_index INTEGER NOT NULL,
			unit TEXT NOT NULL,
			quantity TEXT NOT NULL,
			PRIMARY KEY (tx_hash, output_index, unit)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_tx_out_asset_unit ON mb_tx_out_asset(unit)`,
        ...(bigOut || deferOutIndexes ? [] : OUT_INDEXES),
        `CREATE TABLE IF NOT EXISTS mb_cert (
			tx_hash TEXT NOT NULL,
			cert_index INTEGER NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			tag INTEGER NOT NULL,
			stake TEXT,
			pool TEXT,
			drep TEXT,
			coin TEXT,
			data TEXT,
			PRIMARY KEY (tx_hash, cert_index)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_cert_stake ON mb_cert(stake, slot) WHERE stake IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_mb_cert_pool ON mb_cert(pool, slot) WHERE pool IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_mb_cert_drep ON mb_cert(drep, slot) WHERE drep IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_mb_cert_tag ON mb_cert(tag, slot)`,
        `CREATE TABLE IF NOT EXISTS mb_mir (
			tx_hash TEXT NOT NULL,
			cert_index INTEGER NOT NULL,
			stake TEXT NOT NULL,
			pot TEXT NOT NULL,
			amount TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, cert_index, stake)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_mir_stake ON mb_mir(stake, slot)`,
        `CREATE TABLE IF NOT EXISTS mb_withdrawal (
			tx_hash TEXT NOT NULL,
			stake TEXT NOT NULL,
			amount TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, stake)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_withdrawal_stake ON mb_withdrawal(stake, slot)`,
        `CREATE TABLE IF NOT EXISTS mb_redeemer (
			tx_hash TEXT NOT NULL,
			purpose INTEGER NOT NULL,
			idx INTEGER NOT NULL,
			script_hash TEXT,
			data_hash TEXT NOT NULL,
			mem TEXT NOT NULL,
			steps TEXT NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, purpose, idx)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_redeemer_script ON mb_redeemer(script_hash, slot) WHERE script_hash IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS mb_script (
			hash TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			bytes BLOB NOT NULL,
			first_slot INTEGER NOT NULL,
			first_tx_index INTEGER NOT NULL DEFAULT 0
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_script_first ON mb_script(first_slot, first_tx_index)`,
        `CREATE TABLE IF NOT EXISTS mb_datum (
			hash TEXT PRIMARY KEY,
			bytes BLOB NOT NULL,
			first_slot INTEGER NOT NULL
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_datum_first ON mb_datum(first_slot)`,
        `CREATE TABLE IF NOT EXISTS mb_vote (
			tx_hash TEXT NOT NULL,
			idx INTEGER NOT NULL,
			voter_kind INTEGER NOT NULL,
			voter_hash TEXT NOT NULL,
			action_tx TEXT NOT NULL,
			action_ix INTEGER NOT NULL,
			vote INTEGER NOT NULL,
			anchor_url TEXT,
			anchor_hash TEXT,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (tx_hash, idx)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_vote_voter ON mb_vote(voter_hash, slot)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_vote_action ON mb_vote(action_tx, action_ix)`,
        `CREATE TABLE IF NOT EXISTS mb_proposal (
			tx_hash TEXT NOT NULL,
			idx INTEGER NOT NULL,
			slot INTEGER NOT NULL,
			tx_index INTEGER NOT NULL,
			deposit TEXT NOT NULL,
			return_account BLOB NOT NULL,
			action_tag INTEGER NOT NULL,
			action BLOB NOT NULL,
			anchor_url TEXT,
			anchor_hash TEXT,
			PRIMARY KEY (tx_hash, idx)
		)`,
        `CREATE INDEX IF NOT EXISTS idx_mb_proposal_slot ON mb_proposal(slot, tx_index)`,
    ];
    for (const q of ddl) await runDdl(db, q);
}
