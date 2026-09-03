import { getSqlFilename, sql } from "./sql";
import { logger } from "./utils/logger";
import {
    AllegraTxBody,
    AlonzoTxBody,
    BabbageTxBody,
    ConwayTxBody,
    MaryTxBody,
    ShelleyBlock,
    ShelleyTxBody,
} from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { certStakeEffect } from "./consensus/certificateRules";
import {
    ensureMinibfSchema,
    applyMbTx,
    rollbackMbToSlot,
    getMbCursor,
    getMbTxByHash,
    getMbTxUtxos,
    getMbAddressTxs,
    getMbBlockTxHashes,
    countMbAddressTxs,
    getMbIndexStats,
    type MbTxIn,
    type MbTxOut,
} from "./db/minibf";
import {
    extractLedgerTxOutMetadata,
    parseStoredTxOut,
} from "./db/minibf/txOutMetadata";

/** Optional Bun SQL client / transaction handle for batch hydrate. */
export type SqlClient = typeof sql;

/**
 * Density-prefill knobs (env, process-wide). Default OFF so live/tip apply
 * still writes the rollback diary + MiniBF forward index.
 *   APPLY_SKIP_DELTAS=1 — skip utxo_deltas inserts (no rollback-from-log)
 *   APPLY_SKIP_INDEX=1  — skip tx_index / address_tx / mb_* forward index
 */
export function applySkipDeltas(): boolean {
    return process.env.APPLY_SKIP_DELTAS === "1";
}
export function applySkipIndex(): boolean {
    return bulkSyncSkipIndex || process.env.APPLY_SKIP_INDEX === "1";
}

let bulkSyncSkipIndex = false;
/** Runtime equivalent of APPLY_SKIP_INDEX=1, toggled by the orchestrator while far behind the tip (config sync.skipIndexWhileBehind). */
export function setBulkSyncIndexSkip(on: boolean): boolean {
    const changed = bulkSyncSkipIndex !== on;
    bulkSyncSkipIndex = on;
    return changed;
}

async function insertUtxoDelta(
    db: SqlClient,
    blockHash: Uint8Array,
    action: string,
    utxo: string,
): Promise<void> {
    if (applySkipDeltas()) return;
    await db`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (${blockHash}, ${action}, ${utxo})`;
}

interface HeaderInsertData {
    slot: bigint;
    headerHash: string;
    rollforward_header_cbor: Uint8Array;
}

interface BlockInsertData {
    slot: bigint;
    blockHash: string;
    prevHash: string;
    /** Chain height (Blockfrost `height`): main blocks only, Byron EBBs are null. */
    blockNo: number | null;
    headerData: Uint8Array;
    /** BlockFetch payload as received: `[era, block]`. Served as-is and decoded by MultiEraBlock.fromCbor. */
    blockData: Uint8Array;
}

interface ImmutableChunk {
    chunk_no: number;
    tip_hash: string;
    tip_slot_no: bigint;
    slot_range_start: bigint;
    slot_range_end: bigint;
}

type TxBody =
    | ShelleyTxBody
    | AllegraTxBody
    | MaryTxBody
    | AlonzoTxBody
    | BabbageTxBody
    | ConwayTxBody;

// Top-level functions for database operations

/**
 * SQLite tuning. WAL lets readers (MiniBF, /metrics) run while the applier
 * writes, and `synchronous=NORMAL` skips the per-statement fsync of the
 * rollback journal (WAL is still fsynced at checkpoints; a power cut can lose
 * the last transactions, never corrupt the file — the node re-syncs them).
 */
export async function applySqlitePragmas(): Promise<{ journalMode: string; synchronous: number }> {
    await sql`PRAGMA journal_mode = WAL`;
    await sql`PRAGMA synchronous = NORMAL`;
    await sql`PRAGMA temp_store = MEMORY`;
    await sql`PRAGMA cache_size = -65536`; // 64 MiB page cache
    const jm = (await sql`PRAGMA journal_mode`.values()) as unknown[][];
    const sy = (await sql`PRAGMA synchronous`.values()) as unknown[][];
    return { journalMode: String(jm[0]?.[0] ?? "?"), synchronous: Number(sy[0]?.[0] ?? -1) };
}

