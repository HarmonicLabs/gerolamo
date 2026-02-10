import { IndexedDBSchema } from './Gerolamo_Indexeddb_Schema';
import { logger } from '../utils/logger';

// Serialization utils
function serializeValue(value: any): any {
	if (typeof value === 'bigint') return { __bigint__: value.toString() };
	if (value instanceof Uint8Array) return Array.from(value); // Array for IDB
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

// For keys: slot bigint → slot.toString(), hash string ok, stake_creds U8A → hex or base64
function keyToString(key: string | bigint | Uint8Array): string {
	if (typeof key === 'bigint') return key.toString();
	if (key instanceof Uint8Array) return Buffer.from(key).toString('hex');
	return key as string;
}

function keyFromString(
	keyStr: string,
	type: 'slot' | 'hash' | 'stake'
): string | bigint | Uint8Array {
	// reverse based on type
	if (type === 'slot') return BigInt(keyStr);
	if (type === 'hash') return keyStr; // hex str
	// etc
	return keyStr;
}

export class DB {
	private dbName = 'Gerolamo';
	private version = 1;
	private _db: IDBDatabase | null = null;

	constructor(private readonly dbPath?: string) {} // dbPath ignored for IDB

	get db(): IDBDatabase {
		if (!this._db) throw new Error('DB not initialized');
		return this._db;
	}

	async ensureInitialized(): Promise<void> {
		logger.info('Initializing IndexedDB Gerolamo');
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(this.dbName, this.version);
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				this._db = req.result;
				logger.info('IndexedDB ready');
				resolve(undefined);
			};
			req.onupgradeneeded = (ev) => {
				const target = ev.target as IDBOpenDBRequest;
				const upgradeDb = target.result;
				upgradeDb.onerror = () => reject(target.error);

				IndexedDBSchema.forEach(({ name, keyPath, autoIncrement, indexes }) => {
					if (upgradeDb.objectStoreNames.contains(name))
						upgradeDb.deleteObjectStore(name);
					const store = upgradeDb.createObjectStore(name, { keyPath, autoIncrement });

					indexes.forEach(({ name: idxName, keyPath: idxPath, unique, multiEntry }) => {
						store.createIndex(idxName, idxPath, { unique, multiEntry });
					});
				});
			};
		});
	}

	// Stub for ported methods - implement similarly
	async getBlockByHash(hash: string): Promise<any> {
		// txn = db.transaction(['blocks', 'immutable_blocks'], 'readonly')
		// get from blocks, if not immutable_blocks
		// deserialize
		return null;
	}

	// ... port all other methods async, using txn.get/put/delete/index.getAll etc.
	// e.g. async insertHeaderBatchVolatile(records: HeaderInsertData[]): Promise<void> {
	//   const txn = db.transaction('volatile_headers', 'readwrite');
	//   const store = txn.objectStore('volatile_headers');
	//   for (const r of records) {
	//     store.put(serializeValue({ slot: r.slot, header_hash: r.headerHash, rollforward_header_cbor: r.rollforward_header_cbor }));
	//   }
	//   await txn.done;
	// }

	// Full impl follows plan: handle batches with loops, indexes updates manual (put to index stores if separate, but IDB indexes auto)
	// Note: IDB indexes auto-maintained on put/delete
	// For compact/rollback: cursor delete + copy to immutable
	// For applyTransaction: multi-store txn 'readwrite', update utxo/stake etc.

	private logDbError(operation: string, err: unknown): void {
		logger.error(`IndexedDB ${operation} failed:`, err);
	}
}
