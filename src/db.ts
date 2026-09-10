import { Cbor, CborUInt, LazyCborArray } from "@harmoniclabs/cbor";
import { getSqlFilename, sql } from "./sql";
import { ensureLedgerJournal, undoLedgerJournal } from "./db/ledgerJournal";
import { outputAddressString } from "./utils/byronAddressString";
import { shelleyStartSlot, epochForSlot } from "./utils/epochFromSlotCalculations";
import { bech32HeaderByte, credTypeOf, headerStakeIsScript, pointerFromAddressBytes, rawAddressBytesOf, rewardAccountTypedHex, shelleyAddressBech32, typedCredBytes, typedCredHex, typedCredHexOf } from "./db/stakeCred";
import { BoundedMap } from "./utils/boundedMap";
import { recentOutputs, rememberRecentOutput, spentRowsStats, type KnownUtxoRow } from "./db/recentOutputs";
import { logger } from "./utils/logger";
import { Address as LedgerAddress } from "@harmoniclabs/cardano-ledger-ts";
import { addDonationToPot, addFeeToPot, ensureLeaderStateTables, recordGenesisDelegation, recordPoolRegistration, recordPoolRetirement, queueMir } from "./db/leaderState";
import { stabilityWindowSlots } from "./utils/epochFromSlotCalculations";
import { ensurePParamsTables, recordUpdateProposal } from "./consensus/pparams";
import { ensureGovernanceTables, recordCommitteeHot, recordCommitteeResign, recordDRepActivity, recordDRepRegistration, recordDRepUnregistration, recordProposals, recordStakeDeregistration, recordVoteDelegation, recordVotes } from "./consensus/governance/state";
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
import { explorerIndexer, mbSql } from "./db/minibf/explorerIndexer";

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

// ─────────────── batched UTxO writes (apply path) ───────────────
// Row-by-row INSERTs through Bun.SQL cost ~30 µs each in plumbing; a block's
// UTxO rows and deltas are queued here and written as multi-row statements
// (11× cheaper measured). Queued rows are flushed before any read of the
// utxo table on the apply path (start of applyTransaction /
// applyInvalidTransaction) and at the end of applyBlock, so visibility is
// identical to the row-by-row order. A failed range discards the queue
// together with the rolled-back transaction (discardPendingUtxoWrites).
const pendingUtxoRows: unknown[][] = [];
const pendingDeltaRows: Array<[Uint8Array, string, string]> = [];
const UTXO_ROWS_PER_STATEMENT = 120; // 7 params each → 840 (SQLite limit 32 766)
const DELTA_ROWS_PER_STATEMENT = 300; // 3 params each

export function pendingUtxoWriteCount(): number {
    return pendingUtxoRows.length + pendingDeltaRows.length;
}

export function discardPendingUtxoWrites(): void {
    pendingUtxoRows.length = 0;
    pendingDeltaRows.length = 0;
}

/** Write every queued UTxO row and delta (multi-row statements), in queue order. */
export async function flushPendingUtxoWrites(db: SqlClient): Promise<void> {
    if (pendingUtxoRows.length) {
        const rows = pendingUtxoRows.splice(0, pendingUtxoRows.length);
        for (let i = 0; i < rows.length; i += UTXO_ROWS_PER_STATEMENT) {
            const chunk = rows.slice(i, i + UTXO_ROWS_PER_STATEMENT);
            const params: unknown[] = [];
            for (const r of chunk) params.push(...r);
            await db.unsafe(
                `INSERT OR REPLACE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace, reference_script_hash, stake_key) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",")}`,
                params as any,
            );
        }
    }
    if (pendingDeltaRows.length) {
        const rows = pendingDeltaRows.splice(0, pendingDeltaRows.length);
        for (let i = 0; i < rows.length; i += DELTA_ROWS_PER_STATEMENT) {
            const chunk = rows.slice(i, i + DELTA_ROWS_PER_STATEMENT);
            const params: unknown[] = [];
            for (const r of chunk) params.push(...r);
            await db.unsafe(`INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES ${chunk.map(() => "(?, ?, ?)").join(",")}`, params as any);
        }
    }
}