export async function ensureInitialized(): Promise<void> {
    const pragmas = await applySqlitePragmas();
    // Volatile headers table
    await sql`
		CREATE TABLE IF NOT EXISTS volatile_headers (
			slot BIGINT PRIMARY KEY,
			header_hash TEXT NOT NULL UNIQUE,
			rollforward_header_cbor BLOB NOT NULL,
			is_valid BOOLEAN DEFAULT TRUE
		)
	`;

    // Protocol parameters table
    await sql`
		CREATE TABLE IF NOT EXISTS protocol_params (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			params JSONB
		)
	`;

    // Chain account state table
    await sql`
		CREATE TABLE IF NOT EXISTS chain_account_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			treasury INTEGER,
			reserves INTEGER
		)
	`;

    // Pool distribution table
    await sql`
		CREATE TABLE IF NOT EXISTS pool_distr (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pools JSONB,
			total_active_stake INTEGER
		)
	`;

    // Blocks made table
    await sql`
		CREATE TABLE IF NOT EXISTS blocks_made (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pool_key_hash BLOB,
			epoch INTEGER,
			block_count INTEGER,
			status TEXT CHECK(status IN ('CURR', 'PREV', 'LEGACY')) NOT NULL DEFAULT 'CURR',
			UNIQUE(pool_key_hash, epoch)
		)
	`;

    // Stake table
    await sql`
		CREATE TABLE IF NOT EXISTS stake (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			amount INTEGER
		)
	`;

    // Delegations table
    await sql`
		CREATE TABLE IF NOT EXISTS delegations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			pool_key_hash BLOB
		)
	`;

    // Keyed lookups by credential (BlockBodyValidator): without these every
    // certificate check would scan tables that reach millions of rows on mainnet.
    await sql`CREATE INDEX IF NOT EXISTS idx_stake_credentials ON stake(stake_credentials)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_delegations_credentials ON delegations(stake_credentials)`;

    // Rewards table
    await sql`
		CREATE TABLE IF NOT EXISTS rewards (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_credentials BLOB,
			amount INTEGER
		)
	`;

    // Likelihoods table (for non-myopic)
    await sql`
		CREATE TABLE IF NOT EXISTS likelihoods (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			pool_key_hash BLOB,
			likelihood JSONB
		)
	`;

    // UTxO table
    await sql`
		CREATE TABLE IF NOT EXISTS utxo (
			utxo_ref TEXT PRIMARY KEY,
			tx_out TEXT,
			tx_hash TEXT,
			address TEXT,
			lovelace INTEGER,
			reference_script_hash TEXT
		)
	`;
    // Plain column indexes. The former json_extract() expression indexes were
    // re-evaluated on every insert and delete of the hottest table on the sync path.
    // A database created before the side columns existed opens fine (CREATE IF NOT
    // EXISTS is a no-op) and would then fail on the first insert: add the columns and
    // backfill them from the JSON once.
    const utxoCols = new Set(
        ((await sql`PRAGMA table_info(utxo)`.values()) as unknown[][]).map((r) => String(r[1])),
    );
    for (const [col, type] of [["address", "TEXT"], ["lovelace", "INTEGER"], ["reference_script_hash", "TEXT"]] as const) {
        if (!utxoCols.has(col)) {
            logger.warn(`utxo table predates the indexed side columns; adding ${col} and backfilling`);
            await sql.unsafe(`ALTER TABLE utxo ADD COLUMN ${col} ${type}`);
        }
    }
    if (!utxoCols.has("address")) await sql.unsafe(BACKFILL_UTXO_COLUMNS_SQL);
    await sql`CREATE INDEX IF NOT EXISTS idx_utxo_address ON utxo(address)`;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_utxo_reference_script_hash
        ON utxo(reference_script_hash) WHERE reference_script_hash IS NOT NULL
    `;

    // Certificate state table
    await sql`
		CREATE TABLE IF NOT EXISTS cert_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data JSONB
		)
	`;

    // Pulsing reward update table
    await sql`
		CREATE TABLE IF NOT EXISTS pulsing_rew_update (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data JSONB
		)
	`;

    // Stashed AVVM addresses table
    await sql`
		CREATE TABLE IF NOT EXISTS stashed_avvm_addresses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			addresses JSONB
		)
	`;

    // Non-myopic table
    await sql`
		CREATE TABLE IF NOT EXISTS non_myopic (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			reward_pot INTEGER,
			likelihoods_id INTEGER,
			FOREIGN KEY (likelihoods_id) REFERENCES likelihoods(id)
		)
	`;

    // Ledger state table
    await sql`
		CREATE TABLE IF NOT EXISTS ledger_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			utxo_deposited INTEGER,
			utxo_fees INTEGER,
			utxo_donation INTEGER,
			utxo_gov_state BLOB,
			utxo_instant_stake BLOB,
			cert_state_id INTEGER,
			FOREIGN KEY (cert_state_id) REFERENCES cert_state(id)
		)
	`;

    // Snapshots table
    await sql`
		CREATE TABLE IF NOT EXISTS snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stake_id INTEGER,
			rewards_id INTEGER,
			delegations_id INTEGER,
			FOREIGN KEY (stake_id) REFERENCES stake(id),
			FOREIGN KEY (rewards_id) REFERENCES rewards(id),
			FOREIGN KEY (delegations_id) REFERENCES delegations(id)
		)
	`;

    // Epoch state table
    await sql`
		CREATE TABLE IF NOT EXISTS epoch_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chain_account_state_id INTEGER,
			ledger_state_id INTEGER,
			snapshots_id INTEGER,
			non_myopic_id INTEGER,
			pparams_id INTEGER,
			FOREIGN KEY (chain_account_state_id) REFERENCES chain_account_state(id),
			FOREIGN KEY (ledger_state_id) REFERENCES ledger_state(id),
			FOREIGN KEY (snapshots_id) REFERENCES snapshots(id),
			FOREIGN KEY (non_myopic_id) REFERENCES non_myopic(id),
			FOREIGN KEY (pparams_id) REFERENCES protocol_params(id)
		)
	`;

    // New epoch state table (root)
    await sql`
		CREATE TABLE IF NOT EXISTS new_epoch_state (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			last_epoch_modified INTEGER,
			prev_blocks_id INTEGER,
			curr_blocks_id INTEGER,
			epoch_state_id INTEGER,
			pulsing_rew_update_id INTEGER,
			pool_distr_id INTEGER,
			stashed_avvm_addresses_id INTEGER,
			FOREIGN KEY (prev_blocks_id) REFERENCES blocks_made(id),
			FOREIGN KEY (curr_blocks_id) REFERENCES blocks_made(id),
			FOREIGN KEY (epoch_state_id) REFERENCES epoch_state(id),
			FOREIGN KEY (pulsing_rew_update_id) REFERENCES pulsing_rew_update(id),
			FOREIGN KEY (pool_distr_id) REFERENCES pool_distr(id),
			FOREIGN KEY (stashed_avvm_addresses_id) REFERENCES stashed_avvm_addresses(id)
		)
	`;

    // Immutable chunks table
    await sql`
		CREATE TABLE IF NOT EXISTS immutable_chunks (
			chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
			chunk_no INTEGER NOT NULL UNIQUE,
			tip_hash TEXT NOT NULL,
			tip_slot_no BIGINT NOT NULL,
			slot_range_start BIGINT NOT NULL,
			slot_range_end BIGINT NOT NULL,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
		)
	`;

    // Immutable blocks table
    await sql`
		CREATE TABLE IF NOT EXISTS immutable_blocks (
			slot INTEGER PRIMARY KEY,
			block_hash BLOB NOT NULL,
			block_data BLOB NOT NULL,
			prev_hash BLOB,
			header_data BLOB,
			rollforward_header_cbor BLOB,
			chunk_id INTEGER,
			block_no INTEGER,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now')),
			UNIQUE(block_hash),
			FOREIGN KEY (chunk_id) REFERENCES immutable_chunks(chunk_id) ON DELETE CASCADE
		)
	`;

    // Stable state table
    await sql`
		CREATE TABLE IF NOT EXISTS stable_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			immutable_tip_hash BLOB,
			immutable_tip_slot INTEGER,
			total_blocks INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;

    // Volatile blocks table
    await sql`
		CREATE TABLE IF NOT EXISTS blocks (
			hash BLOB PRIMARY KEY,
			slot INTEGER NOT NULL,
			header_data BLOB,
			block_data BLOB,
			is_valid BOOLEAN DEFAULT TRUE,
			prev_hash BLOB,
			block_no INTEGER,
			inserted_at TIMESTAMP DEFAULT (strftime('%s','now'))
		)
	`;
    // Height column for databases created before it existed; heights are then
    // filled by backfillBlockHeights() at startup.
    for (const table of ["blocks", "immutable_blocks"] as const) {
        const cols = ((await sql.unsafe(`PRAGMA table_info(${table})`).values()) as unknown[][]).map((r) => String(r[1]));
        if (!cols.includes("block_no")) {
            logger.warn(`${table} predates block heights; adding block_no (backfilled at startup)`);
            await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN block_no INTEGER`);
        }
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_volatile_block_no ON blocks (block_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_immutable_block_no ON immutable_blocks (block_no)`;

    // UTxO deltas table
    await sql`
		CREATE TABLE IF NOT EXISTS utxo_deltas (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			block_hash BLOB NOT NULL,
			action TEXT NOT NULL CHECK(action IN ('spend', 'create', 'cert', 'fee', 'withdrawal')),
			utxo JSONB NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;

    // Indexes for volatile_headers
    await sql`
		CREATE INDEX IF NOT EXISTS idx_volatile_headers_hash ON volatile_headers(header_hash);
		CREATE INDEX IF NOT EXISTS idx_volatile_headers_slot ON volatile_headers(slot);
	`;

    // Indexes for volatile blocks
    await sql`
		CREATE INDEX IF NOT EXISTS idx_volatile_slot ON blocks (slot);
		CREATE INDEX IF NOT EXISTS idx_volatile_hash ON blocks (hash);
		CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON blocks (prev_hash);
	`;

    // Indexes for immutable blocks
    await sql`
		CREATE INDEX IF NOT EXISTS idx_immutable_slot ON immutable_blocks (slot);
		CREATE INDEX IF NOT EXISTS idx_immutable_hash ON immutable_blocks (block_hash);
		CREATE INDEX IF NOT EXISTS idx_immutable_chunk ON immutable_blocks (chunk_id);
	`;

    // Index for utxo table
    await sql`
		CREATE INDEX IF NOT EXISTS idx_utxo_tx_hash ON utxo(tx_hash)
	`;

    // The old `gc_volatile` AFTER INSERT trigger ran two DELETEs with an
    // un-indexed `is_valid = FALSE` predicate on *every* block insert: O(rows)
    // per block (15 ms at 14k blocks, growing linearly). GC now runs from the
    // applier every VOLATILE_GC_EVERY_BLOCKS blocks (`gcVolatile`) over
    // partial indexes that only contain invalid rows.
    // Registry of genesis UTxO refs (spent or not) so the UI can report
    // "N of M genesis outputs unspent" with one indexed join.
    await sql`
        CREATE TABLE IF NOT EXISTS genesis_utxo (
            utxo_ref TEXT PRIMARY KEY,
            address TEXT NOT NULL,
            lovelace TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('nonavvm','avvm'))
        )
    `;
    await sql`DROP TRIGGER IF EXISTS gc_volatile`;
    await sql`CREATE INDEX IF NOT EXISTS idx_blocks_invalid ON blocks(slot) WHERE is_valid = FALSE`;
    await sql`CREATE INDEX IF NOT EXISTS idx_volatile_headers_invalid ON volatile_headers(slot) WHERE is_valid = FALSE`;

    // Epoch nonces (η0) — local TICKN/UPDN store; external bootstrap fills mid-chain starts
    await sql`
		CREATE TABLE IF NOT EXISTS epoch_nonces (
			epoch INTEGER PRIMARY KEY,
			nonce_hex TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'external',
			evolving_hex TEXT,
			candidate_hex TEXT,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;


    // Mini-BF query indexes (empty until backfill / forward apply — not soak hot path)
    await sql`
		CREATE TABLE IF NOT EXISTS tx_index (
			tx_hash TEXT PRIMARY KEY,
			block_hash BLOB,
			slot INTEGER NOT NULL,
			fee TEXT,
			size INTEGER,
			invalid_hereafter TEXT,
			invalid_before TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`;
    await sql`CREATE INDEX IF NOT EXISTS idx_tx_index_slot ON tx_index(slot)`;

    await sql`
		CREATE TABLE IF NOT EXISTS address_tx (
			address TEXT NOT NULL,
			tx_hash TEXT NOT NULL,
			slot INTEGER NOT NULL,
			direction TEXT CHECK(direction IN ('in','out','both')),
			PRIMARY KEY (address, tx_hash)
		)
	`;
    await sql`CREATE INDEX IF NOT EXISTS idx_address_tx_addr_slot ON address_tx(address, slot DESC)`;

    await sql`
		CREATE TABLE IF NOT EXISTS block_tx (
			block_hash BLOB NOT NULL,
			tx_hash TEXT NOT NULL,
			tx_index INTEGER NOT NULL,
			PRIMARY KEY (block_hash, tx_hash)
		)
	`;

    // MiniBF derived projections (mb_*) — never poison ledger tables
    await ensureMinibfSchema(sql);

    logger.info(`DB initialized (journal_mode=${pragmas.journalMode}, synchronous=${pragmas.synchronous})`);
}

/** Local epoch η0 (hex). Null if not yet stored. */
export async function getEpochNonce(epoch: number): Promise<string | null> {
    const rows = await sql`
		SELECT nonce_hex FROM epoch_nonces WHERE epoch = ${epoch} LIMIT 1
	`.values();
    if (!rows.length) return null;
    const row = rows[0] as any;
    const hex = Array.isArray(row) ? row[0] : row?.nonce_hex;
    return typeof hex === "string" && hex.length > 0 ? hex : null;
}

/** Full nonce row for UPDN evolution (phase 2). */
export async function getEpochNonceState(epoch: number): Promise<{
    epoch: number;
    nonce_hex: string;
    source: string;
    evolving_hex: string | null;
    candidate_hex: string | null;
} | null> {
    const rows = await sql`
		SELECT epoch, nonce_hex, source, evolving_hex, candidate_hex
		FROM epoch_nonces WHERE epoch = ${epoch} LIMIT 1
	`.values();
    if (!rows.length) return null;
    const r = rows[0] as any;
    if (Array.isArray(r)) {
        return {
            epoch: Number(r[0]),
            nonce_hex: String(r[1]),
            source: String(r[2] ?? "external"),
            evolving_hex: r[3] != null ? String(r[3]) : null,
            candidate_hex: r[4] != null ? String(r[4]) : null,
        };
    }
    return {
        epoch: Number(r.epoch),
        nonce_hex: String(r.nonce_hex),
        source: String(r.source ?? "external"),
        evolving_hex: r.evolving_hex != null ? String(r.evolving_hex) : null,
        candidate_hex: r.candidate_hex != null ? String(r.candidate_hex) : null,
    };
}

/**
 * Persist epoch η0 (and optional evolving/candidate). Row-by-row UPSERT.
 * source: 'local' | 'external' | 'tickn'
 */
export async function storeEpochNonce(
    epoch: number,
    nonceHex: string,
    source: string = "external",
    evolvingHex?: string | null,
    candidateHex?: string | null,
): Promise<void> {
    await sql`
		INSERT INTO epoch_nonces (epoch, nonce_hex, source, evolving_hex, candidate_hex, updated_at)
		VALUES (
			${epoch},
			${nonceHex},
			${source},
			${evolvingHex ?? null},
			${candidateHex ?? null},
			CURRENT_TIMESTAMP
		)
		ON CONFLICT(epoch) DO UPDATE SET
			nonce_hex = excluded.nonce_hex,
			source = excluded.source,
			evolving_hex = excluded.evolving_hex,
			candidate_hex = excluded.candidate_hex,
			updated_at = CURRENT_TIMESTAMP
	`;
}

/**
 * Positional row (sql`…`.values()): [id, chunk_id, slot, block_hash, prev_hash,
 * header_data, block_data, rollforward_header_cbor, is_valid, inserted_at, block_no].
 * `block_data` is the BlockFetch payload `[era, block]` as received.
 */
export async function getBlockByHash(hash: string): Promise<any> {
    // `blocks.hash` has been written both as hex TEXT and as a raw BLOB; match either.
    const hex = hash.toLowerCase();
    const blob = /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
    const result = await sql`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, prev_hash, header_data, block_data, NULL as rollforward_header_cbor, is_valid, inserted_at, block_no
			FROM blocks WHERE hash = ${hex} OR hash = ${blob}
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, NULL as is_valid, inserted_at, block_no
			FROM immutable_blocks WHERE block_hash = ${hex} OR block_hash = ${blob}
		`.values();
    return result[0] || null;
}

export async function getBlockBySlot(slot: bigint): Promise<any> {
    const result = await sql`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, prev_hash, header_data, block_data, NULL as rollforward_header_cbor, is_valid, inserted_at, block_no
			FROM blocks WHERE slot = ${slot}
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, NULL as is_valid, inserted_at, block_no
			FROM immutable_blocks WHERE slot = ${slot}
		`.values();
    return result[0] || null;
}

/** Bun sql`.values()` → [[v]]; without `.values()` → [{max_slot:v}]. Handle both. */
function firstScalar(row: unknown): unknown {
    if (row == null) return undefined;
    if (Array.isArray(row)) return row[0];
    if (typeof row === "object") {
        const o = row as Record<string, unknown>;
        // prefer named keys used by callers
        if ("max_slot" in o) return o.max_slot;
        if ("next_chunk" in o) return o.next_chunk;
        const vals = Object.values(o);
        return vals.length ? vals[0] : undefined;
    }
    return row;
}

// ─── block heights (explorer M1) ───────────────────────────────────────────

/** Newest-first list row for the explorer. */
export interface BlockListRow {
    slot: number;
    hash: string;
    prevHash: string | null;
    blockNo: number | null;
    size: number | null;
    /** BlockFetch payload `[era, block]` (null when the DB predates it). */
    blockData: Uint8Array | null;
    headerData: Uint8Array | null;
}

function toBlockListRow(r: unknown[]): BlockListRow {
    return {
        slot: Number(r[0]),
        hash: blobToHexLower(r[1]),
        prevHash: r[2] == null ? null : blobToHexLower(r[2]),
        blockNo: r[3] == null ? null : Number(r[3]),
        size: r[4] == null ? null : Number(r[4]),
        blockData: r[5] instanceof Uint8Array ? r[5] : null,
        headerData: r[6] instanceof Uint8Array ? r[6] : null,
    };
}

function blobToHexLower(v: unknown): string {
    if (typeof v === "string") return v.toLowerCase();
    if (v instanceof Uint8Array) return toHex(v);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return toHex(new Uint8Array(v));
    return String(v ?? "");
}

const BLOCK_LIST_COLS = "slot, hash, prev_hash, block_no, length(block_data), block_data, header_data";

/**
 * Blocks newest first. A Byron epoch-boundary block shares its slot with the
 * epoch's first main block; the main block (block_no set) sorts first.
 * `before` is an exclusive cursor: `{slot}` (and an optional `ebb` flag telling
 * whether the cursor block itself was an EBB, so paging can stop between the two
 * blocks of one slot).
 */
export async function listBlocksDesc(opts: { limit: number; beforeSlot?: number; beforeIsEbb?: boolean }): Promise<BlockListRow[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
    let rows: unknown[][];
    if (opts.beforeSlot == null) {
        rows = (await sql.unsafe(
            `SELECT ${BLOCK_LIST_COLS} FROM blocks ORDER BY slot DESC, (block_no IS NULL) ASC, block_no DESC LIMIT ${limit}`,
        ).values()) as unknown[][];
    } else if (opts.beforeIsEbb) {
        rows = (await sql.unsafe(
            `SELECT ${BLOCK_LIST_COLS} FROM blocks WHERE slot < ${Math.trunc(opts.beforeSlot)} ORDER BY slot DESC, (block_no IS NULL) ASC, block_no DESC LIMIT ${limit}`,
        ).values()) as unknown[][];
    } else {
        // cursor was a main block: the EBB of the same slot (if any) comes next
        rows = (await sql.unsafe(
            `SELECT ${BLOCK_LIST_COLS} FROM blocks WHERE slot < ${Math.trunc(opts.beforeSlot)} OR (slot = ${Math.trunc(opts.beforeSlot)} AND block_no IS NULL) ORDER BY slot DESC, (block_no IS NULL) ASC, block_no DESC LIMIT ${limit}`,
        ).values()) as unknown[][];
    }
    return rows.map(toBlockListRow);
}

/** Blocks of one slot range, oldest first (epoch pages). */
export async function listBlocksInSlotRange(fromSlot: number, toSlotExclusive: number, limit: number, offset = 0): Promise<BlockListRow[]> {
    const rows = (await sql`
        SELECT slot, hash, prev_hash, block_no, length(block_data), block_data, header_data FROM blocks
        WHERE slot >= ${Math.trunc(fromSlot)} AND slot < ${Math.trunc(toSlotExclusive)}
        ORDER BY slot ASC, (block_no IS NULL) DESC, block_no ASC
        LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))} OFFSET ${Math.max(0, Math.trunc(offset))}
    `.values()) as unknown[][];
    return rows.map(toBlockListRow);
}

export async function countBlocksInSlotRange(fromSlot: number, toSlotExclusive: number): Promise<number> {
    return countQuery(sql`SELECT COUNT(*) as c FROM blocks WHERE slot >= ${Math.trunc(fromSlot)} AND slot < ${Math.trunc(toSlotExclusive)}`);
}

export async function getBlockListRowByHash(hashHex: string): Promise<BlockListRow | null> {
    const hex = hashHex.toLowerCase();
    const blob = /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
    const rows = (await sql`
        SELECT slot, hash, prev_hash, block_no, length(block_data), block_data, header_data FROM blocks
        WHERE hash = ${hex} OR hash = ${blob} LIMIT 1
    `.values()) as unknown[][];
    return rows.length ? toBlockListRow(rows[0]!) : null;
}

export async function getBlockListRowBySlot(slot: number): Promise<BlockListRow | null> {
    const rows = (await sql`
        SELECT slot, hash, prev_hash, block_no, length(block_data), block_data, header_data FROM blocks
        WHERE slot = ${Math.trunc(slot)} ORDER BY (block_no IS NULL) ASC LIMIT 1
    `.values()) as unknown[][];
    return rows.length ? toBlockListRow(rows[0]!) : null;
}

export async function getBlockListRowByHeight(blockNo: number): Promise<BlockListRow | null> {
    const rows = (await sql`
        SELECT slot, hash, prev_hash, block_no, length(block_data), block_data, header_data FROM blocks
        WHERE block_no = ${Math.trunc(blockNo)} LIMIT 1
    `.values()) as unknown[][];
    return rows.length ? toBlockListRow(rows[0]!) : null;
}

export async function getMaxBlockNo(): Promise<number> {
    const rows = (await sql`SELECT MAX(block_no) FROM blocks`.values()) as unknown[][];
    const v = rows[0]?.[0];
    return v == null ? 0 : Number(v);
}

/** Transactions in a block (mb_block_tx, then the legacy block_tx). */
export async function countBlockTxs(hashHex: string): Promise<number> {
    const key = hashHex.toUpperCase();
    try {
        const n = await countQuery(sql`SELECT COUNT(*) as c FROM mb_block_tx WHERE hex(block_hash) = ${key}`);
        if (n > 0) return n;
    } catch {
        /* table may not exist */
    }
    try {
        return await countQuery(sql`SELECT COUNT(*) as c FROM block_tx WHERE hex(block_hash) = ${key}`);
    } catch {
        return 0;
    }
}

/**
 * Number every block that has no height yet. One main block per slot, so the
 * height of a main block is its rank among main blocks ordered by slot; EBBs
 * (era byte 0) stay null. Set-based: a temp table with ROW_NUMBER() and an
 * index, then one UPDATE — seconds for millions of rows. Runs at startup only
 * when heights are missing (an old database), before the servers start.
 */
export async function backfillBlockHeights(): Promise<{ numbered: number }> {
    const missing = await countQuery(sql`SELECT COUNT(*) as c FROM blocks WHERE block_no IS NULL AND hex(substr(block_data, 2, 1)) <> '00'`);
    if (missing === 0) return { numbered: 0 };
    logger.warn(`Block heights missing for ${missing} block(s); numbering the chain (set-based, one pass)`);
    const t0 = performance.now();
    await sql.unsafe(`DROP TABLE IF EXISTS temp.block_heights`);
    await sql.unsafe(
        `CREATE TEMP TABLE block_heights AS
         SELECT hash, ROW_NUMBER() OVER (ORDER BY slot ASC) AS rn
         FROM blocks WHERE hex(substr(block_data, 2, 1)) <> '00'`,
    );
    await sql.unsafe(`CREATE INDEX temp.idx_block_heights_hash ON block_heights(hash)`);
    await sql.unsafe(
        `UPDATE blocks SET block_no = (SELECT rn FROM temp.block_heights bh WHERE bh.hash = blocks.hash)
         WHERE block_no IS NULL AND hex(substr(block_data, 2, 1)) <> '00'`,
    );
    await sql.unsafe(`DROP TABLE IF EXISTS temp.block_heights`);
    const height = await getMaxBlockNo();
    logger.info(`Block heights: numbered ${missing} block(s) in ${Math.round(performance.now() - t0)} ms, tip height ${height}`);
    return { numbered: missing };
}

export async function getMaxSlot(): Promise<bigint> {
    // Prefer object rows; still tolerate `.values()` array-of-arrays.
    const result = await sql`SELECT MAX(slot) as max_slot FROM blocks`;
    const raw = firstScalar(Array.isArray(result) ? result[0] : result);
    if (raw == null) return 0n;
    return BigInt(raw as string | number | bigint);
}

/**
 * Most recent applied block headers (raw `header_data`), newest first.
 * Used to seed Byron OBFT signature-window state after a restart.
 */
export async function getRecentBlockHeaders(
    limit: number,
): Promise<Array<{ slot: bigint; header_data: Uint8Array }>> {
    const n = Math.max(1, Math.min(100_000, Math.trunc(limit)));
    const rows = await sql`SELECT slot, header_data FROM blocks WHERE header_data IS NOT NULL AND is_valid = TRUE ORDER BY slot DESC LIMIT ${n}`;
    const out: Array<{ slot: bigint; header_data: Uint8Array }> = [];
    for (const row of rows as any[]) {
        const slot = Array.isArray(row) ? row[0] : row.slot;
        const hd = Array.isArray(row) ? row[1] : row.header_data;
        if (hd instanceof Uint8Array && slot != null) out.push({ slot: BigInt(slot), header_data: hd });
    }
    return out;
}

export async function getValidHeadersBefore(
    cutoffSlot: bigint,
): Promise<any[]> {
    return await sql`SELECT * FROM volatile_headers WHERE slot < ${cutoffSlot} AND is_valid = TRUE ORDER BY slot ASC`
        .values();
}

export async function getValidBlocksBefore(cutoffSlot: bigint): Promise<any[]> {
    return await sql`SELECT * FROM blocks WHERE slot < ${cutoffSlot} AND is_valid = TRUE ORDER BY slot ASC`
        .values();
}

export async function getNextChunk(): Promise<{ next_chunk: number }> {
    const result =
        await sql`SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks`;
    const raw = firstScalar(Array.isArray(result) ? result[0] : result);
    return { next_chunk: Number(raw ?? 1) };
}

export async function getLedgerSnapshot(snapshotNo: number): Promise<any> {
    const result =
        await sql`SELECT * FROM ledger_snapshots WHERE snapshot_no = ${snapshotNo}`
            .values();
    return result[0] || null;
}

export async function insertHeaderBatchVolatile(
    records: Array<HeaderInsertData>,
): Promise<void> {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map((r) => r.headerHash));
    if (hashes.size !== records.length) {
        logger.warn(
            `Batch has ${records.length - hashes.size} duplicate hashes!`,
        );
    }

    // Bun SQLite rejects multi-row VALUES ${sql([...])} — row-by-row.
    // No sql.begin(): concurrent rollForward must not nest BEGIN on the shared connection.
    for (const r of records) {
        await sql`
			INSERT OR IGNORE INTO volatile_headers
			(slot, header_hash, rollforward_header_cbor)
			VALUES (${r.slot}, ${r.headerHash}, ${r.rollforward_header_cbor})
		`;
    }
    logger.debug(
        `Committed ${records.length} headers to volatile_headers (ignored dups)`,
    );
}

