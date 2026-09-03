import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertAbsPath } from "./paths";

const FORBIDDEN = new Set(["/", homedir(), "/home", "/usr", "/var", "/etc"]);

function refuseRoot(abs: string, label: string): string | null {
  const p = abs.replace(/\/+$/, "") || "/";
  if (FORBIDDEN.has(p) || p === homedir()) return `refusing to wipe ${label} at ${p}`;
  return null;
}

export function dbSidecars(dbPath: string): string[] {
  const db = assertAbsPath(dbPath, "dbPath");
  return [db, `${db}-wal`, `${db}-shm`, `${db}-journal`];
}

export function wipeFiles(paths: string[]): { removed: string[]; missing: string[] } {
  const removed: string[] = [];
  const missing: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      missing.push(p);
      continue;
    }
    unlinkSync(p);
    removed.push(p);
  }
  return { removed, missing };
}

export function wipeDirContents(dirPath: string): { ok: boolean; error?: string; removed: number; path: string } {
  const dir = assertAbsPath(dirPath, "snapshotDir");
  const bad = refuseRoot(dir, "snapshotDir");
  if (bad) return { ok: false, error: bad, removed: 0, path: dir };
  if (!existsSync(dir)) return { ok: true, removed: 0, path: dir };
  let removed = 0;
  for (const name of readdirSync(dir)) {
    rmSync(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return { ok: true, removed, path: dir };
}
