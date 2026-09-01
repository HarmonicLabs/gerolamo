import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const DATA_ROOT = join(homedir(), ".local", "share", "gerolamo");

export function assertAbsPath(p: string, label = "path"): string {
  if (!p || typeof p !== "string" || !p.trim()) {
    throw new Error(`${label} required`);
  }
  const trimmed = p.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`${label} must be absolute, got ${trimmed}`);
  }
  return trimmed;
}

export function instanceDirFor(id: string): string {
  return join(DATA_ROOT, id);
}

export function appDbPath(): string {
  return join(DATA_ROOT, "app.db");
}

/** Walk up from `fromDir` until we find the Gerolamo node repo (src/index.ts + mithril or cli). */
export function resolveRepoRoot(fromDir = import.meta.dir): string {
  let dir = fromDir;
  for (let i = 0; i < 10; i++) {
    const index = join(dir, "src", "index.ts");
    const pkg = join(dir, "package.json");
    if (existsSync(index) && existsSync(pkg)) {
      const hasMithril = existsSync(join(dir, "src", "mithril"));
      const hasCli = existsSync(join(dir, "src", "cli.ts"));
      if (hasMithril || hasCli) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Gerolamo repo root not found (expected src/index.ts above desktop/)");
}

export function packageVersion(repoPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function hasStartEntry(repoPath: string): boolean {
  return existsSync(join(repoPath, "src", "index.ts"));
}