export async function insertBlockVolatile(
    block: BlockInsertData,
): Promise<void> {
    // Volatile store is table `blocks` (not volatile_blocks).
    await sql`
			INSERT INTO blocks (hash, slot, prev_hash, header_data, block_data, is_valid, block_no)
			VALUES (${block.blockHash}, ${Number(block.slot)}, ${block.prevHash}, ${block.headerData}, ${block.blockData}, ${true}, ${block.blockNo})
			ON CONFLICT(hash) DO UPDATE SET
				slot = excluded.slot,
				prev_hash = excluded.prev_hash,
				header_data = excluded.header_data,
				block_data = excluded.block_data,
				is_valid = excluded.is_valid,
				block_no = excluded.block_no
		`;
}

export async function insertBlockBatchVolatile(
    records: Array<BlockInsertData>,
): Promise<void> {
    if (records.length === 0) return;

    // Pre-check for dups in batch (debug only; Map prevents)
    const hashes = new Set(records.map((r) => r.blockHash));
    if (hashes.size !== records.length) {
        logger.warn(
            `Batch has ${records.length - hashes.size} duplicate hashes!`,
        );
    }

    // One row per block (the stub row applyBlock used to write first is gone).
    for (const r of records) await insertBlockVolatile(r);
    logger.debug(
        `Committed ${records.length} blocks to volatile_blocks (ignored dups)`,
    );
}

