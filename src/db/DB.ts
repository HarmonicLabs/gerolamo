import { Database } from 'bun:sqlite';
import fs from 'fs';
import { logger } from '../utils/logger';
import { getBasePath } from '../utils/paths';

interface HeaderInsertData {
	slot: bigint;
	headerHash: string;
	rollforward_header_cbor: Uint8Array;
};

interface BlockInsertData {
	slot: bigint;
	blockHash: string;
	prevHash: string;
	headerData: Uint8Array;
	blockData: Uint8Array;
	block_fetch_RawCbor: Uint8Array;
};

interface ImmutableChunk {
	chunk_no: number;
	tip_hash: string;
	tip_slot_no: bigint;
	slot_range_start: bigint;
	slot_range_end: bigint;
};

export class DB {
	private _db: Database | undefined;
	constructor(private readonly dbPath: string) 
	{

	}
	get db(): Database {
		if (!this._db) {
		this._db = new Database(this.dbPath);
		}
		return this._db;
	};

	async ensureInitialized(): Promise<void> {
		logger.log(`Database path: ${this.dbPath}`);
		const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
		fs.mkdirSync(dir, { recursive: true });
		const schemaFile = Bun.file(`${getBasePath()}/db/hari_schema.sql`);
		const schema = await schemaFile.text();
		logger.info("Initializing Database...");
		try {
			this.db.run(schema);
		} catch (err) {
			logger.error("Failed to initialize database schema:", err);
			throw err;
		}
		logger.info("DB initialized with WAL mode for concurrency");
	};

	getBlockByHash(hash: string): any {
		const stmt = this.db.prepare(`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE hash = ?
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE block_hash = ?
		`);
		return stmt.get(hash, hash);
	};

	getBlockBySlot(slot: bigint): any {
		const stmt = this.db.prepare(`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE slot = ?
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE slot = ?
		`);
		return stmt.get(slot, slot);
	};

	getTransactionByTxId(txid: string): any {
		const stmt = this.db.prepare('SELECT * FROM transactions WHERE txid = ?');
		return stmt.get(txid);
	};

	getBlocksInEpoch(epoch: number): any[] {
		const stmt = this.db.prepare(`
			SELECT * FROM volatile_blocks vb
			INNER JOIN transactions t ON vb.block_hash = t.block_hash
			WHERE t.epoch = ?
			UNION
			SELECT * FROM immutable_blocks ib
			INNER JOIN transactions t ON ib.block_hash = t.block_hash
			WHERE t.epoch = ?
		`);
		return stmt.all(epoch, epoch);
	};

	async getMaxSlot(): Promise<bigint> {
		const stmt = this.db.prepare('SELECT MAX(slot) as max_slot FROM blocks');
		const row = stmt.get() as { max_slot: number | null } | undefined;
		return BigInt(row?.max_slot ?? 0);
	};

