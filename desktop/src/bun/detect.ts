import { which } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { hasStartEntry, packageVersion, resolveRepoRoot } from "./paths";
import type { DetectResult } from "../shared/types";

const BUN_CANDIDATES = [
  process.env.BUN_BIN,
  join(homedir(), ".bun", "bin", "bun"),
  "/usr/local/bin/bun",
  "/usr/bin/bun",
  "bun",
].filter(Boolean) as string[];

export function resolveBunPath(preferred?: string | null): string | null {
  const candidates = [preferred, ...BUN_CANDIDATES].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c.includes("/") && existsSync(c)) return c;
    try {
      const w = which(c);
      if (w) return w;
    } catch {
      /* continue */
    }
  }
  return null;
}

async function bunVersion(bunPath: string): Promise<string | null> {
  try {
    const p = Bun.spawn([bunPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function detectInstallation(preferredRepo?: string | null): Promise<DetectResult> {
  try {
    const bunPath = resolveBunPath(null);
    let repoPath: string | null = null;
    if (preferredRepo && existsSync(join(preferredRepo, "src", "index.ts"))) {
      repoPath = preferredRepo;
    } else {
      try {
        repoPath = resolveRepoRoot();
      } catch {
        repoPath = null;
      }
    }
    const version = bunPath ? await bunVersion(bunPath) : null;
    const hasEntry = repoPath ? hasStartEntry(repoPath) : false;
    const ok = !!(bunPath && repoPath && hasEntry);
    return {
      ok,
      bunPath,
      bunVersion: version,
      repoPath,
      repoVersion: repoPath ? packageVersion(repoPath) : null,
      hasStartEntry: hasEntry,
      error: ok
        ? null
        : !bunPath
          ? "Bun not found (install from https://bun.sh)"
          : !repoPath
            ? "Gerolamo repo not found (run this UI from the gerolamo checkout)"
            : "Gerolamo start entry missing (src/index.ts)",
    };
  } catch (err: any) {
    return {
      ok: false,
      bunPath: null,
      bunVersion: null,
      repoPath: null,
      repoVersion: null,
      hasStartEntry: false,
      error: err?.message ?? String(err),
    };
  }
}
