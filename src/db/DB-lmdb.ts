import { open } from 'lmdb';
import { LMDBSchema } from './Gerolamo_LMDB_Schema';
import { logger } from '../utils/logger'; // assume

function serializeValue(value: any): any {
	if (typeof value === 'bigint') return { __bigint__: value.toString() };
	if (value instanceof Uint8Array) return Array.from(value);
	if (Array.isArray(value)) return value.map(serializeValue);
	if (value && typeof value === 'object') {
		const obj: any = {};
		for (const [k, v] of Object.entries(value)) {
			obj[k] = serializeValue(v);
		}
		return obj;
	}
	return value;
}

function deserializeValue(value: any): any {
	if (value?.__bigint__) return BigInt(value.__bigint__);
	if (Array.isArray(value) && value.every((v: any) => typeof v === 'number'))
		return new Uint8Array(value);
	if (Array.isArray(value)) return value.map(deserializeValue);
	if (value && typeof value === 'object') {
		const obj: any = {};
		for (const [k, v] of Object.entries(value)) {
			obj[k] = deserializeValue(v);
		}
		return obj;
	}
	return value;
}

function keyToString(key: string | bigint | Uint8Array): string {
	if (typeof key === 'bigint') return key.toString();
	if (key instanceof Uint8Array) return Buffer.from(key).toString('hex');
	return key as string;
}

export class DB {
	private env: any; // LMDB Env
	private dbis: Record<string, any> = {}; // openDB cache

	constructor(private readonly dbPath: string) {}

	get db() {
		return this.env;
	}

	async ensureInitialized(): Promise<void> {
		logger.info(`Initializing LMDB at ${this.dbPath}`);
		const fs = await import('fs/promises');
		const pathMod = await import('path');
		await fs.mkdir(pathMod.dirname(this.dbPath), { recursive: true });
		this.env = open({
			path: this.dbPath,
			mapSize: 1e9, // 1GB, adjust for chain data
		});
		// Open all DBIs
		for (const [name, config] of Object.entries(LMDBSchema)) {
			this.dbis[name] = this.env.openDB({
				name: config.name,
				create: true,
				keyType: config.keyType === 'binary' ? 0x12 : 0x73, // uint32/binary/string codes
				encoding: 'json',
			});
		}
		logger.info('LMDB ready');
	}

	// Example port
	async getBlockByHash(hash: string): Promise<any> {
		const hashKey = hash;
		let block = this.dbis.blocks?.get(hashKey);
		if (block) return deserializeValue(block);

		block = this.dbis.immutable_blocks_by_hash?.get(hashKey);
		if (block) {
			const slotStr = deserializeValue(block);
			return deserializeValue(this.dbis.immutable_blocks?.get(keyToString(slotStr)));
		}
		return null;
	}

	async insertHeaderBatchVolatile(
		records: Array<{ slot: bigint; headerHash: string; rollforward_header_cbor: Uint8Array }>
	): Promise<void> {
		const txn = this.env.beginTxn();
		try {
			for (const r of records) {
				const slotKey = keyToString(r.slot);
				const value = serializeValue({
					header_hash: r.headerHash,
					rollforward_header_cbor: r.rollforward_header_cbor,
				});
				this.dbis.volatile_headers.put(txn, slotKey, value);
				this.dbis.volatile_headers_by_hash.put(txn, r.headerHash, slotKey);
			}
			txn.commit();
		} catch (err) {
			txn.abort();
			throw err;
		}
	}

	// ... similar for other methods: txn for batches/atomicity
	// compact: txn read valid old blocks/headers via cursor/range, create chunk, put immutable, delete volatile
	// applyTransaction: txn update utxo/stake etc stores
	// Scans: dbi.getRange({start, end}).values for getAllStake etc.

	private logDbError(operation: string, err: unknown): void {
		logger.error(`LMDB ${operation} failed:`, err);
	}

	async close() {
		this.env.close();
	}
}
