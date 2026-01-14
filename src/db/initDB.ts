import fs from 'fs';
import { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.js';
import { getBasePath } from '../utils/paths.js';
import type { GerolamoConfig } from "../network/peerManagerWorkers/peerManagerWorker";

export async function initDB(config: GerolamoConfig): Promise<void> {
    const DB_PATH = config.dbPath;
    logger.log(`Database path: ${DB_PATH}`);
    const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'));
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(DB_PATH, { create: true });
    const schemaFile = Bun.file(`${getBasePath()}/db/schemas.sql`);
    const schema = await schemaFile.text();
    logger.info("Initializing Database...");
    db.run(schema);
    // Enable WAL mode for concurrent reads/writes (fixes "database is locked" in multi-worker setup)
    db.run(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA wal_autocheckpoint = 100;
        PRAGMA busy_timeout = 5000;
        PRAGMA cache_size = 10000;
        PRAGMA temp_store = MEMORY;
    `);
    logger.info("DB initialized with WAL mode for concurrency");
};