	async getValidHeadersBefore(cutoffSlot: bigint): Promise<any[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM volatile_headers
			WHERE slot < ? AND is_valid = TRUE
			ORDER BY slot ASC
		`);
		const rows = stmt.all(cutoffSlot);
		return rows;
	};

	async getValidBlocksBefore(cutoffSlot: bigint): Promise<any[]> {
		const stmt = this.db.prepare(`
		SELECT * FROM blocks
		WHERE slot < ? AND is_valid = TRUE
		ORDER BY slot ASC
		`);
		const rows = stmt.all(cutoffSlot);
		return rows;
	};

	async getNextChunk(): Promise<{ next_chunk: number }> {
		const stmt = this.db.prepare('SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks');
		const row = stmt.get() as { next_chunk: number };
		return row;
	};

	getLedgerSnapshot(snapshotNo: number): any {
		const stmt = this.db.prepare('SELECT * FROM ledger_snapshots WHERE snapshot_no = ?');
		return stmt.get(snapshotNo);
	};

	async insertHeaderBatchVolatile(records: Array<HeaderInsertData>): Promise<void> {
		if (records.length === 0) return;

		// Pre-check for dups in batch (debug only; Map prevents)
		const hashes = new Set(records.map(r => r.headerHash));
		if (hashes.size !== records.length) {
			logger.warn(`Batch has ${records.length - hashes.size} duplicate hashes!`);
		};

		const tx = this.db.transaction(() => {
			const stmt = this.db.prepare(`
				INSERT OR IGNORE INTO volatile_headers 
				(slot, header_hash, rollforward_header_cbor)
				VALUES (?, ?, ?)
			`);
			for (const record of records) {
				stmt.run(
					record.slot,
					record.headerHash,
					record.rollforward_header_cbor
				);
			};
		});
		try {
			tx();
		} catch (err) {
			logger.error("Failed to insert header batch:", err);
			throw err;
		}
		logger.debug(`Inserted ${records.length} volatile headers (ignored dups)`);
	};

	insertBlockVolatile(block: BlockInsertData): void {
		const stmt = this.db.prepare(`
			INSERT INTO volatile_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(block_hash) DO UPDATE SET
				slot = excluded.slot,
				prev_hash = excluded.prev_hash,
				header_data = excluded.header_data,
				block_data = excluded.block_data,
				block_fetch_RawCbor = excluded.block_fetch_RawCbor
		`);
		try {
			stmt.run(
				block.slot,
				block.blockHash,
				block.prevHash,
				block.headerData,
				block.blockData,
				block.block_fetch_RawCbor
			);
		} catch (err) {
			logger.error("Failed to insert volatile block:", err);
			throw err;
		}
	};

	async insertBlockBatchVolatile(records: Array<{
		slot: bigint;
		blockHash: string;
		prevHash: string;
		headerData: Uint8Array;
		blockData: Uint8Array;
		block_fetch_RawCbor: Uint8Array;
	}>): Promise<void> 
	{
		if (records.length === 0) return;

		// Pre-check for dups in batch (debug only; Map prevents)
		const hashes = new Set(records.map(r => r.blockHash));
		if (hashes.size !== records.length) {
			logger.warn(`Batch has ${records.length - hashes.size} duplicate hashes!`);
		};

		const tx = this.db.transaction(() => {
			const stmt = this.db.prepare(`
				INSERT OR IGNORE INTO blocks 
				(hash, slot, header_data, block_data, block_fetch_RawCbor, is_valid, prev_hash)
				VALUES (?, ?, ?, ?, ?, TRUE, ?)
			`);
			for (const record of records) {
				stmt.run(
					record.blockHash,
					Number(record.slot),
					record.headerData,
					record.blockData,
					record.block_fetch_RawCbor,
					record.prevHash
				);
			}
		});
		try {
			tx();
		} catch (err) {
			logger.error("Failed to insert block batch:", err);
			throw err;
		}
		logger.debug(`Inserted ${records.length} volatile blocks (ignored dups)`);
	};

	insertChunk(chunk: { chunk_no: number; tip_hash: string; tip_slot_no: bigint; slot_range_start: bigint; slot_range_end: bigint; }): number {
		const stmt = this.db.prepare(`
			INSERT INTO immutable_chunks (chunk_no, tip_hash, tip_slot_no, slot_range_start, slot_range_end)
			VALUES (?, ?, ?, ?, ?)
			RETURNING chunk_id
		`);
		try {
			const result = stmt.get(
				chunk.chunk_no,
				chunk.tip_hash,
				chunk.tip_slot_no,
				chunk.slot_range_start,
				chunk.slot_range_end
			) as { chunk_id: number };
			return result.chunk_id;
		} catch (err) {
			logger.error("Failed to insert chunk:", err);
			throw err;
		}
	};

	insertImmutableBlocks(blocks: any[], chunk_id: number): void {
		const stmt = this.db.prepare(`
			INSERT INTO immutable_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor, rollforward_header_cbor, chunk_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT DO NOTHING
		`);
		try {
			for (const block of blocks) {
				stmt.run(block.slot, block.hash, block.prev_hash, block.header_data, block.block_data, block.block_fetch_RawCbor, block.rollforward_header_cbor, chunk_id);
			};
		} catch (err) {
			logger.error("Failed to insert immutable blocks:", err);
			throw err;
		}
	};

	deleteVolatileBlocks(blockHashes: string[]): void {
		const stmt = this.db.prepare(`
			DELETE FROM blocks
			WHERE hash = ?;
		`);
		try {
			for (const hash of blockHashes) {
				stmt.run(hash);
			};
		} catch (err) {
			logger.error("Failed to delete volatile blocks:", err);
			throw err;
		}
	};

	deleteVolatileHeaders(headerHashes: string[]): void {
		const stmt = this.db.prepare(`
			DELETE FROM volatile_headers
			WHERE header_hash = ?;
		`);
		try {
			for (const hash of headerHashes) {
				stmt.run(hash);
			};
		} catch (err) {
			logger.error("Failed to delete volatile headers:", err);
			throw err;
		}
	};

	async createChunk(oldBlocks: any[]): Promise<ImmutableChunk> {
		if (oldBlocks.length === 0) throw new Error('No blocks to chunk');

		// Assume oldBlocks sorted by slot ASC
		const firstBlock = oldBlocks[0];
		const lastBlock = oldBlocks[oldBlocks.length - 1];

		// Get next chunk_no
		const nextChunk = await this.getNextChunk();
		const chunk_no = nextChunk.next_chunk;

		return {
			chunk_no,
			tip_hash: lastBlock.hash,
			tip_slot_no: lastBlock.slot,
			slot_range_start: firstBlock.slot,
			slot_range_end: lastBlock.slot
		};
	};

	async compact(): Promise<void> {
		const cutoff = (await this.getMaxSlot()) - 2160n;
		const oldBlocks = await this.getValidBlocksBefore(cutoff);
		const oldHeaders = await this.getValidHeadersBefore(cutoff);

		if (oldBlocks.length === 0) return;  // Chunk only if blocks; headers follow

		// Map headers by hash for denorm to blocks (1:1, header_hash == block_hash)
		const headerMap = new Map(oldHeaders.map((h: any) => [h.header_hash, h.rollforward_header_cbor]));
		for (const block of oldBlocks) {
			block.rollforward_header_cbor = headerMap.get(block.hash) ?? new Uint8Array(0);
		}

		const chunk = await this.createChunk(oldBlocks);
		let chunk_id: number;
		try {
			chunk_id = this.insertChunk(chunk);
		} catch (err) {
			logger.error("Failed to insert chunk:", err);
			throw err;
		}
		try {
			this.insertImmutableBlocks(oldBlocks, chunk_id);
		} catch (err) {
			logger.error("Failed to insert immutable blocks:", err);
			throw err;
		}
		try {
			this.deleteVolatileBlocks(oldBlocks.map((b: any) => b.hash));
		} catch (err) {
			logger.error("Failed to delete volatile blocks:", err);
			throw err;
		}
		try {
			this.deleteVolatileHeaders(oldHeaders.map((h: any) => h.header_hash));
		} catch (err) {
			logger.error("Failed to delete volatile headers:", err);
			throw err;
		}
		logger.debug(`GC'd ${oldBlocks.length} blocks + ${oldHeaders.length} headers (w/ RawCbor + rollforward_header_cbor) to chunk ${chunk.chunk_no}`);
	};

	async getUtxosByRefs(utxoRefs: string[]): Promise<Array<{ utxo_ref: string; amount: any }>> {
		if (utxoRefs.length === 0) return [];
		const placeholders = utxoRefs.map(() => '?').join(',');
		const stmt = this.db.prepare(`
			SELECT utxo_ref, json_extract(tx_out, '$.amount') as amount 
			FROM utxo 
			WHERE utxo_ref IN (${placeholders})
		`);
		return stmt.all(...utxoRefs) as Array<{ utxo_ref: string; amount: any }>;
	};

	async getAllStake(): Promise<Array<{ stake_credentials: Uint8Array; amount: number }>> {
		const stmt = this.db.prepare(`SELECT stake_credentials, amount FROM stake`);
		return stmt.all() as Array<{ stake_credentials: Uint8Array; amount: number }>;
	};

	async getAllDelegations(): Promise<Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>> {
		const stmt = this.db.prepare(`SELECT stake_credentials, pool_key_hash FROM delegations`);
		return stmt.all() as Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>;
	};
};