export async function insertChunk(chunk: ImmutableChunk): Promise<number> {
    await sql`
			INSERT INTO immutable_chunks (chunk_no, tip_hash, tip_slot_no, slot_range_start, slot_range_end)
			VALUES (${chunk.chunk_no}, ${chunk.tip_hash}, ${chunk.tip_slot_no}, ${chunk.slot_range_start}, ${chunk.slot_range_end})
		`;
    const result = await sql`SELECT last_insert_rowid()`.values();
    return Number(result[0]["last_insert_rowid()"]);
}

export async function insertImmutableBlocks(
    blocks: any[],
    chunk_id: number,
): Promise<void> {
    for (const block of blocks) {
        await sql`
				INSERT INTO immutable_blocks (slot, block_hash, block_data, prev_hash, header_data, rollforward_header_cbor, chunk_id, block_no)
				VALUES (${block.slot}, ${block.block_hash}, ${block.block_data}, ${block.prev_hash}, ${block.header_data}, ${block.rollforward_header_cbor}, ${chunk_id}, ${block.block_no ?? null})
			`;
    }
}

export async function deleteVolatileBlocks(
    blockHashes: string[],
): Promise<void> {
    await sql`DELETE FROM blocks WHERE hash IN ${sql(blockHashes)}`;
}

export async function deleteVolatileHeaders(
    headerHashes: string[],
): Promise<void> {
    await sql`DELETE FROM volatile_headers WHERE header_hash IN ${
        sql(headerHashes)
    }`;
}

export async function createChunk(oldBlocks: any[]): Promise<ImmutableChunk> {
    if (oldBlocks.length === 0) throw new Error("No blocks to chunk");

    // Assume oldBlocks sorted by slot ASC
    const firstBlock = oldBlocks[0];
    const lastBlock = oldBlocks[oldBlocks.length - 1];

    // Get next chunk_no
    const nextChunk = await getNextChunk();
    const chunk_no = nextChunk.next_chunk;

    return {
        chunk_no,
        tip_hash: lastBlock.hash,
        tip_slot_no: lastBlock.slot,
        slot_range_start: firstBlock.slot,
        slot_range_end: lastBlock.slot,
    };
}

function logDbError(operation: string, err: unknown): void {
    logger.error(`DB ${operation} failed:`, err);
}

export async function compact(): Promise<void> {
    const cutoff = (await getMaxSlot()) - BigInt(2160);
    const oldBlocks = await getValidBlocksBefore(cutoff);
    const oldHeaders = await getValidHeadersBefore(cutoff);

    if (oldBlocks.length === 0) return;

    const headerMap = new Map(
        oldHeaders.map((h: any) => [h.header_hash, h.rollforward_header_cbor]),
    );
    for (const block of oldBlocks) {
        block.rollforward_header_cbor = headerMap.get(block.hash) ??
            new Uint8Array(0);
    }

    const chunk = await createChunk(oldBlocks);
    let chunk_id!: number;
    try {
        chunk_id = await insertChunk(chunk);
    } catch (err) {
        logDbError("insert chunk", err);
        throw err;
    }
    try {
        await insertImmutableBlocks(oldBlocks, chunk_id);
    } catch (err) {
        logDbError("insert immutable_blocks", err);
        throw err;
    }
    try {
        await deleteVolatileBlocks(oldBlocks.map((b: any) => b.hash));
    } catch (err) {
        logDbError("delete volatile_blocks", err);
        throw err;
    }
    try {
        await deleteVolatileHeaders(oldHeaders.map((h: any) => h.header_hash));
    } catch (err) {
        logDbError("delete volatile_headers", err);
        throw err;
    }
    logger.info(
        `GC'd ${oldBlocks.length} blocks + ${oldHeaders.length} headers (w/ RawCbor + rollforward_header_cbor) to chunk ${chunk.chunk_no}`,
    );
}

export async function getUtxosByRefs(
    utxoRefs: string[],
): Promise<Array<{ utxo_ref: string; amount: string | null }>> {
    if (utxoRefs.length === 0) return [];
    // Bun SQL .values() returns row arrays [[ref, amount], ...], not objects.
    // Callers (BlockBodyValidator) destructure { utxo_ref, amount }.
    const rows = await sql`
			SELECT utxo_ref, COALESCE(lovelace, json_extract(tx_out, '$.amount')) as amount
			FROM utxo
			WHERE utxo_ref IN ${sql(utxoRefs)}
		`.values() as any[];

    return rows.map((row) => {
        if (Array.isArray(row)) {
            const amount = row[1];
            return {
                utxo_ref: String(row[0]),
                amount: amount == null ? null : String(amount),
            };
        }
        const amount = row?.amount;
        return {
            utxo_ref: String(row?.utxo_ref ?? ""),
            amount: amount == null ? null : String(amount),
        };
    });
}

/** How many of these UTxOs carry a reference script (Babbage+ script lookup source). */
export async function countUtxosWithReferenceScript(utxoRefs: string[]): Promise<number> {
    if (utxoRefs.length === 0) return 0;
    return countQuery(sql`
        SELECT COUNT(*) as c FROM utxo
        WHERE utxo_ref IN ${sql(utxoRefs)}
          AND reference_script_hash IS NOT NULL
    `);
}

export async function getUtxoByRef(
    utxoRef: string,
): Promise<{ utxo_ref: string; tx_out: string } | null> {
    const result =
        await sql`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref = ${utxoRef}`
            .values();
    return result[0] as { utxo_ref: string; tx_out: string } | null;
}

export async function getUtxosByTxHash(
    txHash: string,
): Promise<Array<{ utxo_ref: string; tx_out: string }>> {
    return await sql`SELECT utxo_ref, tx_out FROM utxo WHERE tx_hash = ${txHash} ORDER BY CAST(substr(utxo_ref, 66) AS INTEGER)`
        .values() as Array<{ utxo_ref: string; tx_out: string }>;
}

/**
 * Address-indexed UTxO lookup for Mini-Blockfrost.
 * Uses the indexed `address` column (kept beside the tx_out JSON on write).
 * Dual-shape row handling for Bun SQL object vs array rows.
 */
export async function getUtxosByAddress(
    address: string,
): Promise<Array<{ utxo_ref: string; tx_out: string; tx_hash: string }>> {
    const rows = await sql`
        SELECT utxo_ref, tx_out, tx_hash
        FROM utxo
        WHERE address = ${address}
        ORDER BY tx_hash, CAST(substr(utxo_ref, 66) AS INTEGER)
    `;
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row: any) => {
        if (Array.isArray(row)) {
            return {
                utxo_ref: String(row[0] ?? ""),
                tx_out: typeof row[1] === "string" ? row[1] : JSON.stringify(row[1] ?? {}),
                tx_hash: String(row[2] ?? ""),
            };
        }
        return {
            utxo_ref: String(row?.utxo_ref ?? ""),
            tx_out: typeof row?.tx_out === "string"
                ? row.tx_out
                : JSON.stringify(row?.tx_out ?? {}),
            tx_hash: String(row?.tx_hash ?? ""),
        };
    });
}

const referenceScriptCache = new Map<string, string>();
let referenceScriptCacheDb = "";
let referenceScriptCacheLoaded = false;

/** Resolve a reference script currently present in the ledger UTxO set. */
export async function getReferenceScriptCborByHash(
    scriptHash: string,
): Promise<string | null> {
    const expected = scriptHash.replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{56}$/.test(expected)) return null;
    const dbPath = getSqlFilename();
    if (referenceScriptCacheDb !== dbPath) {
        referenceScriptCache.clear();
        referenceScriptCacheDb = dbPath;
        referenceScriptCacheLoaded = false;
    }
    const cached = referenceScriptCache.get(expected);
    if (cached) return cached;

    const exactRows = await sql`
        SELECT tx_out
        FROM utxo
        WHERE reference_script_hash = ${expected}
        LIMIT 1
    `;
    const exactRow = Array.isArray(exactRows) ? exactRows[0] : null;
    if (exactRow != null) {
        const raw = Array.isArray(exactRow) ? exactRow[0] : (exactRow as any)?.tx_out;
        const parsed = parseStoredTxOut(
            typeof raw === "string" ? raw : JSON.stringify(raw ?? {}),
        );
        if (parsed.scriptRefCbor) {
            referenceScriptCache.set(expected, parsed.scriptRefCbor);
            return parsed.scriptRefCbor;
        }
    }
    if (referenceScriptCacheLoaded) return null;

    const rows = await sql`
        SELECT tx_out
        FROM utxo
        WHERE json_extract(tx_out, '$.script_bytes_hex') IS NOT NULL
    `;
    for (const row of Array.isArray(rows) ? rows : []) {
        const raw = Array.isArray(row) ? row[0] : (row as any)?.tx_out;
        const parsed = parseStoredTxOut(
            typeof raw === "string" ? raw : JSON.stringify(raw ?? {}),
        );
        if (parsed.scriptRefHash && parsed.scriptRefCbor) {
            referenceScriptCache.set(
                parsed.scriptRefHash.toLowerCase(),
                parsed.scriptRefCbor,
            );
        }
    }
    referenceScriptCacheLoaded = true;
    return referenceScriptCache.get(expected) ?? null;
}

/** Latest protocol params JSONB row (if any). */
export async function getLatestProtocolParams(): Promise<unknown | null> {
    const rows = await sql`
        SELECT params FROM protocol_params ORDER BY id DESC LIMIT 1
    `;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row == null) return null;
    if (Array.isArray(row)) {
        const v = row[0];
        if (v == null) return null;
        if (typeof v === "string") {
            try {
                return JSON.parse(v);
            } catch {
                return v;
            }
        }
        return v;
    }
    const params = (row as any)?.params;
    if (params == null) return null;
    if (typeof params === "string") {
        try {
            return JSON.parse(params);
        } catch {
            return params;
        }
    }
    return params;
}

export async function getAllStake(): Promise<
    Array<{ stake_credentials: Uint8Array; amount: number }>
