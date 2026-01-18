import { Database } from 'bun:sqlite';
import fs from 'fs';
import { logger } from '../utils/logger';
import { getBasePath } from '../utils/paths';
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";

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

interface BlockQueryRow {
	slot: number | bigint;
	block_hash: string;
	prev_hash?: string;
	header_data: Uint8Array;
	block_data: Uint8Array;
	rollforward_header_cbor?: Uint8Array;
	block_fetch_RawCbor: Uint8Array;
	is_valid?: boolean;
	inserted_at?: string;
	chunk_id?: number;
}

interface VolatileHeaderRow {
	slot: bigint;
	header_hash: string;
	rollforward_header_cbor: Uint8Array;
	is_valid: boolean;
}

interface TxRow {
	[key: string]: unknown;
}

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
		logger.debug(`Database path: ${this.dbPath}`);
		const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
		fs.mkdirSync(dir, { recursive: true });
		const schemaFile = Bun.file(`${getBasePath()}/db/Gerolamo_schema.sql`);
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

	getBlockByHash(hash: string): BlockQueryRow | undefined {
		const stmt = this.db.prepare(`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE hash = ?
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE block_hash = ?
		`);
		return stmt.get(hash, hash) as BlockQueryRow | undefined;
	};

	getBlockBySlot(slot: bigint): BlockQueryRow | undefined {
		const stmt = this.db.prepare(`
			SELECT NULL as id, NULL as chunk_id, slot, hash as block_hash, NULL as prev_hash, header_data, block_data, NULL as rollforward_header_cbor, block_fetch_RawCbor, is_valid, inserted_at
			FROM blocks WHERE slot = ?
			UNION
			SELECT NULL as id, chunk_id, slot, block_hash as block_hash, prev_hash, header_data, block_data, rollforward_header_cbor, block_fetch_RawCbor, NULL as is_valid, inserted_at
			FROM immutable_blocks WHERE slot = ?
		`);
		return stmt.get(slot, slot) as BlockQueryRow | undefined;
	};

	getTransactionByTxId(txid: string): TxRow | undefined {
		const stmt = this.db.prepare('SELECT * FROM transactions WHERE txid = ?');
		return stmt.get(txid) as TxRow | undefined;
	};

	getBlocksInEpoch(epoch: number): BlockQueryRow[] {
		const stmt = this.db.prepare(`
			SELECT * FROM volatile_blocks vb
			INNER JOIN transactions t ON vb.block_hash = t.block_hash
			WHERE t.epoch = ?
			UNION
			SELECT * FROM immutable_blocks ib
			INNER JOIN transactions t ON ib.block_hash = t.block_hash
			WHERE t.epoch = ?
		`);
		return stmt.all(epoch, epoch) as BlockQueryRow[];
	};

	getLedgerSnapshot(snapshotNo: number): Record<string, unknown> | undefined {
		const stmt = this.db.prepare('SELECT * FROM ledger_snapshots WHERE snapshot_no = ?');
		return stmt.get(snapshotNo) as Record<string, unknown> | undefined;
	};

	async getMaxSlot(): Promise<bigint> {
		logger.debug("Querying max slot from blocks");
		const stmt = this.db.prepare('SELECT MAX(slot) as max_slot FROM blocks');
		const row = stmt.get() as { max_slot: number | null } | undefined;
		const maxSlot = BigInt(row?.max_slot ?? 0);
		logger.debug("Max slot queried:", maxSlot.toString());
		return maxSlot;
	};

	async getValidHeadersBefore(cutoffSlot: bigint): Promise<VolatileHeaderRow[]> {
		logger.debug(`Querying valid headers before slot ${cutoffSlot}`);
		const stmt = this.db.prepare(`
			SELECT * FROM volatile_headers
			WHERE slot < ? AND is_valid = TRUE
			ORDER BY slot ASC
		`);
		const rows = stmt.all(cutoffSlot) as VolatileHeaderRow[];
		return rows;
	};

	async getValidBlocksBefore(cutoffSlot: bigint): Promise<BlockQueryRow[]> {
		logger.debug(`Querying valid blocks before slot ${cutoffSlot}`);
		const stmt = this.db.prepare(`
		SELECT * FROM blocks
		WHERE slot < ? AND is_valid = TRUE
		ORDER BY slot ASC
		`);
		const rows = stmt.all(cutoffSlot) as BlockQueryRow[];
		return rows;
	};

	async getNextChunk(): Promise<{ next_chunk: number }> {
		const stmt = this.db.prepare('SELECT COALESCE(MAX(chunk_no), 0) + 1 as next_chunk FROM immutable_chunks');
		const row = stmt.get() as { next_chunk: number };
		return row;
	};

	insertHeaderBatchVolatile(records: Array<HeaderInsertData>): Promise<void> {
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
		logger.info(`Committed ${records.length} headers to volatile_headers (ignored dups)`);
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
			this.logDbError("insert volatile block", err);
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
			this.logDbError("insert blocks batch", err);
		}
		logger.info(`Committed ${records.length} blocks to volatile_blocks (ignored dups)`);
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
			) as { chunk_id: number } | undefined;
			if (result === undefined) {
				throw new Error("Insert chunk failed: no chunk_id returned");
			}
			return result.chunk_id;
		} catch (err) {
			this.logDbError("insert chunk", err);
			throw err;
		}
	};

	insertImmutableBlocks(blocks: BlockQueryRow[], chunk_id: number): void {
		const stmt = this.db.prepare(`
			INSERT INTO immutable_blocks (slot, block_hash, prev_hash, header_data, block_data, block_fetch_RawCbor, rollforward_header_cbor, chunk_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT DO NOTHING
		`);
		try {
			for (const block of blocks) {
				stmt.run(
					block.slot, 
					block.block_hash, 
					block.prev_hash ?? '', 
					block.header_data, 
					block.block_data, 
					block.block_fetch_RawCbor, 
					block.rollforward_header_cbor ?? new Uint8Array(0), 
					chunk_id
				);
			};
		} catch (err) {
			this.logDbError("insert immutable_blocks", err);
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
			this.logDbError("delete volatile_blocks", err);
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
			this.logDbError("delete volatile_headers", err);
		}
	};

	async createChunk(oldBlocks: BlockQueryRow[]): Promise<ImmutableChunk> {
		if (oldBlocks.length === 0) throw new Error('No blocks to chunk');

		// Assume oldBlocks sorted by slot ASC
		const firstBlock = oldBlocks[0];
		const lastBlock = oldBlocks[oldBlocks.length - 1];

		// Get next chunk_no
		const nextChunk = await this.getNextChunk();
		const chunk_no = nextChunk.next_chunk;

		return {
			chunk_no,
			tip_hash: lastBlock.block_hash,
			tip_slot_no: BigInt(lastBlock.slot),
			slot_range_start: BigInt(firstBlock.slot),
			slot_range_end: BigInt(lastBlock.slot)
		};
	};

	private logDbError(operation: string, err: unknown): void {
		logger.error(`DB ${operation} failed:`, err);
	}

	async compact(): Promise<void> {
		const cutoff = (await this.getMaxSlot()) - 2160n;
		const oldBlocks = await this.getValidBlocksBefore(cutoff) as BlockQueryRow[];
		const oldHeaders = await this.getValidHeadersBefore(cutoff) as VolatileHeaderRow[];

		if (oldBlocks.length === 0) return;

		const headerMap = new Map(oldHeaders.map((h) => [h.header_hash, h.rollforward_header_cbor]));
		for (const block of oldBlocks) {
			block.rollforward_header_cbor = headerMap.get(block.block_hash) ?? new Uint8Array(0);
		}

		const chunk = await this.createChunk(oldBlocks);
		let chunk_id!: number;
		try {
			chunk_id = this.insertChunk(chunk);
		} catch (err) {
			this.logDbError("insert chunk", err);
			throw err;
		}
		try {
			this.insertImmutableBlocks(oldBlocks, chunk_id);
		} catch (err) {
			this.logDbError("insert immutable_blocks", err);
			throw err;
		}
		try {
			this.deleteVolatileBlocks(oldBlocks.map((b) => b.block_hash));
		} catch (err) {
			this.logDbError("delete volatile_blocks", err);
			throw err;
		}
		try {
			this.deleteVolatileHeaders(oldHeaders.map((h) => h.header_hash));
		} catch (err) {
			this.logDbError("delete volatile_headers", err);
			throw err;
		}
		logger.info(`GC'd ${oldBlocks.length} blocks + ${oldHeaders.length} headers (w/ RawCbor + rollforward_header_cbor) to chunk ${chunk.chunk_no}`);
	};

	async getUtxosByRefs(utxoRefs: string[]): Promise<Array<{ utxo_ref: string; amount: unknown }>> {
		if (utxoRefs.length === 0) return [];
		logger.debug(`Querying ${utxoRefs.length} UTxOs by refs`);
		const placeholders = utxoRefs.map(() => '?').join(',');
		const stmt = this.db.prepare(
			`SELECT utxo_ref, json_extract(tx_out, '$.amount') as amount 
			FROM utxo 
			WHERE utxo_ref IN (${placeholders})`
		);
		const rows = stmt.all(...utxoRefs) as Array<{ utxo_ref: string; amount: unknown }>;
		logger.debug(`Found ${rows.length} UTxOs`);
		return rows;
	}

	async getUtxoByRef(utxoRef: string): Promise<{ utxo_ref: string; tx_out: string } | null> {
		const stmt = this.db.prepare(`SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref = ?`);
		return stmt.get(utxoRef) as { utxo_ref: string; tx_out: string } | null;
	}

	async getAllStake(): Promise<Array<{ stake_credentials: Uint8Array; amount: number }>> {
		logger.debug("Querying all stake");
		const stmt = this.db.prepare(`SELECT stake_credentials, amount FROM stake`);
		return stmt.all() as Array<{ stake_credentials: Uint8Array; amount: number }>;
	}

	async getAllDelegations(): Promise<Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>> {
		logger.debug("Querying all delegations");
		const stmt = this.db.prepare(`SELECT stake_credentials, pool_key_hash FROM delegations`);
		return stmt.all() as Array<{ stake_credentials: Uint8Array; pool_key_hash: Uint8Array }>;
	}

	async applyTransaction(
		txBody: unknown,
		blockHash: Uint8Array,
	): Promise<void> {
		const txBytes = (txBody as { toCborBytes(): Uint8Array }).toCborBytes();
		const txId = toHex(txBytes);

		if (!(txBody as any).inputs || !Array.isArray((txBody as any).inputs)) 
		{
			logger.warn(`Skipping tx ${txId} due to invalid inputs:`, (txBody as any).inputs);
			return;
		}

		const inputRefs = (txBody as { inputs?: unknown[] }).inputs?.map((input: unknown): string =>
			`${(input as { utxoRef: { id: { toString(): string }, index: number } }).utxoRef.id.toString()}:${
				(input as { utxoRef: { id: { toString(): string }, index: number } }).utxoRef.index
			}`
		) || [];

		if (inputRefs.length > 0) {
			const placeholders = inputRefs.map(() => '?').join(',');
			const q = `SELECT utxo_ref, tx_out FROM utxo WHERE utxo_ref IN (${placeholders})`;
			const stmt = this.db.prepare(q);
			const existingUtxos = stmt.all(...inputRefs) as [string, string][];

			const spendStmt = this.db.prepare(
				'INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (?, "spend", ?)'
			);
			for (const [_, tx_out] of existingUtxos) {
				spendStmt.run(blockHash, tx_out);
			}

			const delStmt = this.db.prepare('DELETE FROM utxo WHERE utxo_ref = ?');
			for (const ref of inputRefs) {
				delStmt.run(ref);
			}
		}

		if (!(txBody as any).outputs || !Array.isArray((txBody as any).outputs)) 
		{
			logger.warn(`Skipping tx ${txId} due to invalid outputs:`, (txBody as any).outputs);
			return;
		};

		const outputData: [string, string][] = (txBody as { outputs?: unknown[] }).outputs?.map((output: unknown, i: number) => {
			const utxoRef = `${txId}:${i}`;

			const assetsObj: Record<string, Record<string, string>> = {};
			const multiAssets = Array.isArray((output as any).value?.map) ? (output as any).value.map : [];
			multiAssets.forEach((ma: unknown) => {
				const policyStr = (ma as { policy: { toString(): string } }).policy.toString();
				const assetObj: Record<string, string> = {};
				(Array.isArray((ma as any).assets) ? (ma as any).assets : []).forEach((asset: unknown) => {
					assetObj[toHex((asset as { name: Uint8Array }).name)] = (asset as { quantity: bigint }).quantity.toString();
				});
				assetsObj[policyStr] = assetObj;
			});

			const txOutJson = JSON.stringify({
				address: (output as any).address?.toString() || "",
				amount: (output as any).value?.lovelaces?.toString() || "0",
				assets: assetsObj,
			});
			return [utxoRef, txOutJson];
		}) || [];

		const createStmt = this.db.prepare(
			'INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (?, "create", ?)'
		);
		for (const [_, json] of outputData) {
			createStmt.run(blockHash, json);
		}

		const utxoStmt = this.db.prepare(
			'INSERT OR REPLACE INTO utxo (utxo_ref, tx_out) VALUES (?, ?)'
		);
		for (const [ref, json] of outputData) {
			utxoStmt.run(ref, json);
		}

		if ((txBody as { certs?: unknown[] }).certs && Array.isArray((txBody as any).certs)) {
			await this.applyCertificates((txBody as any).certs, blockHash);
		}
		if ((txBody as { withdrawals?: unknown }).withdrawals && Array.isArray((txBody as any).withdrawals)) {
			await this.applyWithdrawals((txBody as any).withdrawals, blockHash);
		}
		if ((txBody as { fee?: { toString(): string } }).fee) {
			const feeDeltaStmt = this.db.prepare(
				'INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (?, "fee", ?)'
			);
			feeDeltaStmt.run(blockHash, JSON.stringify({ amount: (txBody as any).fee.toString() }));

			const treasuryStmt = this.db.prepare(
				'UPDATE chain_account_state SET treasury = treasury + ? WHERE id = 1'
			);
			treasuryStmt.run((txBody as any).fee);
		}

		// TODO: Handle minting, burning, collateral, etc.
	}

	async applyCertificates(
		certs: unknown[],
		blockHash: Uint8Array,
	): Promise<void> {
		const certDeltaStmt = this.db.prepare(
			'INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (?, "cert", ?)'
		);

		for (const cert of certs as Iterable<unknown>) {
			const certAny = cert as Record<string, unknown>;
			const stakeCred = (certAny.stakeCredential as { hash?: { toBuffer(): Uint8Array }, toBuffer?: () => Uint8Array })?.hash?.toBuffer() ||
				(certAny.stakeCredential as { toBuffer(): Uint8Array })?.toBuffer();

			certDeltaStmt.run(blockHash, JSON.stringify({
				type: certAny.certType,
				stakeCred: stakeCred ? toHex(stakeCred) : null,
				poolId: (certAny.poolKeyHash as { toString(): string })?.toString() ||
					(certAny.poolParams as { operator: { toString(): string } })?.operator?.toString() ||
					(certAny.poolHash as { toString(): string })?.toString(),
			}));
		}

		const stakeRegStmt = this.db.prepare(
			'INSERT OR REPLACE INTO stake (stake_credentials, amount) VALUES (?, 0)'
		);
		const stakeDelStmt = this.db.prepare('DELETE FROM stake WHERE stake_credentials = ?');
		const delegDelStmt = this.db.prepare('DELETE FROM delegations WHERE stake_credentials = ?');
		const delegStmt = this.db.prepare(
			'INSERT OR REPLACE INTO delegations (stake_credentials, pool_key_hash) VALUES (?, ?)'
		);

		await Promise.all((certs as unknown[]).map(async (cert: unknown) => {
			const certAny = cert as Record<string, unknown>;
			const stakeCred = (certAny.stakeCredential as { hash?: { toBuffer(): Uint8Array }, toBuffer?: () => Uint8Array })?.hash?.toBuffer() ||
				(certAny.stakeCredential as { toBuffer(): Uint8Array })?.toBuffer();
			switch ((certAny.certType as number)) {
				case 0: // CertificateType.StakeRegistration
					if (stakeCred) {
						stakeRegStmt.run(stakeCred);
					}
					break;
				case 1: // CertificateType.StakeDeRegistration
					if (stakeCred) {
						stakeDelStmt.run(stakeCred);
						delegDelStmt.run(stakeCred);
					}
					break;
				case 2: // CertificateType.StakeDelegation
					if (stakeCred) {
						const poolId = certAny.poolKeyHash?.toBuffer();
						if (poolId) {
							delegStmt.run(stakeCred, poolId);
						}
					}
					break;
				case 3: // CertificateType.PoolRegistration
					const poolId = certAny.poolParams?.operator?.toBuffer();
					if (poolId) {
						const newPoolJson = JSON.stringify({
							pool_id: toHex(poolId),
							active_stake: "0",
						});
						const poolRegStmt = this.db.prepare(
							'UPDATE pool_distr SET pools = json_insert(pools, "$[#]", json(?)) WHERE id = 1'
						);
						poolRegStmt.run(newPoolJson);
					}
					break;
				case 4: // CertificateType.PoolRetirement
					const retiringPoolId = certAny.poolHash?.toBuffer();
					if (retiringPoolId) {
						const poolRetireQ = `UPDATE pool_distr SET pools = (SELECT json_group_array(json(value)) FROM json_each(pools) WHERE json_extract(value, '$.pool_id') != ?) WHERE id = 1`;
						const poolRetireStmt = this.db.prepare(poolRetireQ);
						poolRetireStmt.run(toHex(retiringPoolId));
					}
					break;
			}
		}));
	}

	async applyWithdrawals(
		withdrawals: unknown,
		blockHash: Uint8Array,
	): Promise<void> {
		const withdrawalData = ((withdrawals as { map?: unknown[] }).map || []).map(({ rewardAccount, amount }: Record<string, unknown>) => ({
			stakeCred: (rewardAccount as { toBuffer(): Uint8Array }).toBuffer(),
			amount: amount as bigint,
		})) || [];
		const rewardUpdateStmt = this.db.prepare(
			'UPDATE rewards SET amount = amount - ? WHERE stake_credentials = ?'
		);
		for (const { stakeCred, amount } of withdrawalData) {
			rewardUpdateStmt.run(amount, stakeCred);
		}
		const withdrawalDeltaStmt = this.db.prepare(
			'INSERT INTO utxo_deltas (block_hash, action, utxo) VALUES (?, "withdrawal", ?)'
		);
		for (const { stakeCred, amount } of withdrawalData) {
			withdrawalDeltaStmt.run(blockHash, JSON.stringify({
				stakeCred: toHex(stakeCred),
				amount: amount.toString(),
			}));
		}
	}
}