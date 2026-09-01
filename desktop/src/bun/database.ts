import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appDbPath } from "./paths";
import type { InstanceConfig } from "../shared/types";

const DDL = `
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  port INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  bun_path TEXT,
  instance_dir TEXT NOT NULL,
  db_path TEXT NOT NULL,
  snapshot_dir TEXT NOT NULL,
  n2c_socket TEXT,
  skip_apply INTEGER NOT NULL DEFAULT 0,
  run_state TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  pid INTEGER,
  bootstrap_pid INTEGER,
  bootstrap_state TEXT NOT NULL DEFAULT 'idle',
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function createInstanceDb(filename = ":memory:"): Database {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DDL);
  return db;
}

let _db: Database | null = null;

export function getAppDb(): Database {
  if (!_db) _db = createInstanceDb(appDbPath());
  return _db;
}

function rowToConfig(row: Record<string, unknown>): InstanceConfig {
  try {
    return JSON.parse(String(row.config_json)) as InstanceConfig;
  } catch {
    return {
      id: String(row.id),
      name: String(row.name),
      network: row.network as InstanceConfig["network"],
      port: Number(row.port) || 3030,
      repoPath: String(row.repo_path),
      bunPath: row.bun_path ? String(row.bun_path) : undefined,
      instanceDir: String(row.instance_dir),
      dbPath: String(row.db_path),
      snapshotDir: String(row.snapshot_dir),
      n2cSocket: row.n2c_socket ? String(row.n2c_socket) : null,
      skipApply: Number(row.skip_apply) === 1,
      runState: (row.run_state as InstanceConfig["runState"]) || "never",
      lastError: row.last_error ? String(row.last_error) : undefined,
      pid: row.pid != null ? Number(row.pid) : null,
      bootstrapPid: row.bootstrap_pid != null ? Number(row.bootstrap_pid) : null,
      bootstrapState: (row.bootstrap_state as InstanceConfig["bootstrapState"]) || "idle",
    };
  }
}

export function saveInstance(db: Database, config: InstanceConfig): string {
  const now = Date.now();
  db.query(
    `INSERT INTO instances (
      id, name, network, port, repo_path, bun_path, instance_dir, db_path, snapshot_dir,
      n2c_socket, skip_apply, run_state, last_error, pid, bootstrap_pid, bootstrap_state,
      config_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, network=excluded.network, port=excluded.port,
      repo_path=excluded.repo_path, bun_path=excluded.bun_path,
      instance_dir=excluded.instance_dir, db_path=excluded.db_path,
      snapshot_dir=excluded.snapshot_dir, n2c_socket=excluded.n2c_socket,
      skip_apply=excluded.skip_apply, run_state=excluded.run_state,
      last_error=excluded.last_error, pid=excluded.pid,
      bootstrap_pid=excluded.bootstrap_pid, bootstrap_state=excluded.bootstrap_state,
      config_json=excluded.config_json, updated_at=excluded.updated_at`,
  ).run(
    config.id,
    config.name,
    config.network,
    config.port,
    config.repoPath,
    config.bunPath ?? null,
    config.instanceDir,
    config.dbPath,
    config.snapshotDir,
    config.n2cSocket ?? null,
    config.skipApply ? 1 : 0,
    config.runState,
    config.lastError ?? null,
    config.pid ?? null,
    config.bootstrapPid ?? null,
    config.bootstrapState ?? "idle",
    JSON.stringify(config),
    now,
  );
  return config.id;
}

export function listInstances(db: Database): InstanceConfig[] {
  const rows = db.query("SELECT * FROM instances ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToConfig);
}

export function getInstance(db: Database, id: string): InstanceConfig | null {
  const row = db.query("SELECT * FROM instances WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToConfig(row) : null;
}