> {
    // Bun SQL .values() returns row arrays [[cred, amount], ...], not objects.
    // Callers (BlockBodyValidator) destructure { stake_credentials, amount }.
    const rows = await sql`SELECT stake_credentials, amount FROM stake`
        .values() as any[];
    return rows.map((row) => {
        if (Array.isArray(row)) {
            return {
                stake_credentials: row[0] as Uint8Array,
                amount: row[1] as number,
            };
        }
        return {
            stake_credentials: row?.stake_credentials as Uint8Array,
            amount: row?.amount as number,
        };
    });
}

export async function getAllDelegations(): Promise<
    Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>
> {
    // Same Bun .values() dual-shape trap as getAllStake / getUtxosByRefs.
    const rows =
        await sql`SELECT stake_credentials, pool_key_hash FROM delegations`
            .values() as any[];
    return rows.map((row) => {
        if (Array.isArray(row)) {
            return {
                stake_credentials: row[0] as Uint8Array,
                pool_key_hash: row[1] as Uint8Array,
            };
        }
        return {
            stake_credentials: row?.stake_credentials as Uint8Array,
            pool_key_hash: row?.pool_key_hash as Uint8Array,
        };
    });
}

/**
 * Delta payload. `spend` carries the full tx_out so rollback can restore the
 * output; `create` carries only the ref (rollback deletes it), so the output
 * JSON is no longer stored twice.
 */
function packUtxoDelta(opts: {
    utxo_ref: string;
    tx_out?: string;
    tx_hash?: string;
}): string {
    return JSON.stringify({
        utxo_ref: opts.utxo_ref,
        ...(opts.tx_out != null ? { tx_out: opts.tx_out } : {}),
        ...(opts.tx_hash ? { tx_hash: opts.tx_hash } : {}),
    });
}

/** Indexed columns kept beside the tx_out JSON. */
export interface TxOutColumns {
    address: string | null;
    /** Decimal string; SQLite stores it as INTEGER. */
    lovelace: string | null;
    referenceScriptHash: string | null;
}

export function txOutColumns(txOut: string | Record<string, unknown> | null | undefined): TxOutColumns {
    let j: any = txOut;
    if (typeof txOut === "string") {
        try {
            j = JSON.parse(txOut);
        } catch {
            j = null;
        }
    }
    const address = typeof j?.address === "string" && j.address.length > 0 ? j.address : null;
    const amt = j?.amount;
    const lovelace = amt != null && /^\d+$/.test(String(amt)) ? String(amt) : null;
    const ref = typeof j?.reference_script_hash === "string" && j.reference_script_hash.length > 0
        ? j.reference_script_hash.toLowerCase()
        : null;
    return { address, lovelace, referenceScriptHash: ref };
}

/**
 * Fill the indexed side columns from the JSON for rows written by bulk importers
 * (Blockfrost snapshot, Mithril stream tables) or tests that insert `tx_out` only.
 * Keep in step with `txOutColumns`.
 */
export const BACKFILL_UTXO_COLUMNS_SQL =
    "UPDATE utxo SET address = json_extract(tx_out, '$.address'), " +
    "lovelace = CAST(json_extract(tx_out, '$.amount') AS INTEGER), " +
    "reference_script_hash = lower(json_extract(tx_out, '$.reference_script_hash')) " +
    "WHERE address IS NULL";

/** The one writer of `utxo` rows: JSON plus the indexed side columns. */
async function upsertUtxoRow(
    db: SqlClient,
    utxoRef: string,
    txOut: string,
    txHash: string | null,
    cols: TxOutColumns = txOutColumns(txOut),
): Promise<void> {
    await db`
        INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash)
        VALUES (${utxoRef}, ${txOut}, ${txHash}, ${cols.address}, ${cols.lovelace}, ${cols.referenceScriptHash})
    `;
}

function parseUtxoDelta(raw: unknown): {
    utxo_ref: string | null;
    tx_out: string;
    tx_hash: string | null;
} {
    const s = typeof raw === "string" ? raw : String(raw ?? "");
    try {
        const j = JSON.parse(s);
        if (j && typeof j === "object" && ("utxo_ref" in j || "tx_out" in j)) {
            return {
                utxo_ref: j.utxo_ref != null ? String(j.utxo_ref) : null,
                tx_out: typeof j.tx_out === "string"
                    ? j.tx_out
                    : j.tx_out != null
                    ? JSON.stringify(j.tx_out)
                    : "",
                tx_hash: j.tx_hash != null ? String(j.tx_hash) : null,
            };
        }
        // Legacy create delta: raw tx_out JSON only (no ref) — unrestorable alone
        return { utxo_ref: null, tx_out: s, tx_hash: null };
    } catch {
        return { utxo_ref: null, tx_out: s, tx_hash: null };
    }
}

/** Optional Mini-BF forward-index context (slot + in-block tx ordinal). */

function bytesOf(v: unknown): Uint8Array {
    if (v instanceof Uint8Array) return v;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return new Uint8Array(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === "string" && /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return fromHex(v);
    return new Uint8Array(0);
}

/** Distinct credentials, in first-seen order. */
function distinctCredentials(creds: Uint8Array[]): Uint8Array[] {
    const seen = new Map<string, Uint8Array>();
    for (const c of creds) {
        if (c && c.length > 0) seen.set(toHex(c), c);
    }
    return Array.from(seen.values());
}

/**
 * Keyed alternative to getAllStake(): only the rows for `creds`.
 *
 * Bun's `IN ${sql([...])}` helper reads Uint8Array items as row tuples, so BLOB
 * keys go through one indexed `=` lookup per distinct credential. A block
 * touches a handful of credentials; the table grows to millions of rows.
 */
export async function getStakeByCredentials(
    creds: Uint8Array[],
): Promise<Array<{ stake_credentials: Uint8Array; amount: number }>> {
    const out: Array<{ stake_credentials: Uint8Array; amount: number }> = [];
    for (const cred of distinctCredentials(creds)) {
        const rows = await sql`SELECT stake_credentials, amount FROM stake WHERE stake_credentials = ${cred}`
            .values() as any[];
        for (const row of rows) {
            const c = Array.isArray(row) ? row[0] : row?.stake_credentials;
            const a = Array.isArray(row) ? row[1] : row?.amount;
            out.push({ stake_credentials: bytesOf(c), amount: Number(a ?? 0) });
        }
    }
    return out;
}

/** Keyed alternative to getAllDelegations(): only the rows for `creds`. See getStakeByCredentials. */
export async function getDelegationsByCredentials(
    creds: Uint8Array[],
): Promise<Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>> {
    const out: Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }> = [];
    for (const cred of distinctCredentials(creds)) {
        const rows = await sql`SELECT stake_credentials, pool_key_hash FROM delegations WHERE stake_credentials = ${cred}`
            .values() as any[];
        for (const row of rows) {
            const c = Array.isArray(row) ? row[0] : row?.stake_credentials;
            const p = Array.isArray(row) ? row[1] : row?.pool_key_hash;
            out.push({ stake_credentials: bytesOf(c), pool_key_hash: bytesOf(p) });
        }
    }
    return out;
}

export type TxIndexCtx = {
    slot: number;
    txIndex: number;
    /** Chain height of the containing block (mb_tx.block_height). */
    blockHeight?: number | null;
};

/** Parse address from packed tx_out JSON (best-effort). */
function addressFromTxOutJson(raw: unknown): string {
    try {
        const j = typeof raw === "string" ? JSON.parse(raw) : raw;
        const a = j?.address != null ? String(j.address) : "";
        return a.length > 8 ? a : "";
    } catch {
        return "";
    }
}

/**
 * Upsert Mini-BF indexes for one tx.
 * Dual-writes legacy thin tables (tx_index/address_tx/block_tx) + mb_* projections.
 * Best-effort — never throws into apply hot path.
 */
export async function indexTransaction(
    db: SqlClient,
    opts: {
        txHash: string;
        blockHash: Uint8Array;
        slot: number;
        txIndex: number;
        blockHeight?: number | null;
        fee?: string | null;
        size?: number | null;
        invalidHereafter?: string | null;
        invalidBefore?: string | null;
        /** address → direction (in|out|both) */
        addresses: Map<string, "in" | "out" | "both">;
        inputs?: MbTxIn[];
        outputs?: MbTxOut[];
    },
): Promise<void> {
    try {
        const txHash = opts.txHash.toLowerCase();
        if (!txHash || txHash.length < 64) return;

        // Legacy thin indexes (compat during transition)
        await db`
            INSERT INTO tx_index (
                tx_hash, block_hash, slot, fee, size,
                invalid_hereafter, invalid_before
            ) VALUES (
                ${txHash},
                ${opts.blockHash},
                ${opts.slot},
                ${opts.fee ?? null},
                ${opts.size ?? null},
                ${opts.invalidHereafter ?? null},
                ${opts.invalidBefore ?? null}
            )
            ON CONFLICT(tx_hash) DO UPDATE SET
                block_hash = excluded.block_hash,
                slot = excluded.slot,
                fee = excluded.fee,
                size = excluded.size,
                invalid_hereafter = excluded.invalid_hereafter,
                invalid_before = excluded.invalid_before
        `;

        await db`
            INSERT INTO block_tx (block_hash, tx_hash, tx_index)
            VALUES (${opts.blockHash}, ${txHash}, ${opts.txIndex})
            ON CONFLICT(block_hash, tx_hash) DO UPDATE SET
                tx_index = excluded.tx_index
        `;

        for (const [address, direction] of opts.addresses) {
            if (!address || address.length < 10) continue;
            await db`
                INSERT INTO address_tx (address, tx_hash, slot, direction)
                VALUES (${address}, ${txHash}, ${opts.slot}, ${direction})
                ON CONFLICT(address, tx_hash) DO UPDATE SET
                    slot = excluded.slot,
                    direction = CASE
                        WHEN address_tx.direction = excluded.direction
                            THEN address_tx.direction
                        WHEN address_tx.direction IS NULL
                            THEN excluded.direction
                        ELSE 'both'
                    END
            `;
        }

        // mb_* derived projections (full IO when inputs/outputs provided)
        await applyMbTx(db as any, {
            blockHeight: opts.blockHeight ?? null,
            txHash,
            blockHash: opts.blockHash,
            slot: opts.slot,
            txIndex: opts.txIndex,
            fee: opts.fee,
            size: opts.size,
            invalidBefore: opts.invalidBefore,
            invalidHereafter: opts.invalidHereafter,
            addresses: opts.addresses,
            inputs: opts.inputs ?? [],
            outputs: opts.outputs ?? [],
        });
    } catch (e: any) {
        logger.warn(
            `Mini-BF forward index failed for tx ${opts.txHash}: ${e?.message || e}`,
        );
    }
}