async function insertUtxoDelta(
    _db: SqlClient,
    blockHash: Uint8Array,
    action: string,
    utxo: string,
): Promise<void> {
    if (applySkipDeltas()) return;
    pendingDeltaRows.push([blockHash, action, utxo]);
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
    // REPLACE's implicit deletes fire DELETE triggers only with this on: the stake_balance
    // and ledger-journal triggers must see every row that goes away.
    await sql`PRAGMA recursive_triggers = ON`;
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
    // Stake credentials are (type, hash): 0 = key, 1 = script. Rows from before the
    // column existed keep NULL ("type unknown") and match either type on lookup.
    for (const table of ["stake", "delegations"]) {
        const cols = (await sql.unsafe(`PRAGMA table_info(${table})`)) as any[];
        const names = cols.map((c: any) => String(Array.isArray(c) ? c[1] : c?.name));
        if (!names.includes("cred_type")) {
            await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN cred_type INTEGER`);
        }
    }

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
    // Reward accounts are looked up per withdrawal, refund and payout; without this every lookup scanned the table (60 k rows × 53 k payouts per boundary ≈ minutes).
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_stake_credentials ON rewards(stake_credentials)`;

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
    for (const [col, type] of [["address", "TEXT"], ["lovelace", "INTEGER"], ["reference_script_hash", "TEXT"], ["stake_key", "TEXT"]] as const) {
        if (!utxoCols.has(col)) {
            logger.warn(`utxo table predates the indexed side columns; adding ${col} and backfilling`);
            await sql.unsafe(`ALTER TABLE utxo ADD COLUMN ${col} ${type}`);
        }
    }
    if (!utxoCols.has("address")) await sql.unsafe(BACKFILL_UTXO_COLUMNS_SQL);
    if (!utxoCols.has("stake_key")) await backfillStakeKeys();
    await ensureTypedStakeKeys();
    // Untyped stake/delegation rows (written before cred_type existed) get their type
    // from the certificate history in the stored blocks, once per database.
    try {
        const hasBlocks = (await sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'`.values()) as unknown[][];
        if (!hasBlocks.length) {
            // Fresh database (bug 100): nothing to rebuild, so record the one-off backfills as
            // done now. Without the markers the first restart of a genesis-built database
            // replayed all four over the stored chain (preview 2026-09-09: 22 GB read in ten
            // minutes, and the pointer backfill would have re-added the stake Conway dropped).
            await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
            for (const m of ["stake_cred_types_rebuilt", "delegations_rebuilt_poolreap", "utxo_byron_addresses_rebuilt", "orphaned_utxo_deltas_reverted", "stake_pointers_built"]) {
                await sql`INSERT OR IGNORE INTO schema_migrations (name) VALUES (${m})`;
            }
        } else {
            const { ensureStakeCredTypes, ensureDelegationsReaped } = await import("./db/retypeStakeCreds");
            await ensureStakeCredTypes(Number(shelleyStartSlot()));
            await ensureDelegationsReaped(Number(shelleyStartSlot()));
            await ensureByronOutputAddresses(Number(shelleyStartSlot()));
            await ensureOrphanedDeltasReverted();
            await sql`CREATE TABLE IF NOT EXISTS stake_pointers (slot INTEGER NOT NULL, tx_ix INTEGER NOT NULL, cert_ix INTEGER NOT NULL, stake_key TEXT NOT NULL, PRIMARY KEY (slot, tx_ix, cert_ix))`;
            await ensureStakePointers(Number(shelleyStartSlot()));
        }
    } catch (err) {
        logger.warn("stake credential type rebuild failed (untyped rows keep matching either type):", err);
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_utxo_stake_key ON utxo(stake_key) WHERE stake_key IS NOT NULL`;
    await ensureLeaderStateTables();
    await ensurePParamsTables();
    await ensureGovernanceTables();
    // Before-image journal for the state tables (rollback of certificates, pots, governance).
    await ensureLedgerJournal(sql as any);
    await sql`CREATE INDEX IF NOT EXISTS idx_utxo_address ON utxo(address)`;
    // Per-stake-credential UTxO balance, maintained by triggers on utxo. The epoch stake
    // snapshot reads it (60 k rows) instead of aggregating 2.9 M UTxOs (3.7 s per boundary,
    // 12 % of the applier's main thread at 100 blocks/s — SQL profile 2026-09-06).
    await sql`CREATE TABLE IF NOT EXISTS stake_balance (stake_key TEXT PRIMARY KEY, lovelace INTEGER NOT NULL DEFAULT 0)`;
    await sql`CREATE TRIGGER IF NOT EXISTS sb_utxo_i AFTER INSERT ON utxo WHEN NEW.stake_key IS NOT NULL BEGIN
        INSERT INTO stake_balance (stake_key, lovelace) VALUES (NEW.stake_key, COALESCE(NEW.lovelace, 0))
        ON CONFLICT(stake_key) DO UPDATE SET lovelace = lovelace + excluded.lovelace; END`;
    await sql`CREATE TRIGGER IF NOT EXISTS sb_utxo_d AFTER DELETE ON utxo WHEN OLD.stake_key IS NOT NULL BEGIN
        UPDATE stake_balance SET lovelace = lovelace - COALESCE(OLD.lovelace, 0) WHERE stake_key = OLD.stake_key; END`;
    await sql`CREATE TRIGGER IF NOT EXISTS sb_utxo_u AFTER UPDATE OF stake_key, lovelace ON utxo BEGIN
        UPDATE stake_balance SET lovelace = lovelace - COALESCE(OLD.lovelace, 0) WHERE OLD.stake_key IS NOT NULL AND stake_key = OLD.stake_key;
        INSERT INTO stake_balance (stake_key, lovelace) SELECT NEW.stake_key, COALESCE(NEW.lovelace, 0) WHERE NEW.stake_key IS NOT NULL
        ON CONFLICT(stake_key) DO UPDATE SET lovelace = lovelace + excluded.lovelace; END`;
    {
        // First run on an existing DB: derive the balances once (the triggers keep them from here).
        const have = (await sql`SELECT 1 FROM stake_balance LIMIT 1`.values()) as unknown[][];
        if (!have.length) {
            const any = (await sql`SELECT 1 FROM utxo WHERE stake_key IS NOT NULL LIMIT 1`.values()) as unknown[][];
            if (any.length) {
                const t0 = performance.now();
                await sql`INSERT INTO stake_balance (stake_key, lovelace) SELECT stake_key, SUM(COALESCE(lovelace, 0)) FROM utxo WHERE stake_key IS NOT NULL GROUP BY stake_key`;
                logger.info(`stake_balance derived from the UTxO set in ${Math.round(performance.now() - t0)} ms`);
            }
        }
    }
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
    // Pointer addresses (Shelley type 4/5) name their stake credential by the position of
    // its registration certificate (slot, tx index, cert index); resolved from this table.
    await sql`CREATE TABLE IF NOT EXISTS stake_pointers (
        slot INTEGER NOT NULL, tx_ix INTEGER NOT NULL, cert_ix INTEGER NOT NULL, stake_key TEXT NOT NULL,
        PRIMARY KEY (slot, tx_ix, cert_ix)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_utxo_deltas_block ON utxo_deltas(block_hash)`;

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

// Listings order by slot through idx_volatile_slot and break the one possible tie (a Byron
// EBB shares its slot with the epoch's first block) with NULLS LAST/FIRST: an expression such
// as `(block_no IS NULL)` in ORDER BY made SQLite sort the whole table (3 minutes on preview).
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
            `SELECT ${BLOCK_LIST_COLS} FROM blocks ORDER BY slot DESC, block_no DESC NULLS LAST LIMIT ${limit}`,
        ).values()) as unknown[][];
    } else if (opts.beforeIsEbb) {
        rows = (await sql.unsafe(
            `SELECT ${BLOCK_LIST_COLS} FROM blocks WHERE slot < ${Math.trunc(opts.beforeSlot)} ORDER BY slot DESC, block_no DESC NULLS LAST LIMIT ${limit}`,
        ).values()) as unknown[][];
    } else {
        // cursor was a main block: the EBB of the same slot (if any) comes next
        rows = (await sql.unsafe(
            `SELECT ${BLOCK_LIST_COLS} FROM blocks WHERE slot < ${Math.trunc(opts.beforeSlot)} OR (slot = ${Math.trunc(opts.beforeSlot)} AND block_no IS NULL) ORDER BY slot DESC, block_no DESC NULLS LAST LIMIT ${limit}`,
        ).values()) as unknown[][];
    }
    return rows.map(toBlockListRow);
}

/** Blocks of one slot range, oldest first (epoch pages). */
export async function listBlocksInSlotRange(fromSlot: number, toSlotExclusive: number, limit: number, offset = 0): Promise<BlockListRow[]> {
    const rows = (await sql`
        SELECT slot, hash, prev_hash, block_no, length(block_data), block_data, header_data FROM blocks
        WHERE slot >= ${Math.trunc(fromSlot)} AND slot < ${Math.trunc(toSlotExclusive)}
        ORDER BY slot ASC, block_no ASC NULLS FIRST
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

/** The applied block with the highest slot strictly below `slot` (prev hash + slot), or null. */
export async function getLastBlockBefore(slot: number): Promise<{ slot: number; hash: string; prevHash: string | null } | null> {
    const rows = (await sql`SELECT slot, hash, prev_hash FROM blocks WHERE slot < ${slot} AND is_valid = TRUE ORDER BY slot DESC LIMIT 1`.values()) as unknown[][];
    if (!rows.length) return null;
    const r = rows[0]!;
    return { slot: Number(r[0]), hash: String(r[1]), prevHash: r[2] == null ? null : String(r[2]) };
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

/** Chain tip for a block producer: highest applied block (slot, number, header hash hex). */
export async function getChainTip(): Promise<{ slot: bigint; blockNumber: bigint; hashHex: string } | null> {
    const rows = (await sql`SELECT hash, slot, block_no FROM blocks WHERE is_valid = TRUE ORDER BY slot DESC LIMIT 1`.values()) as unknown[][];
    if (!rows.length) return null;
    const h = rows[0]![0];
    const hashHex = h instanceof Uint8Array ? Buffer.from(h).toString("hex") : String(h);
    return { slot: BigInt(String(rows[0]![1])), blockNumber: BigInt(String(rows[0]![2] ?? 0)), hashHex: hashHex.toLowerCase() };
}

export async function getMaxBlockNo(): Promise<number> {
    const rows = (await sql`SELECT MAX(block_no) FROM blocks`.values()) as unknown[][];
    const v = rows[0]?.[0];
    return v == null ? 0 : Number(v);
}

/** Transactions in a block (mb_block_tx, then the legacy block_tx). */
export async function countBlockTxs(hashHex: string): Promise<number> {
    // block_hash is a 32-byte BLOB (older rows may hold the hex text): probe the primary key
    // with both forms. `hex(block_hash) = …` defeated the index and scanned millions of rows.
    const blob = Buffer.from(hashHex, "hex");
    const text = hashHex.toLowerCase();
    try {
        const n = await countQuery(mbSql()`SELECT COUNT(*) as c FROM mb_block_tx WHERE block_hash = ${blob} OR block_hash = ${text}`);
        if (n > 0) return n;
    } catch {
        /* table may not exist */
    }
    try {
        const n = await countQuery(sql`SELECT COUNT(*) as c FROM block_tx WHERE block_hash = ${blob} OR block_hash = ${text}`);
        if (n > 0) return n;
    } catch {
        /* table may not exist */
    }
    // Not indexed (Byron blocks synced before the Byron indexer, or the index paused while far
    // behind the tip): count the transactions in the stored block bytes.
    try {
        const rows = (await sql`SELECT block_data FROM blocks WHERE hash = ${hashHex.toLowerCase()} OR hash = ${Buffer.from(hashHex, "hex")}`.values()) as unknown[][];
        const data = rows[0]?.[0];
        if (data instanceof Uint8Array) return countTxsInBlockBytes(data);
    } catch {
        /* undecodable: report 0 */
    }
    return 0;
}

/** Transactions in a `[era, block]` payload, from the CBOR framing alone (no ledger decode). */
export function countTxsInBlockBytes(blockData: Uint8Array): number {
    const outer = Cbor.parseLazy(blockData);
    if (!(outer instanceof LazyCborArray) || outer.array.length < 2) return 0;
    const era = Cbor.parse(outer.array[0]!);
    if (!(era instanceof CborUInt)) return 0;
    const inner = Cbor.parseLazy(outer.array[1]!);
    if (!(inner instanceof LazyCborArray)) return 0;
    if (era.num === 0n) return 0; // Byron EBB: no transactions
    if (era.num === 1n) {
        // Byron main block: [header, body, extra]; body = [txPayload, ssc, dlg, upd]; txPayload = [[tx, witnesses], …]
        const body = Cbor.parseLazy(inner.array[1]!);
        if (!(body instanceof LazyCborArray) || body.array.length < 1) return 0;
        const txPayload = Cbor.parseLazy(body.array[0]!);
        return txPayload instanceof LazyCborArray ? txPayload.array.length : 0;
    }
    // Shelley+: [header, tx_bodies, witness_sets, aux, (invalid)]
    const bodies = Cbor.parseLazy(inner.array[1]!);
    return bodies instanceof LazyCborArray ? bodies.array.length : 0;
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

/** The block we hold at `slot` (hash hex + height), or null — one indexed read, no block bytes. */
export async function blockAtSlot(slot: bigint): Promise<{ hash: string; blockNo: number } | null> {
    const rows = (await sql`SELECT hash, block_no FROM blocks WHERE slot = ${slot}`.values()) as unknown[][];
    const r = rows[0];
    if (!r) return null;
    return { hash: String(r[0]).toLowerCase(), blockNo: Number(r[1] ?? 0) };
}

/** Hex hashes of the stored blocks above `slot` (what a rollback to `slot` removes). */
export async function blockHashesAbove(slot: bigint | number): Promise<string[]> {
    const rows = (await sql`SELECT hash FROM blocks WHERE slot > ${slot}`.values()) as unknown[][];
    return rows.map((r) => String(r[0]).toLowerCase());
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

/**
 * Points (slot, hash) of our most recent valid blocks, newest first — the candidates a
 * resuming ChainSync offers in MsgFindIntersect (see `intersectOffsets`).
 */
export async function getRecentBlockPoints(limit: number): Promise<Array<{ slot: bigint; hash: unknown }>> {
    const n = Math.max(1, Math.min(100_000, Math.trunc(limit)));
    const rows = await sql`SELECT slot, hash FROM blocks WHERE is_valid = TRUE ORDER BY slot DESC LIMIT ${n}`.values();
    const out: Array<{ slot: bigint; hash: unknown }> = [];
    for (const row of rows as unknown[][]) {
        const slot = row[0];
        if (slot == null || row[1] == null) continue;
        out.push({ slot: BigInt(slot as string | number | bigint), hash: row[1] });
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
    /** Stake credential hash (hex) of a Shelley base address; null otherwise. Feeds the stake snapshot. */
    stakeKey: string | null;
}

/**
 * Stake credential of a Shelley address string (base addresses only) as typed hex:
 * the hash for a key credential, "01" + hash for a script credential (see db/stakeCred.ts).
 */
const stakeKeyCache = new BoundedMap<string, string | null>(20_000);

export function stakeKeyOfAddress(address: string | null | undefined): string | null {
    if (!address || !address.startsWith("addr")) return null;
    const hit = stakeKeyCache.get(address);
    if (hit !== undefined) return hit;
    const v = stakeKeyOfAddressUncached(address);
    stakeKeyCache.set(address, v);
    return v;
}

/**
 * The same stake credential straight from a Shelley address's raw bytes (header byte, 28-byte
 * payment part, 28-byte stake part for base addresses): the apply path holds the bytes, and
 * decoding the bech32 string instead was 20 % of the applier thread on dense preview blocks.
 * Byron, enterprise, pointer and reward addresses have no stake hash here → null, as for the
 * string form.
 */
export function stakeKeyOfRawAddress(raw: Uint8Array | null | undefined): string | null {
    if (!raw || raw.length !== 57) return null;
    const type = raw[0]! >> 4;
    if (type > 3) return null;
    let hex = "";
    for (let i = 29; i < 57; i++) hex += HEX_BYTE[raw[i]!];
    return typedCredHex(type === 2 || type === 3 ? 1 : 0, hex);
}
const HEX_BYTE: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function stakeKeyOfAddressUncached(address: string): string | null {
    try {
        const a: any = LedgerAddress.fromString(address);
        const h = a?.stakeCreds?.hash;
        if (!h || Array.isArray(h)) return null; // pointer credentials carry no hash
        const hex = String(h.toString()).toLowerCase();
        if (!/^[0-9a-f]{56}$/.test(hex)) return null;
        const header = bech32HeaderByte(address);
        const isScript = header != null ? headerStakeIsScript(header) : credTypeOf(a?.stakeCreds) === 1;
        return typedCredHex(isScript ? 1 : 0, hex);
    } catch {
        return null;
    }
}

/**
 * One-off migration: `utxo.stake_key` rows written before script stake credentials
 * were typed carry the bare hash for script-stake addresses (types 2 and 3); rewrite
 * them as "01" + hash so the snapshot joins them with script delegations only.
 */
export async function ensureTypedStakeKeys(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = 'utxo_stake_key_typed'`.values()) as unknown[][];
    if (done.length) return;
    let scanned = 0, changed = 0;
    let last = "";
    for (;;) {
        const rows = (await sql`SELECT utxo_ref, address, stake_key FROM utxo WHERE utxo_ref > ${last} AND stake_key IS NOT NULL AND length(stake_key) = 56 ORDER BY utxo_ref LIMIT 5000`.values()) as unknown[][];
        if (rows.length === 0) break;
        const updates: Array<[string, string]> = [];
        for (const r of rows) {
            last = String(r[0]);
            scanned++;
            const addr = r[1] == null ? "" : String(r[1]);
            const header = addr.startsWith("addr") ? bech32HeaderByte(addr) : null;
            if (header != null && headerStakeIsScript(header)) updates.push([last, `01${String(r[2])}`]);
        }
        if (updates.length) {
            await sql.begin(async () => {
                for (const [ref, key] of updates) await sql`UPDATE utxo SET stake_key = ${key} WHERE utxo_ref = ${ref}`;
            });
            changed += updates.length;
        }
    }
    await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('utxo_stake_key_typed')`;
    if (scanned) logger.info(`utxo.stake_key typed: ${changed} script-stake output(s) retagged out of ${scanned}`);
}

export function txOutColumns(txOut: string | Record<string, unknown> | null | undefined, stakeKey?: string | null): TxOutColumns {
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
    return { address, lovelace, referenceScriptHash: ref, stakeKey: stakeKey !== undefined ? stakeKey : stakeKeyOfAddress(address) };
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

/**
 * One-off: outputs at Byron bootstrap addresses inside Shelley-era transactions
 * were stored with ledger-ts's bogus bech32 form (`addr…prvpsk…`, see
 * utils/byronAddressString.ts). Rebuild the base58 address from the stored blocks
 * for every such unspent output so bootstrap witnesses can be checked when spent.
 */
export async function ensureByronOutputAddresses(shelleyStartSlot: number): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = 'utxo_byron_addresses_rebuilt'`.values()) as unknown[][];
    if (done.length) return;
    const tip = (await sql`SELECT COALESCE(MAX(slot), 0) FROM blocks`.values()) as unknown[][];
    if (Number(tip[0]?.[0] ?? 0) < shelleyStartSlot) {
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('utxo_byron_addresses_rebuilt')`;
        return;
    }
    const t0 = performance.now();
    let scanned = 0, rewritten = 0;
    const { MultiEraBlock } = await import("@harmoniclabs/cardano-ledger-ts");
    const { isByronTypedAddress, byronBase58Of } = await import("./utils/byronAddressString");
    for await (const row of storedBlocksInSlotRange(shelleyStartSlot, Number(tip[0]?.[0] ?? 0))) {
        let m: any;
        try { m = MultiEraBlock.fromCbor(row.block_data); } catch { continue; }
        if (Number(m.era) < 2) continue;
        scanned++;
        const bodies: any[] = m.block?.transactionBodies ?? [];
        for (const body of bodies) {
            const outs: any[] = body?.outputs ?? [];
            for (let i = 0; i < outs.length; i++) {
                const a = outs[i]?.address;
                if (!isByronTypedAddress(a)) continue;
                const b58 = byronBase58Of(a);
                if (!b58) continue;
                let txId = "";
                try { txId = toHex(body.hash instanceof Uint8Array ? body.hash : body.hash.toBuffer()); } catch { continue; }
                const ref = `${txId}:${i}`;
                const cur = (await sql`SELECT tx_out FROM utxo WHERE utxo_ref = ${ref} AND address <> ${b58}`.values()) as unknown[][];
                if (!cur.length) continue;
                let json: any = {};
                try { json = JSON.parse(String(cur[0]![0])); } catch { /* keep */ }
                json.address = b58;
                await sql`UPDATE utxo SET address = ${b58}, tx_out = ${JSON.stringify(json)}, stake_key = NULL WHERE utxo_ref = ${ref}`;
                rewritten++;
            }
        }
    }
    await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('utxo_byron_addresses_rebuilt')`;
    logger.info(`Byron-address outputs rebuilt from ${scanned} stored block(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${rewritten} unspent output(s) rewritten to base58`);
}

/**
 * One-off: deltas whose block is no longer in `blocks` belong to rolled-back blocks
 * whose UTxO effects were never reverted (the rollback compared a hex-text hash with
 * a blob). Revert them now — newest first: creates removed, spends re-inserted — and
 * drop them, so the UTxO set matches the chain again.
 */
export async function ensureOrphanedDeltasReverted(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = 'orphaned_utxo_deltas_reverted'`.values()) as unknown[][];
    if (done.length) return;
    const t0 = performance.now();
    const rows = (await sql`
        SELECT d.id, d.action, d.utxo, d.block_hash FROM utxo_deltas d
        WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.hash = lower(hex(d.block_hash)) OR b.hash = d.block_hash)
        ORDER BY d.id DESC`.values()) as unknown[][];
    let restored = 0, removed = 0;
    const blocks = new Set<string>();
    await sql.begin(async () => {
        for (const r of rows) {
            const action = String(r[1]);
            const parsed = parseUtxoDelta(r[2]);
            blocks.add(String(r[3]));
            if (action === "create" && parsed.utxo_ref) {
                await sql`DELETE FROM utxo WHERE utxo_ref = ${parsed.utxo_ref}`;
                removed++;
            } else if (action === "spend" && parsed.utxo_ref) {
                const txHash = parsed.tx_hash ?? (parsed.utxo_ref.includes(":") ? parsed.utxo_ref.split(":")[0] : "");
                await upsertUtxoRow(sql, parsed.utxo_ref, parsed.tx_out, txHash);
                restored++;
            }
            await sql`DELETE FROM utxo_deltas WHERE id = ${Number(r[0])}`;
        }
        await flushPendingUtxoWrites(sql); // upsertUtxoRow queues; write the restored outputs inside this transaction
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('orphaned_utxo_deltas_reverted')`;
    });
    if (rows.length) logger.warn(`Reverted ${rows.length} orphaned UTxO delta(s) from ${blocks.size} rolled-back block(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${restored} spent output(s) restored, ${removed} created output(s) removed`);
}

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Bytes(addr: string): Uint8Array | null {
    const i = addr.lastIndexOf("1");
    if (i <= 0 || addr.length < i + 7) return null;
    const data = addr.slice(i + 1, -6).toLowerCase();
    let acc = 0, bits = 0;
    const out: number[] = [];
    for (const c of data) {
        const v = BECH32_ALPHABET.indexOf(c);
        if (v < 0) return null;
        acc = (acc << 5) | v; bits += 5;
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return Uint8Array.from(out);
}

/** (slot, tx index, cert index) of a pointer address's stake credential, or null for other addresses. */
export function pointerOfAddress(a: any): { slot: number; txIx: number; certIx: number } | null {
    try {
        if (String(a?.type ?? "").toLowerCase() !== "pointer") return null;
        // ledger-ts does not decode the pointer: read it from the raw address bytes.
        const raw = rawAddressBytesOf(a);
        return raw ? pointerFromAddressBytes(raw) : null;
    } catch {
        return null;
    }
}

/** Pointer of a stored bech32 address string (full form, see utils/byronAddressString.ts), or null. */
export function pointerOfAddressString(address: string): { slot: number; txIx: number; certIx: number } | null {
    if (!address.startsWith("addr")) return null;
    const raw = bech32Bytes(address);
    return raw ? pointerFromAddressBytes(raw) : null;
}

/**
 * Conway translation: pointer addresses lose their stake rights (the Ptr map is dropped when the
 * ledger state is translated at the Babbage→Conway boundary), so outputs created earlier at
 * pointer addresses stop counting for their credential from the first Conway snapshot on. Bug 93:
 * preview's one such output (35 553 ADA at addr_test1g…, credential 0c90492b…) stayed in our
 * stake from epoch 647 (+75 ppm on every reward of its pool until it was spent). Nulling the
 * stake key lets the stake_balance triggers do the accounting; later spends see the NULL.
 * Header nibble 4/5 ⇒ bech32 data begins with 'g' / '2' (mainnet and testnet alike).
 */
export async function dropPointerStakeForConway(client?: SqlClient): Promise<{ outputs: number; lovelace: bigint }> {
    const db = client ?? sql;
    const where = `stake_key IS NOT NULL AND (address LIKE 'addr1g%' OR address LIKE 'addr12%' OR address LIKE 'addr_test1g%' OR address LIKE 'addr_test12%')`;
    const rows = (await db.unsafe(`SELECT COUNT(*), COALESCE(SUM(lovelace), 0) FROM utxo WHERE ${where}`).values()) as unknown[][];
    const outputs = Number(rows[0]?.[0] ?? 0);
    const lovelace = BigInt(String(rows[0]?.[1] ?? 0));
    if (outputs > 0) await db.unsafe(`UPDATE utxo SET stake_key = NULL WHERE ${where}`);
    return { outputs, lovelace };
}

/** Typed stake key registered at a pointer's position, or null when nothing was registered there. */
export async function resolveStakePointer(db: SqlClient, ptr: { slot: number; txIx: number; certIx: number }): Promise<string | null> {
    const rows = (await db`SELECT stake_key FROM stake_pointers WHERE slot = ${ptr.slot} AND tx_ix = ${ptr.txIx} AND cert_ix = ${ptr.certIx}`.values()) as unknown[][];
    return rows.length ? String(rows[0]![0]) : null;
}

/**
 * One-off: build `stake_pointers` from the stored blocks and give pointer-address
 * outputs their stake key (preview account 0c90492b… had 35.55·10⁹ at a pointer
 * address that never counted in its stake).
 */
export async function ensureStakePointers(shelleyStartSlot: number): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    const done = (await sql`SELECT 1 FROM schema_migrations WHERE name = 'stake_pointers_built'`.values()) as unknown[][];
    if (done.length) return;
    const tip = (await sql`SELECT COALESCE(MAX(slot), 0) FROM blocks`.values()) as unknown[][];
    if (Number(tip[0]?.[0] ?? 0) < shelleyStartSlot) {
        await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('stake_pointers_built')`;
        return;
    }
    const t0 = performance.now();
    const { MultiEraBlock } = await import("@harmoniclabs/cardano-ledger-ts");
    let pointers = 0, retagged = 0, scanned = 0;
    for await (const row of storedBlocksInSlotRange(shelleyStartSlot, Number(tip[0]?.[0] ?? 0))) {
        let m: any;
        try { m = MultiEraBlock.fromCbor(row.block_data); } catch { continue; }
        if (Number(m.era) < 2) continue;
        scanned++;
        const bodies: any[] = m.block?.transactionBodies ?? [];
        const invalid = new Set<number>(((m.block as any)?.invalidTransactions ?? []).map((x: any) => Number(x)));
        for (let ti = 0; ti < bodies.length; ti++) {
            if (invalid.has(ti)) continue;
            const certs: any[] = bodies[ti]?.certs ?? [];
            for (let ci = 0; ci < certs.length; ci++) {
                if (!certStakeEffect(Number(certs[ci]?.certType)).registers) continue;
                const key = typedCredHexOf(certs[ci]?.stakeCredential);
                if (!key) continue;
                await sql`INSERT OR REPLACE INTO stake_pointers (slot, tx_ix, cert_ix, stake_key) VALUES (${row.slot}, ${ti}, ${ci}, ${key})`;
                pointers++;
            }
            // Outputs at pointer addresses (stored truncated by ledger-ts): full address + stake key.
            if (Number(m.era) >= 7) continue; // Conway: pointer addresses carry no stake rights
            const outs: any[] = bodies[ti]?.outputs ?? [];
            for (let oi = 0; oi < outs.length; oi++) {
                const a = outs[oi]?.address;
                if (String(a?.type ?? "").toLowerCase() !== "pointer") continue;
                const raw = rawAddressBytesOf(a);
                const ptr = raw ? pointerFromAddressBytes(raw) : null;
                if (!raw || !ptr) continue;
                let txId = "";
                try { txId = toHex(bodies[ti].hash instanceof Uint8Array ? bodies[ti].hash : bodies[ti].hash.toBuffer()); } catch { continue; }
                const ref = `${txId}:${oi}`;
                const cur = (await sql`SELECT tx_out FROM utxo WHERE utxo_ref = ${ref}`.values()) as unknown[][];
                if (!cur.length) continue;
                const key = await resolveStakePointer(sql, ptr);
                const full = shelleyAddressBech32(raw);
                let json: any = {};
                try { json = JSON.parse(String(cur[0]![0])); } catch { /* keep */ }
                json.address = full;
                await sql`UPDATE utxo SET address = ${full}, tx_out = ${JSON.stringify(json)}, stake_key = ${key} WHERE utxo_ref = ${ref}`;
                if (key) retagged++;
            }
        }
    }
    await sql`INSERT OR REPLACE INTO schema_migrations (name) VALUES ('stake_pointers_built')`;
    logger.info(`stake pointers built from ${scanned} block(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${pointers} registration(s) indexed, ${retagged} pointer-address output(s) given a stake key`);
}

/** Fill `utxo.stake_key` for rows written before the column existed (Shelley base addresses only). */
export async function backfillStakeKeys(): Promise<number> {
    let done = 0;
    let last = "";
    for (;;) {
        const rows = (await sql`SELECT utxo_ref, address FROM utxo WHERE utxo_ref > ${last} AND address LIKE 'addr%' ORDER BY utxo_ref LIMIT 5000`.values()) as unknown[][];
        if (rows.length === 0) break;
        for (const r of rows) {
            const ref = String(r[0]);
            const key = stakeKeyOfAddress(r[1] == null ? null : String(r[1]));
            if (key) await sql`UPDATE utxo SET stake_key = ${key} WHERE utxo_ref = ${ref}`;
            last = ref;
            done++;
        }
    }
    if (done) logger.info(`utxo.stake_key backfilled for ${done} Shelley outputs`);
    return done;
}

/** The one writer of `utxo` rows: JSON plus the indexed side columns. */
async function upsertUtxoRow(
    db: SqlClient,
    utxoRef: string,
    txOut: string,
    txHash: string | null,
    cols: TxOutColumns = txOutColumns(txOut),
): Promise<void> {
    // queued; written by flushPendingUtxoWrites before the next utxo read / at block end
    void db;
    pendingUtxoRows.push([utxoRef, txOut, txHash, cols.address, cols.lovelace, cols.referenceScriptHash, cols.stakeKey]);
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
/** A stake credential as the ledger keys it: hash plus type (0 = key, 1 = script). */
export interface StakeCredRef {
    hash: Uint8Array;
    type: number;
}

function distinctCredentials(creds: Array<Uint8Array | StakeCredRef>): StakeCredRef[] {
    const seen = new Map<string, StakeCredRef>();
    for (const c of creds) {
        const ref: StakeCredRef = c instanceof Uint8Array ? { hash: c, type: 0 } : c;
        if (ref.hash && ref.hash.length > 0) seen.set(`${ref.type}:${toHex(ref.hash)}`, ref);
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
    creds: Array<Uint8Array | StakeCredRef>,
): Promise<Array<{ stake_credentials: Uint8Array; cred_type: number; amount: number }>> {
    const out: Array<{ stake_credentials: Uint8Array; cred_type: number; amount: number }> = [];
    for (const cred of distinctCredentials(creds)) {
        // A legacy row (cred_type NULL) matches either type.
        const rows = await sql`SELECT stake_credentials, amount FROM stake WHERE stake_credentials = ${cred.hash} AND (cred_type IS NULL OR cred_type = ${cred.type})`
            .values() as any[];
        for (const row of rows) {
            const c = Array.isArray(row) ? row[0] : row?.stake_credentials;
            const a = Array.isArray(row) ? row[1] : row?.amount;
            out.push({ stake_credentials: bytesOf(c), cred_type: cred.type, amount: Number(a ?? 0) });
        }
    }
    return out;
}

/** Keyed alternative to getAllDelegations(): only the rows for `creds`. See getStakeByCredentials. */
export async function getDelegationsByCredentials(
    creds: Array<Uint8Array | StakeCredRef>,
): Promise<Array<{ stake_credentials: Uint8Array; cred_type: number; pool_key_hash: Uint8Array }>> {
    const out: Array<{ stake_credentials: Uint8Array; cred_type: number; pool_key_hash: Uint8Array }> = [];
    for (const cred of distinctCredentials(creds)) {
        const rows = await sql`SELECT stake_credentials, pool_key_hash FROM delegations WHERE stake_credentials = ${cred.hash} AND (cred_type IS NULL OR cred_type = ${cred.type})`
            .values() as any[];
        for (const row of rows) {
            const c = Array.isArray(row) ? row[0] : row?.stake_credentials;
            const p = Array.isArray(row) ? row[1] : row?.pool_key_hash;
            out.push({ stake_credentials: bytesOf(c), cred_type: cred.type, pool_key_hash: bytesOf(p) });
        }
    }
    return out;
}

/** A stored UTxO row as the applier needs it to record a spend. */
export type { KnownUtxoRow } from "./db/recentOutputs";
export { rememberRecentOutput, resetRecentOutputs, spentRowsStats } from "./db/recentOutputs";
export { rewardAccountTypedHex } from "./db/stakeCred";

export type TxIndexCtx = {
    /** Block era (0 Byron … 7 Conway), for era-dependent update decoding. */
    era?: number;
    /**
     * UTxO rows the rules stage already read for this block (by ref). Spends are served
     * from here and only refs it lacks (outputs of earlier blocks in the same range) are
     * read from the database; the bulk DELETE's row count still verifies every input.
     */
    knownInputs?: Map<string, KnownUtxoRow>;
    /** Epoch of the block (governance capture). */
    epoch?: number;
    /** `gov_action_lifetime` of the epoch (proposal expiry). */
    govActionLifetime?: number;
    /** Block-level fee accumulator: the block credits the fee pot once (two UPDATEs per transaction were 37 % of the applier's SQL time). */
    feeAcc?: { total: bigint; donations: bigint };
    /** Block-level spend accumulator: one DELETE … RETURNING per block instead of one per transaction, and one flush of the pending UTxO writes per block (the recent-outputs cache serves same-block spends). */
    blockSpends?: BlockSpends;
    slot: number;
    txIndex: number;
    /** Chain height of the containing block (mb_tx.block_height). */
    blockHeight?: number | null;
};

/** Parse address from packed tx_out JSON (best-effort). */
/** Address as stored: bech32 for Shelley addresses, base58 for Byron ones (ByronAddress has no toString). */
export function addressToString(a: any): string {
    return outputAddressString(a);
}

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

        // The legacy thin indexes (tx_index / block_tx / address_tx) are no longer written: every
        // reader tries the mb_* projections first, and the dual write was 11 % of the applier's
        // main-thread time (SQL profile 2026-09-06). Rollback still clears them if present.
        // mb_* derived projections (full IO when inputs/outputs provided). With the explorer
        // worker running they go to its own database file, off the applier's thread.
        if (explorerIndexer.active) {
            await explorerIndexer.enqueue({
                blockHeight: opts.blockHeight ?? null,
                txHash,
                blockHash: opts.blockHash,
                slot: opts.slot,
                txIndex: opts.txIndex,
                fee: opts.fee ?? null,
                size: opts.size ?? null,
                invalidBefore: opts.invalidBefore ?? null,
                invalidHereafter: opts.invalidHereafter ?? null,
                addresses: opts.addresses,
                inputs: opts.inputs ?? [],
                outputs: opts.outputs ?? [],
            });
            return;
        }
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

/**
 * Strict apply: a block that spends an input we do not hold is rejected instead
 * of applied with the input skipped. Set by the orchestrator from the validation
 * policy (complete ledger → strict); the Mithril importer and tip sync keep the
 * tolerant behaviour.
 */
let strictUtxoApply = false;
export function setStrictUtxoApply(on: boolean): void {
    strictUtxoApply = on;
}

/**
 * Rows of the inputs a transaction spends: from the rules stage's `known` rows where
 * available, the database for the rest. Exported for tests.
 */
export type BlockSpends = { refs: string[]; expected: number; txOfRef: Map<string, string> };
export function newBlockSpends(): BlockSpends { return { refs: [], expected: 0, txOfRef: new Map() }; }

/**
 * Delete a block's spent outputs in one statement (chunked for the parameter limit) and, under
 * strict apply, verify that every input row the transactions found was deleted — the same
 * check the per-transaction path made, with the offending transactions named on failure.
 */
export async function deleteBlockSpends(db: SqlClient, spends: BlockSpends): Promise<number> {
    if (spends.refs.length === 0) return 0;
    const returned = new Set<string>();
    for (let i = 0; i < spends.refs.length; i += 2000) {
        const chunk = spends.refs.slice(i, i + 2000);
        const rows = (await db`DELETE FROM utxo WHERE utxo_ref IN ${db(chunk)} RETURNING utxo_ref`.values()) as unknown[][];
        for (const r of rows) returned.add(String(r[0]));
    }
    if (strictUtxoApply && returned.size !== spends.expected) {
        const missing = spends.refs.filter((r) => !returned.has(r));
        const byTx = new Map<string, number>();
        for (const r of missing) { const tx = spends.txOfRef.get(r) ?? "?"; byTx.set(tx, (byTx.get(tx) ?? 0) + 1); }
        const who = [...byTx].slice(0, 5).map(([tx, n]) => `tx ${tx.slice(0, 16)}… (${n})`).join(", ");
        throw new Error(`block: ${spends.expected} input row(s) known but ${returned.size} deleted from the UTxO set (stale rules-stage rows or a double spend): ${who}`);
    }
    return returned.size;
}

export async function loadSpentRows(db: SqlClient, inputRefs: string[], known?: Map<string, KnownUtxoRow>): Promise<KnownUtxoRow[]> {
    const out: KnownUtxoRow[] = [];
    const missing: string[] = [];
    for (const ref of inputRefs) {
        const k = known?.get(ref);
        if (k) { out.push(k); recentOutputs.delete(ref); spentRowsStats.known++; continue; }
        const r = recentOutputs.get(ref);
        if (r) { out.push(r); recentOutputs.delete(ref); spentRowsStats.recent++; continue; }
        missing.push(ref);
    }
    spentRowsStats.db += missing.length;
    if (missing.length) {
        const rows = await db`SELECT utxo_ref, tx_out, tx_hash, address FROM utxo WHERE utxo_ref IN ${db(missing)}` as any[];
        for (const row of rows) {
            out.push(Array.isArray(row)
                ? { utxo_ref: String(row[0]), tx_out: row[1] == null ? null : String(row[1]), tx_hash: row[2] == null ? null : String(row[2]), address: row[3] == null ? null : String(row[3]) }
                : { utxo_ref: String(row.utxo_ref), tx_out: row.tx_out == null ? null : String(row.tx_out), tx_hash: row.tx_hash == null ? null : String(row.tx_hash), address: row.address == null ? null : String(row.address) });
        }
    }
    return out;
}

function assertInputsPresent(inputRefs: string[], rows: any[], txId: string): void {
    if (!strictUtxoApply || rows.length === inputRefs.length) return;
    const have = new Set(rows.map((r) => String(Array.isArray(r) ? r[0] : r.utxo_ref)));
    const missing = inputRefs.filter((r) => !have.has(r));
    if (missing.length === 0) return;
    throw new Error(`tx ${txId} spends ${missing.length} input(s) not in the UTxO set: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`);
}

/** The UTxO row a transaction output becomes (same mapping as rollback's restore and the repair script). */
export function buildUtxoRowForOutput(txId: string, i: number, output: any): {
    utxoRef: string; txOutJson: string; cols: TxOutColumns; address: string; lovelace: string; assetsJson: string | null;
    metadata: ReturnType<typeof extractLedgerTxOutMetadata>;
} {
    const utxoRef = `${txId}:${i}`;
    const assetsObj: Record<string, Record<string, string>> = {};
    const multiAssets = Array.isArray(output.value?.map) ? output.value.map : [];
    multiAssets.forEach((ma: any) => {
        const policyStr = ma.policy.toString();
        const assetObj: Record<string, string> = {};
        (Array.isArray(ma.assets) ? ma.assets : []).forEach((asset: any) => {
            assetObj[toHex(asset.name)] = asset.quantity.toString();
        });
        assetsObj[policyStr] = assetObj;
    });
    const address = addressToString(output.address);
    const lovelace = output.value?.lovelaces?.toString() || "0";
    const assetsJson = Object.keys(assetsObj).length > 0 ? JSON.stringify(assetsObj) : null;
    const metadata = extractLedgerTxOutMetadata(output);
    const txOutJson = JSON.stringify({
        address,
        amount: lovelace,
        assets: assetsObj,
        ...(metadata.datumHash ? { datum_hash: metadata.datumHash } : {}),
        ...(metadata.inlineDatumCbor ? { inline_datum: metadata.inlineDatumCbor } : {}),
        ...(metadata.scriptRefHash ? { reference_script_hash: metadata.scriptRefHash } : {}),
        ...(metadata.scriptRefCbor ? { reference_script_cbor: metadata.scriptRefCbor } : {}),
    });
    // Same mapping as the JSON→columns helper used on restore, so a UTxO written
    // here and the same UTxO restored by rollbackChainTo index identically.
    const raw = address.startsWith("addr") ? rawAddressBytesOf(output.address) : null;
    const cols: TxOutColumns = txOutColumns({ address, amount: lovelace, reference_script_hash: metadata.scriptRefHash ?? undefined }, raw ? stakeKeyOfRawAddress(raw) : undefined);
    return { utxoRef, txOutJson, cols, address, lovelace, assetsJson, metadata };
}

/**
 * `txid:index` of the inputs a transaction spends, each once. Before Conway the inputs are a
 * CBOR list and a transaction may repeat one (preview slot 50 778 243 does); the ledger spends
 * the set. Counting the repeat twice against one deleted row tripped the strict per-block
 * delete check and reset the range pipeline (bug 78).
 */
export function spentInputRefs(txBody: { inputs: any[] }): string[] {
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const input of txBody.inputs) {
        const ref = `${input.utxoRef.id.toString()}:${input.utxoRef.index}`;
        if (!seen.has(ref)) { seen.add(ref); refs.push(ref); }
    }
    return refs;
}

export async function applyTransaction(
    txBody: TxBody,
    blockHash: Uint8Array,
    client?: SqlClient,
    indexCtx?: TxIndexCtx,
): Promise<void> {
    const db = client ?? sql;
    // Under a block-level spend accumulator the lookups are served from the recent-outputs cache and
    // the block flushes once; otherwise earlier txs' outputs must be visible to this tx's lookups.
    if (!indexCtx?.blockSpends) await flushPendingUtxoWrites(db);
    const txId = txBody.hash.toString(); // Canonical blake2b_256(txBody CBOR) hex from ledger-ts

    if (!txBody.inputs || !Array.isArray(txBody.inputs)) {
        logger.warn(
            `Skipping tx ${txId} due to invalid inputs:`,
            txBody.inputs,
        );
        return;
    }

    const inputRefs = spentInputRefs(txBody);


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
        const existingUtxos = await loadSpentRows(db, inputRefs, indexCtx?.knownInputs);
        assertInputsPresent(inputRefs, existingUtxos, txId);
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
            // RETURNING gives the rows this statement removed; the driver's change count also
            // includes the rows the stake_balance triggers touch (it broke this check 2026-09-06).
            if (indexCtx?.blockSpends) {
                const bs = indexCtx.blockSpends;
                for (const r of inputRefs) { bs.refs.push(r); bs.txOfRef.set(r, txId); }
                bs.expected += existingUtxos.length;
            } else {
                const delRows = (await db`DELETE FROM utxo WHERE utxo_ref IN ${db(inputRefs)} RETURNING utxo_ref`.values()) as unknown[][];
                const deleted = delRows.length;
                if (strictUtxoApply && indexCtx?.knownInputs && deleted !== existingUtxos.length) {
                    throw new Error(`tx ${txId}: ${existingUtxos.length} input row(s) known but ${deleted} deleted from the UTxO set (stale rules-stage rows)`);
                }
            }
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
            const row = buildUtxoRowForOutput(txId, i, output);
            if (row.address && row.address.length > 8) {
                const prev = addrDirs.get(row.address);
                addrDirs.set(row.address, prev === "out" || prev === "both" ? "both" : "in");
            }
            mbOutputs.push({
                outputIndex: i,
                address: row.address,
                lovelace: row.lovelace,
                assetsJson: row.assetsJson,
                datumHash: row.metadata.datumHash,
                inlineDatumCbor: row.metadata.inlineDatumCbor,
                scriptRefHash: row.metadata.scriptRefHash,
            });
            return [row.utxoRef, row.txOutJson, txId, row.cols] as [string, string, string, TxOutColumns];
        },
    );
    for (const [ref, txOutJson, txHash, cols] of outputData) rememberRecentOutput({ utxo_ref: ref, tx_out: txOutJson, tx_hash: txHash, address: cols.address ?? null, reference_script_hash: cols.referenceScriptHash ?? null });

    // Pointer addresses: the stake credential is the one registered at (slot, tx, cert).
    // Conway removed pointer addresses' stake rights, so only pre-Conway outputs resolve.
    if (indexCtx == null || Number(indexCtx.era ?? 0) <= 6) {
        for (let i = 0; i < outputData.length; i++) {
            const cols = outputData[i]![3];
            if (cols.stakeKey != null) continue;
            const ptr = pointerOfAddress((txBody.outputs as any[])[i]?.address);
            if (!ptr) continue;
            cols.stakeKey = await resolveStakePointer(db, ptr);
        }
    }

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
        await applyCertificates(txBody.certs, blockHash, client, indexCtx ? { slot: indexCtx.slot, epoch: indexCtx.epoch, txIndex: indexCtx.txIndex } : undefined);
    }
    if (indexCtx) {
        const body: any = txBody;
        try {
            if (Array.isArray(body.proposalProcedures) && body.proposalProcedures.length) {
                const lifetime = Number(indexCtx.govActionLifetime ?? 6);
                let bodyBytes: Uint8Array | null = null;
                try { bodyBytes = body.cborRef?.toBuffer?.() ?? null; } catch { bodyBytes = null; }
                await recordProposals(db, txId, body.proposalProcedures, Number(indexCtx.epoch ?? 0), lifetime, bodyBytes);
            }
            if (Array.isArray(body.votingProcedures?.procedures) && body.votingProcedures.procedures.length) {
                await recordVotes(db, body.votingProcedures.procedures, indexCtx.slot, Number(indexCtx.epoch ?? 0));
            }
        } catch (err) {
            logger.warn("governance capture failed:", err);
        }
    }
    if ((txBody as any).protocolUpdate && indexCtx) {
        try {
            await recordUpdateProposal(db, (txBody as any).protocolUpdate, indexCtx.slot, (txBody as any).cborRef?.toBuffer?.() ?? null, (indexCtx.era ?? 0) >= 6 ? 7 : 5);
        } catch (err) {
            logger.warn("protocol update proposal not recorded:", err);
        }
    }

    // ledger-ts `TxWithdrawals` is an object with `.map`, never an array: the
    // `Array.isArray` guard here meant no withdrawal was ever debited from `rewards`
    // (found by per-delegator stake comparison with Koios on preprod epoch 41).
    if (withdrawalEntries(txBody.withdrawals).length > 0) {
        await applyWithdrawals(txBody.withdrawals, blockHash, client);
    }

    if (txBody.fee) {
        await insertUtxoDelta(
            db,
            blockHash,
            "fee",
            JSON.stringify({ amount: txBody.fee.toString() }),
        );
        // chain_account_state.treasury (the Blockfrost-shaped mirror) has no reader: the pots live in reward_pots.
        const donation = BigInt((txBody as any).donation ?? 0); // bug 92: Conway treasury donations reach the treasury at the boundary
        if (indexCtx?.feeAcc) { indexCtx.feeAcc.total += BigInt(txBody.fee); indexCtx.feeAcc.donations += donation; }
        else {
            // Fees accumulate in the fee pot; the boundary distributes them with the reward pot (Phase 4c).
            try {
                await addFeeToPot(db, BigInt(txBody.fee ?? 0));
                if (donation > 0n) await addDonationToPot(db, donation);
            } catch {
                /* pots not initialised yet (pre-Shelley) */
            }
        }
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
    ctx?: { slot: number; epoch?: number; txIndex?: number },
): Promise<void> {
    const db = client ?? sql;
    // Registration certificates are the targets of pointer addresses.
    if (ctx && ctx.txIndex != null) {
        for (let ci = 0; ci < certs.length; ci++) {
            const c: any = certs[ci];
            if (!certStakeEffect(Number(c?.certType)).registers) continue;
            const key = typedCredHexOf(c?.stakeCredential);
            if (key) await db`INSERT OR REPLACE INTO stake_pointers (slot, tx_ix, cert_ix, stake_key) VALUES (${ctx.slot}, ${ctx.txIndex}, ${ci}, ${key})`;
        }
    }
    // Header-rule state: registered pools with their VRF keys, retirements by
    // epoch, genesis delegations (effective after the stability window).
    if (ctx) {
        for (const cert of certs) {
            const c = cert as any;
            const t = Number(c.certType);
            try {
                // Bug 103: a deregistration drops the DRep delegation *in certificate order* — the
                // vote delegations are recorded in this pass, and preview tx 190fdc6e… (slot
                // 60 215 405) deregisters, re-registers and vote-delegates the same credential in
                // one transaction; dropping it in the later stake pass lost the new delegation.
                if (certStakeEffect(t).deregisters && c.stakeCredential) await recordStakeDeregistration(db, c.stakeCredential);
                if (t === 3 && c.poolParams?.operator && c.poolParams?.vrfKeyHash) {
                    const pp = c.poolParams;
                    const margin = pp.margin ?? {};
                    await recordPoolRegistration(db, String(pp.operator.toString()), String(pp.vrfKeyHash.toString()), ctx.slot, {
                        pledge: String(pp.pledge ?? 0),
                        cost: String(pp.cost ?? 0),
                        marginNum: String(margin.num ?? margin.numerator ?? 0),
                        marginDen: String(margin.den ?? margin.denominator ?? 1),
                        // A ledger-ts StakeAddress carries the credential type on itself (`type: "script"`),
                        // its `credentials` is the bare hash: a script reward account was stored untyped, never
                        // matched the typed registered set, and its operator rewards were dropped (preview
                        // pool ae1c21b1fb…, margin 100 %, ~283 B lovelace of rewards by epoch 1413; bug 84).
                        rewardAccount: rewardAccountTypedHex(pp.rewardAccount),
                        owners: ((pp.owners ?? []) as any[]).map((o) => String(o.toString()).toLowerCase()),
                    });
                } else if (t === 4 && c.poolHash) {
                    await recordPoolRetirement(db, String(c.poolHash.toString()), Number(c.epoch));
                } else if (t === 6) {
                    // MoveInstantRewards: takes effect at the next boundary (leaderState.applyPendingMir)
                    const source = Number(c.source ?? c.pot ?? 0) === 1 ? 1 : 0;
                    const dest: any = c.destination;
                    const entries: Array<{ stakeKey: string | null; amount: bigint }> = [];
                    if (Array.isArray(dest)) {
                        for (const e of dest) {
                            const key = typedCredHexOf(e?.stakeCredentials ?? e?.stakeCreds ?? e?.credential);
                            if (key) entries.push({ stakeKey: key, amount: BigInt(String(e?.amount ?? 0)) });
                        }
                    } else if (dest != null) {
                        entries.push({ stakeKey: null, amount: BigInt(String(typeof dest === "object" && "toString" in dest ? dest.toString() : dest)) });
                    }
                    if (entries.length) await queueMir(db, Number(ctx.epoch ?? 0), source, entries);
                } else if (t === 5 && c.genesisHash && c.genesisDelegateHash && c.vrfKeyHash) {
                    await recordGenesisDelegation(db, String(c.genesisHash.toString()), String(c.genesisDelegateHash.toString()), String(c.vrfKeyHash.toString()), ctx.slot + stabilityWindowSlots());
                } else if (t === 9 || t === 10 || t === 12 || t === 13) {
                    if (c.stakeCredential && c.drep) await recordVoteDelegation(db, c.stakeCredential, c.drep);
                } else if (t === 14 && c.coldCredential && c.hotCredential) {
                    await recordCommitteeHot(db, c.coldCredential, c.hotCredential);
                } else if (t === 15 && c.coldCredential) {
                    await recordCommitteeResign(db, c.coldCredential);
                } else if (t === 16 && c.drepCredential) {
                    await recordDRepRegistration(db, c.drepCredential, BigInt(c.coin ?? 0), ctx.slot, Number(ctx.epoch ?? 0));
                } else if (t === 17 && c.drepCredential) {
                    await recordDRepUnregistration(db, c.drepCredential);
                } else if (t === 18 && c.drepCredential) {
                    await recordDRepActivity(db, String(c.drepCredential.hash?.toString?.() ?? "").toLowerCase(), Number(ctx.epoch ?? 0));
                }
            } catch (err) {
                logger.warn(`leader-state update failed for certificate type ${t}:`, err);
            }
        }
    }
    const certDeltas: string[] = [];
    for (const cert of certs) {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();

        certDeltas.push(JSON.stringify({
            type: cert.certType,
            stakeCred: stakeCred ? toHex(stakeCred) : null,
            credType: certAny.stakeCredential ? (Number(certAny.stakeCredential.type) === 1 ? 1 : 0) : null,
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

    // In certificate order (bug 103: the parallel form interleaved the statements of the
    // certificates of one transaction).
    for (const cert of certs) {
        const certAny = cert as any;
        const stakeCred = certAny.stakeCredential?.hash?.toBuffer() ||
            certAny.stakeCredential?.toBuffer();
        // Stake-credential effects come from the same table the body validator uses
        // (certificateRules.ts), so validate and apply cannot drift per certificate type.
        const fx = certStakeEffect(Number(cert.certType));
        // (type, hash) keys a stake credential; a legacy row with cred_type NULL matches either type.
        const credType = certAny.stakeCredential ? (Number(certAny.stakeCredential.type) === 1 ? 1 : 0) : 0;
        if (stakeCred && fx.registers) {
            await db`INSERT OR REPLACE INTO stake (stake_credentials, cred_type, amount) VALUES (${stakeCred}, ${credType}, 0)`;
        }
        if (stakeCred && fx.deregisters) {
            await db`DELETE FROM stake WHERE stake_credentials = ${stakeCred} AND (cred_type IS NULL OR cred_type = ${credType})`;
            await db`DELETE FROM delegations WHERE stake_credentials = ${stakeCred} AND (cred_type IS NULL OR cred_type = ${credType})`;
            if (!ctx) await recordStakeDeregistration(db, certAny.stakeCredential); // bug 89: the DRep delegation goes too (with ctx: done in order above)
        }
        if (stakeCred && fx.delegatesToPool) {
            const poolKh = certAny.poolKeyHash?.toBuffer();
            if (poolKh) {
                // one row per credential: a re-delegation replaces the previous one
                await db`DELETE FROM delegations WHERE stake_credentials = ${stakeCred} AND (cred_type IS NULL OR cred_type = ${credType})`;
                await db`INSERT INTO delegations (stake_credentials, cred_type, pool_key_hash) VALUES (${stakeCred}, ${credType}, ${poolKh})`;
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
    }
}

/**
 * A transaction the block producer marked as phase-2 invalid: no inputs are
 * spent and no outputs created; the collateral inputs are consumed, the
 * collateral return (if any) is created at index `outputs.length`, and the
 * collateral lovelace goes to the fee pot (Alonzo UTXOS, `isValid = False`).
 */
export async function applyInvalidTransaction(
    txBody: TxBody,
    blockHash: Uint8Array,
    client?: SqlClient,
    indexCtx?: TxIndexCtx,
): Promise<void> {
    const db = client ?? sql;
    await flushPendingUtxoWrites(db); // earlier txs' outputs must be visible to this tx's input lookups
    const body: any = txBody;
    const txId = txBody.hash.toString().toLowerCase();
    const refs: string[] = [];
    for (const c of (body.collateralInputs ?? []) as any[]) {
        try {
            refs.push(`${String(c.utxoRef.id.toString()).toLowerCase()}:${Number(c.utxoRef.index)}`);
        } catch { /* malformed: the rules rejected it */ }
    }
    let consumed = 0n;
    if (refs.length) {
        const rows = (await db`SELECT utxo_ref, tx_out, tx_hash, lovelace FROM utxo WHERE utxo_ref IN ${db(refs)}`) as any[];
        assertInputsPresent(refs, rows, txId);
        for (const row of rows) {
            const utxo_ref = Array.isArray(row) ? String(row[0]) : String(row.utxo_ref);
            const tx_out = Array.isArray(row) ? String(row[1]) : String(row.tx_out);
            const tx_hash = Array.isArray(row) ? (row[2] != null ? String(row[2]) : undefined) : (row.tx_hash != null ? String(row.tx_hash) : undefined);
            const lovelace = Array.isArray(row) ? row[3] : row.lovelace;
            consumed += BigInt(String(lovelace ?? 0));
            await insertUtxoDelta(db, blockHash, "spend", packUtxoDelta({ utxo_ref, tx_out, tx_hash }));
        }
        await db`DELETE FROM utxo WHERE utxo_ref IN ${db(refs)}`;
    }
    const ret: any = body.collateralReturn;
    let returned = 0n;
    if (ret) {
        const idx = (body.outputs ?? []).length;
        const utxoRef = `${txId}:${idx}`;
        const address = addressToString(ret.address);
        const assetsObj: Record<string, Record<string, string>> = {};
        for (const ma of (Array.isArray(ret.value?.map) ? ret.value.map : []) as any[]) {
            const policyStr = String(ma.policy?.toString?.() ?? "");
            if (!policyStr) continue;
            const a: Record<string, string> = {};
            for (const asset of (ma.assets ?? []) as any[]) a[toHex(asset.name)] = String(asset.quantity);
            assetsObj[policyStr] = a;
        }
        const lovelace = ret.value?.lovelaces ?? 0n;
        returned = BigInt(lovelace);
        const json = JSON.stringify({ address, amount: String(lovelace), assets: assetsObj, collateral_return: true });
        await upsertUtxoRow(db, utxoRef, json, txId, txOutColumns({ address, amount: String(lovelace) }));
        await insertUtxoDelta(db, blockHash, "create", packUtxoDelta({ utxo_ref: utxoRef, tx_out: json, tx_hash: txId }));
    }
    const toPot = body.totCollateral != null ? BigInt(body.totCollateral) : consumed - returned;
    try {
        if (toPot > 0n) await addFeeToPot(db, toPot);
    } catch { /* pots not initialised */ }
    void indexCtx;
}

/** `[credential hash bytes, amount]` for every withdrawal of a body (any withdrawals shape: array, `{ map }`, or entries with `rewardAccount` / `stakeCred`). */
export function withdrawalEntries(withdrawals: any): Array<{ stakeCred: Uint8Array; amount: bigint }> {
    const list: any[] = Array.isArray(withdrawals) ? withdrawals : Array.isArray(withdrawals?.map) ? withdrawals.map : [];
    const out: Array<{ stakeCred: Uint8Array; amount: bigint }> = [];
    for (const w of list) {
        const acc = w?.rewardAccount ?? w?.stakeAddress ?? w?.stakeCred;
        const cred = acc?.credentials?.hash ?? acc?.credentials ?? acc?.hash ?? acc;
        let bytes: Uint8Array | null = null;
        if (cred instanceof Uint8Array) bytes = cred;
        else if (typeof cred?.toBuffer === "function") bytes = cred.toBuffer();
        else if (typeof cred?.toString === "function" && /^[0-9a-f]{56}$/i.test(String(cred))) bytes = Buffer.from(String(cred), "hex");
        if (!bytes) continue;
        // Reward accounts are (type, hash): keep the type (typed bytes, see db/stakeCred.ts).
        // A ledger-ts StakeAddress carries the type on itself (`type: "script"`), not on its
        // `credentials` (a bare hash): reading the hash alone typed every script account as a
        // key account, so its withdrawals debited a row that did not exist while the script
        // account's balance grew forever, inflating its pool's stake and rewards (preview
        // treasury drift of ~150 ppm per epoch, PLAN_LEDGER_INTEGRITY.md B).
        let type = acc?.type === "script" || acc?.type === 1 ? 1
            : acc?.credentials != null ? credTypeOf(acc.credentials) : credTypeOf(acc);
        if (bytes.length === 29) {
            if (headerStakeIsScript(bytes[0]!)) type = 1; // a whole stake address: its header carries the type
            bytes = bytes.subarray(1);
        }
        if (bytes.length !== 28) continue;
        out.push({ stakeCred: typedCredBytes(type, new Uint8Array(bytes)), amount: BigInt(w?.amount ?? 0) });
    }
    return out;
}

export async function applyWithdrawals(
    withdrawals: any,
    blockHash: Uint8Array,
    client?: SqlClient,
): Promise<void> {
    const db = client ?? sql;
    for (const { stakeCred, amount } of withdrawalEntries(withdrawals)) {
        await db`UPDATE rewards SET amount = amount - ${amount.toString()} WHERE stake_credentials = ${stakeCred}`;
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
    // `blocks.hash` is stored as lowercase hex text while `utxo_deltas.block_hash` is the
    // raw 32-byte blob: match the deltas through hex(), never by direct comparison (the
    // direct join matched nothing, so rollbacks left every spent input missing and every
    // created output in place — mainnet slot 5753400).
    const goneHashes = ((await sql`SELECT hash FROM blocks WHERE slot > ${slot}`.values()) as unknown[][])
        .map((r) => String(r[0]).toLowerCase());

    {
        // The epoch boundary's reward update, snapshot and parameter derivation are not
        // journaled: a rollback across a boundary cannot be undone exactly. cardano-node bounds
        // rollbacks by k, so this is rare; refuse rather than leave the ledger half-reverted.
        const tipBefore = await getMaxSlot();
        if (tipBefore > slot && epochForSlot(tipBefore) !== epochForSlot(slot)) {
            throw new Error(`rollback from slot ${tipBefore} (epoch ${epochForSlot(tipBefore)}) to slot ${slot} (epoch ${epochForSlot(slot)}) crosses an epoch boundary; the boundary state is not journaled — resync from a snapshot before epoch ${epochForSlot(slot) + 1n} is required`);
        }
    }    // Only the deltas of the gone blocks, through the block_hash index; the previous
    // `lower(hex(block_hash)) IN (…)` form scanned the whole table (minutes on a
    // 60 GB DB) — and a no-op rollback (nothing above `slot`) must not scan at all.
    counts.deltasDeleted = 0;
    for (const h of goneHashes) {
        counts.deltasDeleted += await countQuery(
            sql`SELECT COUNT(*) as c FROM utxo_deltas WHERE block_hash = ${Buffer.from(h, "hex")} OR block_hash = ${h}`,
        );
    }

    logger.rollback(
        `Pre-rollback to slot ${slot}: blocksDeleted=${counts.blocksDeleted}, headersDeleted=${counts.headersDeleted}, deltasDeleted=${counts.deltasDeleted}`,
    );

    const beforeTip = await getMaxSlot();

    // Capture deltas before delete — newest first so reverse order is natural
    const deltaRows: any[] = [];
    for (const h of goneHashes) {
        const rows = (await sql`
            SELECT d.action, d.utxo, d.id, b.slot
            FROM utxo_deltas d
            INNER JOIN blocks b ON b.hash = ${h}
            WHERE d.block_hash = ${Buffer.from(h, "hex")} OR d.block_hash = ${h}
        `.values()) as unknown[][];
        for (const r of rows) deltaRows.push(r);
    }
    // newest first so the reverse order is natural
    deltaRows.sort((a, b) => Number(b[3]) - Number(a[3]) || Number(b[2]) - Number(a[2]));

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
    // upsertUtxoRow only queues (batched apply path): write the restored outputs now.
    // Without this the 2026-09-05 preview rollback "restored" 30 outputs that never
    // reached the table and the re-applied block halted on missing inputs.
    await flushPendingUtxoWrites(sql);

    await sql.begin(async (tx) => {
        // MiniBF projections first (same txn as ledger deletes)
        if (explorerIndexer.active) explorerIndexer.rollback(Number(slot));
        else await rollbackMbToSlot(tx as any, Number(slot));
        // Certificates, pots and governance written by the gone blocks (bug 63: without this a
        // re-apply halted on "already registered").
        const journal = await undoLedgerJournal(tx as any, goneHashes.map((h) => Buffer.from(h, "hex")));
        if (journal.rows) logger.rollback(`Ledger journal undone for ${goneHashes.length} block(s): ${journal.deleted} insert(s) removed, ${journal.updated} update(s) reverted, ${journal.inserted} delete(s) restored`);
        for (const h of goneHashes) await tx`DELETE FROM utxo_deltas WHERE block_hash = ${Buffer.from(h, "hex")} OR block_hash = ${h}`;
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
        const res = (await sql`
            INSERT OR IGNORE INTO utxo (utxo_ref, tx_out, tx_hash, address, lovelace)
            VALUES (${r.utxoRef}, ${txOut}, ${r.txId}, ${r.address}, ${r.lovelace.toString()})
            RETURNING utxo_ref
        `.values()) as unknown[][];
        inserted += res.length; // RETURNING: the driver's change count includes trigger writes
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
        const mb = mbSql();
        const spentRows = await mb`
            SELECT prev_tx_hash FROM mb_tx_in WHERE prev_output_index = 0 AND prev_tx_hash IN ${mb(txIds)}
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

/**
 * Status endpoints poll every second; a COUNT(*) over 2.9 M UTxOs (100 ms) and the
 * genesis-UTxO join (215 ms) run on the main thread and cost the applier a third of its
 * time (SQL profile 2026-09-06). Serve them from a 30 s cache instead.
 */
const statsCache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = statsCache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = compute().catch((err) => { statsCache.delete(key); throw err; });
    statsCache.set(key, { at: now, value });
    return value;
}
export function getUtxoCountCached(ttlMs = 30_000): Promise<number> {
    return cached("utxoCount", ttlMs, getUtxoCount);
}
export function getGenesisUtxoStatsCached(ttlMs = 60_000): Promise<{ total: number; unspent: number; avvm: number }> {
    return cached("genesisUtxoStats", ttlMs, getGenesisUtxoStats);
}

/** True when a block with this header hash is applied (volatile or immutable). Fetches no blob. */
export async function blockExists(hash: string): Promise<boolean> {
    const hex = hash.toLowerCase();
    const blob = /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
    const rows = (await sql`SELECT 1 FROM blocks WHERE hash = ${hex} OR hash = ${blob}
        UNION ALL SELECT 1 FROM immutable_blocks WHERE block_hash = ${hex} OR block_hash = ${blob} LIMIT 1`.values()) as unknown[][];
    return rows.length > 0;
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
/** Rows in an append-only table: MAX(rowid) (exact until a rollback deletes rows; never a table walk). */
export async function approxRowCount(table: string): Promise<number> {
    try {
        const rows = (await sql.unsafe(`SELECT MAX(rowid) AS c FROM ${table}`).values()) as unknown[][];
        return Number(rows?.[0]?.[0] ?? 0) || 0;
    } catch {
        return 0;
    }
}

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
    // Index tables are append-only apart from rollbacks, so MAX(rowid) is their size to
    // within a few rows and costs one index probe; COUNT(*) walked 17 M rows (a minute on
    // a cold cache, blocking the applier).
    const txIndexCount = await approxRowCount("tx_index");
    const addressTxCount = await approxRowCount("address_tx");

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
    /** When given, the transaction is also written to the MiniBF forward index (tx_index, block_tx, address_tx, mb_*). */
    indexCtx?: { slot: number; txIndex: number; blockHeight?: number | null },
): Promise<void> {
    const db = client ?? sql;
    const mbInputs: MbTxIn[] = [];
    const mbOutputs: MbTxOut[] = [];
    const addrDirs = new Map<string, "in" | "out" | "both">();
    let sumIn = 0n, sumOut = 0n, inputsResolved = 0;
    await flushPendingUtxoWrites(db); // earlier payloads' outputs must be visible to this one's input lookups
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
        // ByronTx.hash is a method (Hash32 of the tx CBOR); Shelley-style bodies have a getter.
        const h = typeof tx.hash === "function" ? tx.hash() : tx.hash;
        if (typeof h?.toString === "function" && /^[0-9a-f]{64}$/i.test(String(h.toString()))) {
            txId = String(h.toString()).toLowerCase();
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
                mbInputs.push({ inputIndex: mbInputs.length, prevTxHash: String(id).toLowerCase(), prevOutputIndex: Number(index) });
            }
        } catch {
            /* skip bad input */
        }
    }

    if (inputRefs.length > 0) {
        const existingUtxos = await db`
            SELECT utxo_ref, tx_out, tx_hash, address FROM utxo WHERE utxo_ref IN ${db(inputRefs)}
        ` as any[];
        assertInputsPresent(inputRefs, existingUtxos, txId);
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
            // index: the spent output's address and value (Byron fee = inputs − outputs)
            try {
                const spentJson = JSON.parse(tx_out);
                const spentAddr = String((Array.isArray(row) ? row[3] : row.address) ?? spentJson.address ?? "");
                if (spentAddr.length > 8) addrDirs.set(spentAddr, addrDirs.get(spentAddr) === "in" ? "both" : "out");
                if (spentJson.amount != null) { sumIn += BigInt(String(spentJson.amount)); inputsResolved++; }
            } catch { /* index only */ }
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
            address = addressToString(out?.address ?? out?.addr);
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
        mbOutputs.push({ outputIndex: i, address, lovelace: amount });
        if (address.length > 8) addrDirs.set(address, addrDirs.get(address) === "out" ? "both" : "in");
        try { sumOut += BigInt(amount); } catch { /* index only */ }
    }
    // MiniBF forward index for Byron transactions (was Shelley-only: Byron blocks showed 0 txs
    // in the explorer and /txs/{hash} could not find them).
    if (indexCtx && Number.isFinite(indexCtx.slot) && !applySkipIndex() && /^[0-9a-f]{64}$/i.test(txId)) {
        let size: number | null = null;
        try { if (typeof tx.toCborBytes === "function") size = tx.toCborBytes().length; } catch { /* */ }
        const fee = inputsResolved === inputRefs.length && inputRefs.length > 0 && sumIn >= sumOut ? String(sumIn - sumOut) : null;
        await indexTransaction(db, {
            txHash: txId, blockHash, slot: indexCtx.slot, txIndex: indexCtx.txIndex, blockHeight: indexCtx.blockHeight ?? null,
            fee, size, addresses: addrDirs, inputs: mbInputs, outputs: mbOutputs,
        });
    }
    await flushPendingUtxoWrites(db); // Byron payloads are few per block; standalone callers (tests, scripts) expect rows immediately
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

let epochNonceStartColumns: Promise<void> | null = null;
async function ensureEpochNonceStartColumns(): Promise<void> {
    if (!epochNonceStartColumns) {
        epochNonceStartColumns = (async () => {
            // start_slot / start_lab_hex: set by the snapshot importer when the start state is the
            // one at its slot rather than at the epoch's first slot (header replay starts after it).
            for (const [col, type] of [["start_evolving_hex", "TEXT"], ["start_candidate_hex", "TEXT"], ["start_slot", "INTEGER"], ["start_lab_hex", "TEXT"]]) {
                try {
                    await sql.unsafe(`ALTER TABLE epoch_nonces ADD COLUMN ${col} ${type}`);
                } catch {
                    /* exists */
                }
            }
        })();
    }
    await epochNonceStartColumns;
}

/** The evolver state right after TICKN into `epoch` (ηv, ηc at the epoch start), for header replay after a restart or rollback. */
export async function storeEpochNonceStart(epoch: number, etaVHex: string, etaCHex: string): Promise<void> {
    await ensureEpochNonceStartColumns();
    await sql`UPDATE epoch_nonces SET start_evolving_hex = ${etaVHex}, start_candidate_hex = ${etaCHex} WHERE epoch = ${epoch}`;
}

export async function getEpochNonceStart(epoch: number): Promise<{ etaVHex: string; etaCHex: string; startSlot: number | null; labHex: string | null } | null> {
    await ensureEpochNonceStartColumns();
    const rows = (await sql`SELECT start_evolving_hex, start_candidate_hex, start_slot, start_lab_hex FROM epoch_nonces WHERE epoch = ${epoch}`.values()) as unknown[][];
    if (!rows.length || rows[0]![0] == null || rows[0]![1] == null) return null;
    return { etaVHex: String(rows[0]![0]), etaCHex: String(rows[0]![1]), startSlot: rows[0]![2] == null ? null : Number(rows[0]![2]), labHex: rows[0]![3] == null ? null : String(rows[0]![3]) };
}

/** Stored blocks with `from <= slot <= to`, ascending, in chunks (header replay). */
export async function* storedBlocksInSlotRange(from: number, to: number, chunk = 2000): AsyncGenerator<{ slot: number; block_data: Uint8Array }> {
    let cursor = from - 1;
    for (;;) {
        const rows = (await sql`SELECT slot, block_data FROM blocks WHERE slot > ${cursor} AND slot <= ${to} AND is_valid = TRUE ORDER BY slot LIMIT ${chunk}`.values()) as unknown[][];
        if (!rows.length) return;
        for (const r of rows) {
            cursor = Number(r[0]);
            yield { slot: cursor, block_data: new Uint8Array(r[1] as Buffer) };
        }
        if (rows.length < chunk) return;
    }
}
