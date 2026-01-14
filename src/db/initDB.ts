import { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.js';

export async function initDB(): Promise<void> {
    const db = new Database('./src/db/chain/Gerolamo.db', { create: true });
    const schemaFile = Bun.file('./src/db/schemas.sql');
    const schema = await schemaFile.text();
    logger.info("Innitilizaing Database... ");
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