export async function applyTransaction(
    txBody: TxBody,
    blockHash: Uint8Array,
    client?: SqlClient,
    indexCtx?: TxIndexCtx,
): Promise<void> {
    const db = client ?? sql;
    const txId = txBody.hash.toString(); // Canonical blake2b_256(txBody CBOR) hex from ledger-ts

    if (!txBody.inputs || !Array.isArray(txBody.inputs)) {
        logger.warn(
            `Skipping tx ${txId} due to invalid inputs:`,
            txBody.inputs,
        );
        return;
    }

    const inputRefs = txBody.inputs.map((input: any) =>
        `${input.utxoRef.id.toString()}:${input.utxoRef.index}`
    );


    // Collect spend-side addresses BEFORE delete (for address_tx direction=out)
    const addrDirs = new Map<string, "in" | "out" | "both">();
    // MiniBF full-IO inputs (prev refs) — built from tx body inputs
    const mbInputs: MbTxIn[] = [];
    const mbOutputs: MbTxOut[] = [];

    // Record inputs for mb_tx_in even if UTxO missing (historical soft apply)
    for (let i = 0; i < txBody.inputs.length; i++) {
        const input = txBody.inputs[i] as any;
        try {
            const prevHash = String(input.utxoRef.id.toString()).toLowerCase();
            const prevIdx = Number(input.utxoRef.index);
            if (prevHash && Number.isFinite(prevIdx)) {
                mbInputs.push({
                    inputIndex: i,
                    prevTxHash: prevHash,
                    prevOutputIndex: prevIdx,
                });
            }
        } catch { /* skip bad input shape */ }
    }

    if (inputRefs.length > 0) {
        // Object rows preferred; tolerate array rows from .values()
        const existingUtxos = await db`
            SELECT utxo_ref, tx_out, tx_hash, address FROM utxo WHERE utxo_ref IN ${db(inputRefs)}
        ` as any[];
        if (existingUtxos.length > 0) {
            // Bun SQLite rejects multi-row VALUES ${sql([...])} — row-by-row.
            for (const row of existingUtxos) {
                const utxo_ref = Array.isArray(row)
                    ? String(row[0])
                    : String(row.utxo_ref);
                const tx_out = Array.isArray(row)
                    ? String(row[1])
                    : String(row.tx_out);
                const tx_hash = Array.isArray(row)
                    ? (row[2] != null ? String(row[2]) : undefined)
                    : (row.tx_hash != null ? String(row.tx_hash) : undefined);
                const addrCol = Array.isArray(row) ? row[3] : row.address;
                const spentAddr = (addrCol != null && String(addrCol).length > 8 ? String(addrCol) : "") || addressFromTxOutJson(tx_out);
                if (spentAddr) {
                    const prev = addrDirs.get(spentAddr);
                    addrDirs.set(
                        spentAddr,
                        prev === "in" || prev === "both" ? "both" : "out",
                    );
                }
                await insertUtxoDelta(
                    db,
                    blockHash,
                    "spend",
                    packUtxoDelta({ utxo_ref, tx_out, tx_hash }),
                );
            }
            // Delete spent UTxOs in bulk (IN ${sql([...])} is supported)
            await db`DELETE FROM utxo WHERE utxo_ref IN ${db(inputRefs)}`;
        }
    }

    if (!txBody.outputs || !Array.isArray(txBody.outputs)) {
        logger.warn(
            `Skipping tx ${txId} due to invalid outputs:`,
            txBody.outputs,
        );
        return;
    }

    // Force tuple typing in map return
    const outputData: [string, string, string, TxOutColumns][] = txBody.outputs.map(
        (output: any, i: number) => {
            const utxoRef = `${txId}:${i}`;
            const assetsObj: Record<string, Record<string, string>> = {};
            const multiAssets = Array.isArray(output.value?.map)
                ? output.value.map
                : [];
            multiAssets.forEach((ma: any) => {
                const policyStr = ma.policy.toString();
                const assetObj: Record<string, string> = {};
                (Array.isArray(ma.assets) ? ma.assets : []).forEach(
                    (asset: any) => {
                        assetObj[toHex(asset.name)] = asset.quantity.toString();
                    },
                );
                assetsObj[policyStr] = assetObj;
            });

            const addr = output.address?.toString() || "";
            if (addr && addr.length > 8) {
                const prev = addrDirs.get(addr);
                addrDirs.set(
                    addr,
                    prev === "out" || prev === "both" ? "both" : "in",
                );
            }

            const lovelace = output.value?.lovelaces?.toString() || "0";
            const assetsJson =
                Object.keys(assetsObj).length > 0
                    ? JSON.stringify(assetsObj)
                    : null;
            const metadata = extractLedgerTxOutMetadata(output);
            mbOutputs.push({
                outputIndex: i,
                address: addr,
                lovelace,
                assetsJson,
                datumHash: metadata.datumHash,
                inlineDatumCbor: metadata.inlineDatumCbor,
                scriptRefHash: metadata.scriptRefHash,
            });

            const txOutJson = JSON.stringify({
                address: addr,
                amount: lovelace,
                assets: assetsObj,
                ...(metadata.datumHash
                    ? { datum_hash: metadata.datumHash }
                    : {}),
                ...(metadata.inlineDatumCbor
                    ? { inline_datum: metadata.inlineDatumCbor }
                    : {}),
                ...(metadata.scriptRefHash
                    ? { reference_script_hash: metadata.scriptRefHash }
                    : {}),
                ...(metadata.scriptRefCbor
                    ? { reference_script_cbor: metadata.scriptRefCbor }
                    : {}),
            });
            // Same mapping as the JSON→columns helper used on restore, so a UTxO written
            // here and the same UTxO restored by rollbackChainTo index identically.
            const cols: TxOutColumns = txOutColumns({
                address: addr,
                amount: lovelace,
                reference_script_hash: metadata.scriptRefHash ?? undefined,
            });
            return [utxoRef, txOutJson, txId, cols] as [string, string, string, TxOutColumns];
        },
    );

    if (outputData.length > 0) {
        // Bun SQLite rejects multi-row VALUES ${sql([...])} — row-by-row.
        for (const [utxoRef, json, txHash, cols] of outputData) {
            await insertUtxoDelta(
                db,
                blockHash,
                "create",
                packUtxoDelta({ utxo_ref: utxoRef, tx_hash: txHash }),
            );
            await upsertUtxoRow(db, utxoRef, json, txHash, cols);
        }
    }

    if (txBody.certs && Array.isArray(txBody.certs)) {
        await applyCertificates(txBody.certs, blockHash, client);
    }

    if (txBody.withdrawals && Array.isArray(txBody.withdrawals)) {
        await applyWithdrawals(txBody.withdrawals, blockHash, client);
    }

    if (txBody.fee) {
        await insertUtxoDelta(
            db,
            blockHash,
            "fee",
            JSON.stringify({ amount: txBody.fee.toString() }),
        );
        await db`UPDATE chain_account_state SET treasury = treasury + ${txBody.fee} WHERE id = 1`;
    }

    // Mini-BF forward index (live + batch when indexCtx provided)
    if (indexCtx && Number.isFinite(indexCtx.slot) && !applySkipIndex()) {
        let fee: string | null = null;
        let size: number | null = null;
        let invalidHereafter: string | null = null;
        let invalidBefore: string | null = null;
        try {
            if ((txBody as any).fee != null) fee = String((txBody as any).fee);
        } catch { /* */ }
        try {
            if (typeof (txBody as any).toCborBytes === "function") {
                size = (txBody as any).toCborBytes().length;
            }
        } catch { /* */ }
        try {
            if ((txBody as any).ttl != null) {
                invalidHereafter = String((txBody as any).ttl);
            }
            if ((txBody as any).validityIntervalStart != null) {
                invalidBefore = String((txBody as any).validityIntervalStart);
            }
        } catch { /* */ }

        await indexTransaction(db, {
            txHash: txId,
            blockHash,
            slot: indexCtx.slot,
            txIndex: indexCtx.txIndex,
            blockHeight: indexCtx.blockHeight ?? null,
            fee,
            size,
            invalidHereafter,
            invalidBefore,
            addresses: addrDirs,
            inputs: mbInputs,
            outputs: mbOutputs,
        });
    }
}

export async function applyCertificates(
    certs: any[],
    blockHash: Uint8Array,
    client?: SqlClient,
): Promise<void> {
    const db = client ?? sql;
    const certDeltas: string[] = [];
    for (const cert of certs) {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();

        certDeltas.push(JSON.stringify({
            type: cert.certType,
            stakeCred: stakeCred ? toHex(stakeCred) : null,
            poolId: certAny.poolKeyHash?.toString() ||
                certAny.poolParams?.operator?.toString() ||
                certAny.poolHash?.toString(),
        }));
    }
    if (certDeltas.length) {
        // Bun SQLite rejects multi-row VALUES ${sql([...])} — row-by-row.
        for (const json of certDeltas) {
            await insertUtxoDelta(db, blockHash, "cert", json);
        }
    }

    await Promise.all(certs.map(async (cert) => {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();
        // Stake-credential effects come from the same table the body validator uses
        // (certificateRules.ts), so validate and apply cannot drift per certificate type.
        const fx = certStakeEffect(Number(cert.certType));
        if (stakeCred && fx.registers) {
            await db`INSERT OR REPLACE INTO stake (stake_credentials, amount) VALUES (${stakeCred}, 0)`;
        }
        if (stakeCred && fx.deregisters) {
            await db`DELETE FROM stake WHERE stake_credentials = ${stakeCred}`;
            await db`DELETE FROM delegations WHERE stake_credentials = ${stakeCred}`;
        }
        if (stakeCred && fx.delegatesToPool) {
            const poolKh = certAny.poolKeyHash?.toBuffer();
            if (poolKh) {
                await db`INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash) VALUES (${stakeCred}, ${poolKh})`;
            }
        }
        switch (cert.certType) {
            case 3: // CertificateType.PoolRegistration
                const poolId = certAny.poolParams?.operator?.toBuffer();
                if (poolId) {
                    const newPoolJson = JSON.stringify({
                        pool_id: toHex(poolId),
                        active_stake: "0",
                    });
                    await db`UPDATE pool_distr SET pools = json_insert(pools, "$[#]", json(${newPoolJson})) WHERE id = 1`;
                }
                break;
            case 4: // CertificateType.PoolRetirement
                const retiringPoolId = certAny.poolHash?.toBuffer();
                if (retiringPoolId) {
                    await db`UPDATE pool_distr SET pools = (SELECT json_group_array(json(value)) FROM json_each(pools) WHERE json_extract(value, '$.pool_id') != ${
                        toHex(retiringPoolId)
                    }) WHERE id = 1`;
                }
                break;
        }
    }));
}

export async function applyWithdrawals(
    withdrawals: any,
    blockHash: Uint8Array,
    client?: SqlClient,
): Promise<void> {
    const db = client ?? sql;
    if (withdrawals.map.length === 0) return;

    const withdrawalData = withdrawals.map.map((
        { rewardAccount, amount }: any,
    ) => ({
        stakeCred: rewardAccount.toBuffer(),
        amount,
    }));
    for (const { stakeCred, amount } of withdrawalData) {
        await db`UPDATE rewards SET amount = amount - ${amount} WHERE stake_credentials = ${stakeCred}`;
        // Bun SQLite rejects multi-row VALUES ${sql([...])} — row-by-row.
        await insertUtxoDelta(
            db,
            blockHash,
            "withdrawal",
            JSON.stringify({
                stakeCred: toHex(stakeCred),
                amount: amount.toString(),
            }),
        );
    }
}

/**
 * Count helper — Bun `.values()` returns [[n]] not [{ "COUNT(*)": n }].
 */
async function countQuery(q: Promise<any>): Promise<number> {
    const rows = await q;
    const row = Array.isArray(rows) ? rows[0] : rows;
    const v = firstScalar(row);
    return Number(v ?? 0);
}

