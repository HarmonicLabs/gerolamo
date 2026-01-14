import { Database } from 'bun:sqlite';

const dbs: Map<string, Database> = new Map();
const pragmasRun: Map<string, boolean> = new Map();

export function getDB(dbPath: string): Database {
	if (!dbs.has(dbPath)) {
		const db = new Database(dbPath, { create: true });
		dbs.set(dbPath, db);
	}
	const db = dbs.get(dbPath)!;
	if (!pragmasRun.has(dbPath)) {
		db.run(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA wal_autocheckpoint = 100;
			PRAGMA busy_timeout = 5000;
			PRAGMA cache_size = 10000;
			PRAGMA temp_store = MEMORY;
		`);
		pragmasRun.set(dbPath, true);
	}
	return db;
}