import { spawn, type Subprocess } from "bun";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { detectInstallation } from "./detect";
import { getAppDb, getInstance, saveInstance } from "./database";
import { assertAbsPath } from "./paths";
import { buildMithrilSpawn } from "./spawnPlan";
import { inferMithrilStage, writersConflict, type MithrilStage } from "./mithrilStage";
import type { BootstrapStatus } from "../shared/types";

let live: { id: string; proc: Subprocess; dbPath: string; logPath: string; exitCode: number | null } | null =
  null;

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function bootstrapAlive(): boolean {
  return !!(live && pidAlive(live.proc.pid));
}

export function bootstrapDbPath(): string | null {
  return live?.dbPath ?? null;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const name of readdirSync(path)) {
      total += dirSize(join(path, name));
    }
    return total;
  } catch {
    return 0;
  }
}

function immutableCount(snapshotDir: string): number {
  const imm = existsSync(join(snapshotDir, "immutable"))
    ? join(snapshotDir, "immutable")
    : snapshotDir;
  try {
    return readdirSync(imm).length;
  } catch {
    return 0;
  }
}

function tailFile(path: string, maxLines = 80): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

export async function startBootstrap(id: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const config = getInstance(getAppDb(), id);
  if (!config) return { ok: false, error: "Unknown instance — write config first" };
  assertAbsPath(config.dbPath, "dbPath");
  assertAbsPath(config.snapshotDir, "snapshotDir");

  if (pidAlive(config.pid) && config.dbPath) {
    if (
      writersConflict({
        nodeDb: config.dbPath,
        nodeAlive: true,
        bootstrapDb: config.dbPath,
        bootstrapAlive: false,
      })
    ) {
      return { ok: false, error: "Node holds this DB — stop the node first (one writer)" };
    }
  }
  if (bootstrapAlive()) return { ok: false, error: "Bootstrap already running" };

  const detected = await detectInstallation(config.repoPath);
  if (!detected.ok || !detected.bunPath || !detected.repoPath) {
    return { ok: false, error: detected.error || "detect failed" };
  }

  mkdirSync(config.snapshotDir, { recursive: true });
  const logPath = join(config.instanceDir, "logs", "bootstrap.log");
  mkdirSync(join(config.instanceDir, "logs"), { recursive: true });
  writeFileSync(logPath, `[ui] mithril-bootstrap ${new Date().toISOString()}\n`, "utf8");

  const plan = buildMithrilSpawn({
    bunPath: detected.bunPath,
    repoRoot: detected.repoPath,
    network: config.network,
    dbPath: config.dbPath,
    snapshotDir: config.snapshotDir,
    skipApply: !!config.skipApply,
  });

  const logFd = openSync(logPath, "a");
  const child = spawn(plan.argv, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
  });
  try {
    closeSync(logFd);
  } catch {
    /* ignore */
  }

  live = { id, proc: child, dbPath: config.dbPath, logPath, exitCode: null };
  config.bootstrapPid = child.pid ?? null;
  config.bootstrapState = "running";
  saveInstance(getAppDb(), config);

  void child.exited.then((code) => {
    if (live && live.proc === child) live.exitCode = typeof code === "number" ? code : 1;
    const row = getInstance(getAppDb(), id);
    if (row) {
      const tail = tailFile(logPath, 40);
      const ready = /mithril-bootstrap complete/i.test(tail) && code === 0;
      saveInstance(getAppDb(), {
        ...row,
        bootstrapPid: null,
        bootstrapState: ready ? "ready" : "failed",
        lastError: ready ? undefined : `bootstrap exited ${code}`,
      });
    }
    try {
      appendFileSync(logPath, `[ui] bootstrap exited code=${code}\n`, "utf8");
    } catch {
      /* ignore */
    }
  });

  return { ok: true, pid: child.pid ?? undefined };
}

export async function stopBootstrap(): Promise<{ ok: boolean; error?: string }> {
  if (!live) return { ok: true };
  try {
    const pid = live.proc.pid;
    try {
      live.proc.kill();
    } catch {
      /* ignore */
    }
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      await Bun.sleep(600);
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    const row = getInstance(getAppDb(), live.id);
    if (row) saveInstance(getAppDb(), { ...row, bootstrapPid: null, bootstrapState: "failed" });
    live = null;
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function bootstrapStatus(id: string): BootstrapStatus {
  const config = getInstance(getAppDb(), id);
  const logPath = config ? join(config.instanceDir, "logs", "bootstrap.log") : null;
  const snapshotDir = config?.snapshotDir || "";
  const dbPath = config?.dbPath || "";
  const snapBytes = snapshotDir ? dirSize(snapshotDir) : 0;
  const dbBytes = dbPath && existsSync(dbPath) ? dirSize(dbPath) : 0;
  const imm = snapshotDir ? immutableCount(snapshotDir) : 0;
  const tail = logPath ? tailFile(logPath, 60) : "";
  const alive = bootstrapAlive();
  const inferred = inferMithrilStage({
    pidAlive: alive,
    exitCode: live?.exitCode ?? null,
    snapshotBytes: snapBytes,
    dbBytes,
    immutableCount: imm,
    logTail: tail,
  });
  let stage: MithrilStage = inferred.stage;
  if (!alive && config?.bootstrapState === "ready") stage = "ready";
  return {
    stage,
    stageLabel: inferred.label,
    processAlive: alive,
    snapshotHuman: snapBytes ? humanBytes(snapBytes) : "0 B",
    dataHuman: dbBytes ? humanBytes(dbBytes) : "0 B",
    immutableCount: imm,
    logPath,
    pid: live?.proc.pid ?? config?.bootstrapPid ?? null,
    exitCode: live?.exitCode ?? null,
  };
}

export function bootstrapLogs(id: string, maxLines = 120): { ok: boolean; lines: string[]; logPath?: string } {
  const config = getInstance(getAppDb(), id);
  if (!config) return { ok: false, lines: [] };
  const logPath = join(config.instanceDir, "logs", "bootstrap.log");
  const text = tailFile(logPath, maxLines);
  return { ok: true, lines: text ? text.split("\n") : [], logPath };
}

export function markBootstrapSkipped(id: string): { ok: boolean; error?: string } {
  const config = getInstance(getAppDb(), id);
  if (!config) return { ok: false, error: "Unknown instance" };
  saveInstance(getAppDb(), { ...config, bootstrapState: "ready" });
  return { ok: true };
}