/**
 * Reverse UTxO effects for blocks with slot > target, then drop those blocks.
 * Creates are deleted; spends are re-inserted from packed delta JSON.
 * Legacy deltas without utxo_ref are skipped (logged).
 */
/** Blocks strictly after `slot` (what a rollback to `slot` would discard). */
export async function countBlocksAfterSlot(slot: bigint): Promise<number> {
    return countQuery(sql`SELECT COUNT(*) as c FROM blocks WHERE slot > ${slot}`);
}

export async function rollbackChainTo(
    slot: bigint,
): Promise<
    {
        blocksDeleted: number;
        headersDeleted: number;
        deltasDeleted: number;
        utxoRestored: number;
        utxoRemoved: number;
        skippedLegacyDeltas: number;
    }
> {
    const counts = {
        blocksDeleted: 0,
        headersDeleted: 0,
        deltasDeleted: 0,
        utxoRestored: 0,
        utxoRemoved: 0,
        skippedLegacyDeltas: 0,
    };

    counts.blocksDeleted = await countQuery(
        sql`SELECT COUNT(*) as c FROM blocks WHERE slot > ${slot}`,
    );
    counts.headersDeleted = await countQuery(
        sql`SELECT COUNT(*) as c FROM volatile_headers WHERE slot > ${slot}`,
    );
    counts.deltasDeleted = await countQuery(
        sql`SELECT COUNT(*) as c FROM utxo_deltas WHERE block_hash IN (SELECT hash FROM blocks WHERE slot > ${slot})`,
    );

    logger.rollback(
        `Pre-rollback to slot ${slot}: blocksDeleted=${counts.blocksDeleted}, headersDeleted=${counts.headersDeleted}, deltasDeleted=${counts.deltasDeleted}`,
    );

    const beforeTip = await getMaxSlot();

    // Capture deltas before delete — newest first so reverse order is natural
    const deltaRows = await sql`
        SELECT d.action, d.utxo, b.slot
        FROM utxo_deltas d
        INNER JOIN blocks b ON b.hash = d.block_hash
        WHERE b.slot > ${slot}
        ORDER BY b.slot DESC, d.id DESC
    ` as any[];

    for (const row of deltaRows) {
        const action = Array.isArray(row) ? String(row[0]) : String(row.action);
        const utxoRaw = Array.isArray(row) ? row[1] : row.utxo;
        const parsed = parseUtxoDelta(utxoRaw);

        if (action === "create") {
            if (!parsed.utxo_ref) {
                counts.skippedLegacyDeltas++;
                continue;
            }
            await sql`DELETE FROM utxo WHERE utxo_ref = ${parsed.utxo_ref}`;
            counts.utxoRemoved++;
        } else if (action === "spend") {
            if (!parsed.utxo_ref) {
                counts.skippedLegacyDeltas++;
                continue;
            }
            const txHash = parsed.tx_hash ??
                (parsed.utxo_ref.includes(":")
                    ? parsed.utxo_ref.split(":")[0]
                    : "");
            await upsertUtxoRow(sql, parsed.utxo_ref, parsed.tx_out, txHash);
            counts.utxoRestored++;
        }
        // fee / cert / withdrawal: no UTxO table change on reverse (best-effort)
    }

    await sql.begin(async (tx) => {
        // MiniBF projections first (same txn as ledger deletes)
        await rollbackMbToSlot(tx as any, Number(slot));
        await tx`DELETE FROM utxo_deltas WHERE block_hash IN (SELECT hash FROM blocks WHERE slot > ${slot})`;
        await tx`DELETE FROM volatile_headers WHERE slot > ${slot}`;
        await tx`DELETE FROM blocks WHERE slot > ${slot}`;
    });

    const afterTip = await getMaxSlot();
    logger.rollback(
        `Post-rollback to slot ${slot}; beforeTip=${beforeTip.toString()} afterTip=${afterTip.toString()} utxoRestored=${counts.utxoRestored} utxoRemoved=${counts.utxoRemoved} skippedLegacy=${counts.skippedLegacyDeltas}`,
    );

    return counts;
}

/** UTxO set size (object-row safe). */
/**
 * Insert the Byron genesis UTxOs on a fresh from-genesis database so the
 * ledger is complete from slot 0 (the first Byron/Shelley transactions spend
 * them). Idempotent; no utxo_deltas row because genesis is never rolled back.
 */
export async function seedGenesisUtxos(
    rows: Array<{ utxoRef: string; txId: string; address: string; lovelace: bigint }>,
): Promise<number> {
    let inserted = 0;
    for (const r of rows) {
        const txOut = JSON.stringify({ address: r.address, amount: r.lovelace.toString(), assets: {} });
        const res = await sql`
            INSERT OR IGNORE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace)
            VALUES (${r.utxoRef}, ${txOut}, ${r.txId}, ${r.address}, ${r.lovelace.toString()})
        `;
        inserted += Number((res as unknown as { count?: number })?.count ?? 1);
    }
    return inserted;
}

/** Security parameter k: invalid rows older than this many slots behind the tip are garbage. */
export const VOLATILE_GC_K = 2160;

/**
 * Remove invalidated blocks/headers that are more than k slots behind the tip.
 * Cheap thanks to the partial `WHERE is_valid = FALSE` indexes; called by the
 * applier every few thousand blocks instead of per insert.
 */
export async function gcVolatile(k: number = VOLATILE_GC_K): Promise<{ blocks: number; headers: number }> {
    const b = await sql`DELETE FROM blocks WHERE is_valid = FALSE AND slot < (SELECT MAX(slot) - ${k} FROM blocks)`;
    const h = await sql`DELETE FROM volatile_headers WHERE is_valid = FALSE AND slot < (SELECT MAX(slot) - ${k} FROM volatile_headers)`;
    const n = (r: unknown) => Number((r as { count?: number })?.count ?? 0);
    return { blocks: n(b), headers: n(h) };
}

export interface GenesisSeedResult {
    /** Newly inserted this run. */
    inserted: number;
    /** Already in the utxo table. */
    present: number;
    /** Not in utxo and already consumed by an applied transaction (mb_tx_in), so correctly absent. */
    spent: number;
}

/**
 * Retroactive, idempotent genesis seeding: insert every genesis UTxO that is
 * neither in the utxo table nor recorded as spent by an applied transaction.
 * Safe on a database that synced before seeding existed: spends are known
 * from `mb_tx_in`, which is written even when the input UTxO was missing.
 */
export async function seedGenesisUtxosIfMissing(
    rows: Array<{ utxoRef: string; txId: string; address: string; lovelace: bigint; kind?: "nonavvm" | "avvm" }>,
): Promise<GenesisSeedResult> {
    const res: GenesisSeedResult = { inserted: 0, present: 0, spent: 0 };
    const CHUNK = 400;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        for (const r of chunk) {
            await sql`INSERT OR IGNORE INTO genesis_utxo (utxo_ref, address, lovelace, kind) VALUES (${r.utxoRef}, ${r.address}, ${r.lovelace.toString()}, ${r.kind ?? "nonavvm"})`;
        }
        const refs = chunk.map((r) => r.utxoRef);
        const txIds = chunk.map((r) => r.txId);
        const presentRows = await sql`SELECT utxo_ref FROM utxo WHERE utxo_ref IN ${sql(refs)}`.values() as unknown[][];
        const present = new Set(presentRows.map((r) => String(r[0])));
        const spentRows = await sql`
            SELECT prev_tx_hash FROM mb_tx_in WHERE prev_output_index = 0 AND prev_tx_hash IN ${sql(txIds)}
        `.values() as unknown[][];
        const spent = new Set(spentRows.map((r) => String(r[0]).toLowerCase()));
        const missing = chunk.filter((r) => {
            if (present.has(r.utxoRef)) {
                res.present++;
                return false;
            }
            if (spent.has(r.txId.toLowerCase())) {
                res.spent++;
                return false;
            }
            return true;
        });
        res.inserted += await seedGenesisUtxos(missing);
    }
    return res;
}

/** Rows in the genesis registry (spent or not). */
export async function countGenesisUtxoRegistry(): Promise<number> {
    return countQuery(sql`SELECT COUNT(*) as c FROM genesis_utxo`);
}

/** Genesis outputs known vs still unspent (indexed join, cheap enough for /metrics). */
export async function getGenesisUtxoStats(): Promise<{ total: number; unspent: number; avvm: number }> {
    const total = await countQuery(sql`SELECT COUNT(*) as c FROM genesis_utxo`);
    if (total === 0) return { total: 0, unspent: 0, avvm: 0 };
    const unspent = await countQuery(sql`SELECT COUNT(*) as c FROM utxo u JOIN genesis_utxo g ON g.utxo_ref = u.utxo_ref`);
    const avvm = await countQuery(sql`SELECT COUNT(*) as c FROM genesis_utxo WHERE kind = 'avvm'`);
    return { total, unspent, avvm };
}

export async function getUtxoCount(): Promise<number> {
    return countQuery(sql`SELECT COUNT(*) as c FROM utxo`);
}

/** Dual-shape row helper for Bun sql `.values()` vs object rows. */
function mapRow(r: unknown): Record<string, unknown> {
    if (r == null) return {};
    if (Array.isArray(r)) {
        // callers pass named projection — treat as positional only when needed
        return { _0: r[0], _1: r[1], _2: r[2], _3: r[3], _4: r[4], _5: r[5], _6: r[6] };
    }
    return r as Record<string, unknown>;
}

function blobToHex(val: unknown): string | null {
    if (val == null) return null;
    if (typeof val === "string") {
        // already hex or text
        if (/^[0-9a-fA-F]+$/.test(val) && val.length % 2 === 0) return val.toLowerCase();
        return val;
    }
    if (val instanceof Uint8Array) return toHex(val);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) return toHex(new Uint8Array(val));
    try {
        return toHex(new Uint8Array(val as ArrayBuffer));
    } catch {
        return String(val);
    }
}

export type TxIndexRow = {
    tx_hash: string;
    block_hash: string | null;
    slot: number;
    fee: string | null;
    size: number | null;
    invalid_hereafter: string | null;
    invalid_before: string | null;
};

/**
 * Mini-BF P0: tx by hash — prefer mb_tx, fallback legacy tx_index.
 */
export async function getTxByHash(txHash: string): Promise<TxIndexRow | null> {
    const mb = await getMbTxByHash(txHash);
    if (mb) {
        return {
            tx_hash: mb.tx_hash,
            block_hash: mb.block_hash,
            slot: mb.slot,
            fee: mb.fee,
            size: mb.size,
            invalid_hereafter: mb.invalid_hereafter,
            invalid_before: mb.invalid_before,
        };
    }
    const h = txHash.replace(/^0x/i, "").toLowerCase();
    try {
        const rows = await sql`
			SELECT tx_hash, block_hash, slot, fee, size, invalid_hereafter, invalid_before
			FROM tx_index WHERE tx_hash = ${h} LIMIT 1
		`.values();
        if (!rows.length) return null;
        const r = rows[0] as any;
        if (Array.isArray(r)) {
            return {
                tx_hash: String(r[0] ?? ""),
                block_hash: blobToHex(r[1]),
                slot: Number(r[2]),
                fee: r[3] != null ? String(r[3]) : null,
                size: r[4] != null ? Number(r[4]) : null,
                invalid_hereafter: r[5] != null ? String(r[5]) : null,
                invalid_before: r[6] != null ? String(r[6]) : null,
            };
        }
        return {
            tx_hash: String(r.tx_hash ?? ""),
            block_hash: blobToHex(r.block_hash),
            slot: Number(r.slot),
            fee: r.fee != null ? String(r.fee) : null,
            size: r.size != null ? Number(r.size) : null,
            invalid_hereafter:
                r.invalid_hereafter != null ? String(r.invalid_hereafter) : null,
            invalid_before:
                r.invalid_before != null ? String(r.invalid_before) : null,
        };
    } catch {
        return null;
    }
}

