import { Database } from 'bun:sqlite';

export function getDB(dbPath: string): Database {
  return new Database(dbPath);
}