/** Mini-BF P0: address → txs — prefer mb_address_tx. */
export async function getAddressTxs(
    address: string,
    opts?: { count?: number; page?: number },
): Promise<{ tx_hash: string; slot: number; direction: string | null }[]> {
    return getMbAddressTxs(address, opts);
}

/** Mini-BF P1: block → tx list — prefer mb_block_tx. */
export async function getBlockTxHashes(
    blockHash: string | Uint8Array,
): Promise<{ tx_hash: string; tx_index: number }[]> {
    return getMbBlockTxHashes(blockHash);
}

/** Mini-BF address summary from live UTxO set + address_tx. */
export type AddressSummary = {
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    stake_address: string | null;
    type: string;
    script: boolean;
    utxo_count: number;
    tx_count: number;
};

/**
 * Mini-BF address summary from live UTxO set + address_tx.
 * received_sum/sent_sum are not tracked historically — null until full IO index.
 */
export async function getAddressSummary(address: string): Promise<AddressSummary> {
    const utxos = await getUtxosByAddress(address);
    const lovelace = utxos.reduce((acc, u) => {
        try {
            const j = typeof u.tx_out === "string" ? JSON.parse(u.tx_out) : u.tx_out;
            const a = j?.amount != null ? BigInt(String(j.amount)) : 0n;
            return acc + a;
        } catch {
            return acc;
        }
    }, 0n);

    // Aggregate multi-assets across UTxOs
    const assetMap = new Map<string, bigint>();
    for (const u of utxos) {
        try {
            const j = typeof u.tx_out === "string" ? JSON.parse(u.tx_out) : u.tx_out;
            const assets = j?.assets && typeof j.assets === "object" ? j.assets : {};
            for (const [policy, names] of Object.entries(assets as Record<string, any>)) {
                if (!policy || !names || typeof names !== "object") continue;
                for (const [name, qty] of Object.entries(names as Record<string, any>)) {
                    const unit = name ? `${policy}${name}` : policy;
                    const q = BigInt(String(qty ?? "0"));
                    assetMap.set(unit, (assetMap.get(unit) ?? 0n) + q);
                }
            }
        } catch { /* skip bad row */ }
    }

    const amount: Array<{ unit: string; quantity: string }> = [
        { unit: "lovelace", quantity: lovelace.toString() },
    ];
    for (const [unit, qty] of assetMap) {
        if (unit) amount.push({ unit, quantity: qty.toString() });
    }

    // tx_count from mb_address_tx (falls back to legacy address_tx)
    const txCount = await countMbAddressTxs(address);

    // Heuristic type (BF uses byron|shelley)
    const type = address.startsWith("addr") || address.startsWith("stake")
        ? "shelley"
        : address.startsWith("Ae2") || address.startsWith("DdzFF")
        ? "byron"
        : "shelley";

    return {
        address,
        amount,
        stake_address: null, // needs credential decode — later
        type,
        script: false,
        utxo_count: utxos.length,
        tx_count: txCount,
    };
}

/** Mini-BF /network tip snapshot (DB facts only). */
export type NetworkSnapshot = {
    tipSlot: string;
    tipHash: string | null;
    utxoCount: number;
    txIndexCount: number;
    addressTxCount: number;
    mbCursorSlot: number;
    mbTxCount: number;
    lagSlots: number;
};

/**
 * Mini-BF /network tip snapshot (DB facts only).
 * Epoch / epoch_nonce computed in miniBlockfrost via preprod formula.
 */
export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
    const tipSlot = await getMaxSlot();
    const tipRow = tipSlot > 0n ? await getBlockBySlot(tipSlot) : null;
    let tipHash: string | null = null;
    if (tipRow) {
        // getBlockBy*: SELECT id, chunk_id, slot, hash as block_hash, ...
        if (Array.isArray(tipRow)) tipHash = blobToHex(tipRow[3] ?? tipRow[0]);
        else tipHash = blobToHex(tipRow.block_hash ?? tipRow.hash);
    }
    const utxoCount = await getUtxoCount();
    let txIndexCount = 0;
    let addressTxCount = 0;
    try {
        const r1 = await sql`SELECT COUNT(*) AS c FROM tx_index`.values();
        const a1 = r1?.[0] as any;
        txIndexCount = Number(Array.isArray(a1) ? a1[0] : a1?.c ?? 0) || 0;
        const r2 = await sql`SELECT COUNT(*) AS c FROM address_tx`.values();
        const a2 = r2?.[0] as any;
        addressTxCount = Number(Array.isArray(a2) ? a2[0] : a2?.c ?? 0) || 0;
    } catch { /* */ }

    const mbStats = await getMbIndexStats();
    // Prefer denser of mb_* vs legacy for display counts
    const mbTxCount = Math.max(mbStats.mbTx, txIndexCount);
    const mbAddrCount = Math.max(mbStats.mbAddressTx, addressTxCount);
    const tipN = Number(tipSlot);
    const lagSlots =
        Number.isFinite(tipN) && mbStats.cursorSlot > 0
            ? Math.max(0, tipN - mbStats.cursorSlot)
            : tipN;

    return {
        tipSlot: tipSlot.toString(),
        tipHash,
        utxoCount,
        txIndexCount: mbTxCount,
        addressTxCount: mbAddrCount,
        mbCursorSlot: mbStats.cursorSlot,
        mbTxCount: mbStats.mbTx,
        lagSlots,
    };
}


/**
 * Best-effort Byron ATxAux apply.
 * Preprod early chunks often have empty txPayload; when present, ledger-ts shapes vary.
 * We extract inputs/outputs when possible and use the same packed-delta path as Shelley.
 */
export async function applyByronTxPayload(
    entry: any,
    blockHash: Uint8Array,
    client?: SqlClient,
): Promise<void> {
    const db = client ?? sql;
    // Common shapes: { transaction, witness }, { body, witness }, or nested .tx
    const tx = entry?.transaction ?? entry?.tx ?? entry?.body ?? entry;
    if (!tx || typeof tx !== "object") {
        logger.debug("applyByronTxPayload: unrecognised entry shape — skip");
        return;
    }

    const inputs: any[] = Array.isArray(tx.inputs)
        ? tx.inputs
        : Array.isArray(tx.txInputs)
        ? tx.txInputs
        : [];
    const outputs: any[] = Array.isArray(tx.outputs)
        ? tx.outputs
        : Array.isArray(tx.txOutputs)
        ? tx.txOutputs
        : [];

    // Derive a stable-ish tx id for UTxO refs
    let txId = "";
    try {
        if (typeof tx.hash?.toString === "function") {
            txId = String(tx.hash.toString());
        } else if (typeof entry.hash?.toString === "function") {
            txId = String(entry.hash.toString());
        } else if (typeof tx.toCborBytes === "function") {
            const { blake2b_256 } = await import("@harmoniclabs/crypto");
            txId = toHex(blake2b_256(tx.toCborBytes()));
        }
    } catch {
        /* fall through */
    }
    if (!txId) {
        // Last resort: hash JSON of keys (non-canonical but unique enough for local DB)
        const { blake2b_256 } = await import("@harmoniclabs/crypto");
        const seed = new TextEncoder().encode(
            JSON.stringify({
                nIn: inputs.length,
                nOut: outputs.length,
                s: String(tx.slot ?? ""),
            }),
        );
        txId = toHex(blake2b_256(seed));
    }

    // Inputs: try UTxORef-like fields
    const inputRefs: string[] = [];
    for (const inp of inputs) {
        try {
            const id = inp?.utxoRef?.id?.toString?.() ??
                inp?.txId?.toString?.() ??
                inp?.id?.toString?.() ??
                (inp?.txHash != null ? String(inp.txHash) : null);
            const index = inp?.utxoRef?.index ?? inp?.index ?? inp?.outputIndex;
            if (id != null && index != null) {
                inputRefs.push(`${id}:${Number(index)}`);
            }
        } catch {
            /* skip bad input */
        }
    }

    if (inputRefs.length > 0) {
        const existingUtxos = await db`
            SELECT utxo_ref, tx_out, tx_hash, address FROM utxo WHERE utxo_ref IN ${db(inputRefs)}
        ` as any[];
        for (const row of existingUtxos) {
            const utxo_ref = Array.isArray(row)
                ? String(row[0])
                : String(row.utxo_ref);
            const tx_out = Array.isArray(row)
                ? String(row[1])
                : String(row.tx_out);
            const tx_hash = Array.isArray(row)
                ? (row[2] != null ? String(row[2]) : undefined)
                : (row.tx_hash != null ? String(row.tx_hash) : undefined);
            await insertUtxoDelta(
                db,
                blockHash,
                "spend",
                packUtxoDelta({ utxo_ref, tx_out, tx_hash }),
            );
        }
        if (existingUtxos.length > 0) {
            await db`DELETE FROM utxo WHERE utxo_ref IN ${db(inputRefs)}`;
        }
    }

    for (let i = 0; i < outputs.length; i++) {
        const out = outputs[i];
        let address = "";
        let amount = "0";
        try {
            address = out?.address?.toString?.() ??
                out?.addr?.toString?.() ??
                String(out?.address ?? "");
            const coin = out?.value?.lovelaces ?? out?.coin ?? out?.amount ??
                out?.value;
            amount = coin != null ? String(coin) : "0";
        } catch {
            /* keep defaults */
        }
        const utxoRef = `${txId}:${i}`;
        const txOutJson = JSON.stringify({
            address,
            amount,
            assets: {},
            era: "byron",
        });
        await insertUtxoDelta(
            db,
            blockHash,
            "create",
            packUtxoDelta({ utxo_ref: utxoRef, tx_hash: txId }),
        );
        await upsertUtxoRow(db, utxoRef, txOutJson, txId, txOutColumns({ address, amount }));
    }
}

// Re-export MiniBF projection schema/writer/queries for HTTP handlers
export {
    ensureMinibfSchema,
    MINIBF_SCHEMA_VERSION,
    applyMbTx,
    rollbackMbToSlot,
    getMbCursor,
    getMbTxByHash,
    getMbTxUtxos,
    getMbAddressTxs,
    getMbBlockTxHashes,
    countMbAddressTxs,
    getMbIndexStats,
    type MbTxRow,
    type MbTxIo,
    type MbTxIn,
    type MbTxOut,
    type MbTxDelta,
    type MbSql,
    type MbCursor,
    type MbIndexStats,
} from "./db/minibf";
