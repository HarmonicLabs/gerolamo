import { spawn, type Subprocess, which } from "bun";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { detectInstallation, resolveBunPath } from "./detect";
import { getAppDb, getInstance, listInstances, saveInstance } from "./database";
import { assertAbsPath, instanceDirFor, normalizeDbPath, resolveRepoRoot } from "./paths";
import { buildNodeSpawn } from "./spawnPlan";
import { writersConflict } from "./mithrilStage";
import { deriveGerolamoSyncStatus, fetchGerolamoMetrics } from "../shared/syncStatus";
import { resourceSnapshot } from "./resources";
import {
  createDefaultInstance,
  findReusableInstance,
  gerolamoHttpBase,
  type HealthResult,
  type InstanceConfig,
  type LogsResult,
  type StatusResult,
} from "../shared/types";
import { buildConfigOverlay, DEFAULT_NODE_SETTINGS } from "../shared/nodeSettings";
import { bootstrapAlive, bootstrapDbPath } from "./mithrilService";
import { dbSidecars, wipeDirContents, wipeFiles } from "./wipe";

const live = new Map<string, Subprocess>();

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function nodeAlive(id: string): boolean {
  const row = getInstance(getAppDb(), id);
  return live.has(id) || isPidAlive(row?.pid);
}

export function nodeDbPath(id: string): string | null {
  return getInstance(getAppDb(), id)?.dbPath ?? null;
}

function appendLog(logPath: string, chunk: string) {
  try {
    appendFileSync(logPath, chunk, "utf8");
  } catch {
    /* ignore */
  }
}

function tailFile(path: string, maxLines = 200): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).slice(-maxLines);
  } catch {
    return [];
  }
}

function ensureLayout(id: string): string {
  const dir = instanceDirFor(id);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  return dir;
}

export function listNodes(): InstanceConfig[] {
  return listInstances(getAppDb());
}

export function writeConfig(input: Partial<InstanceConfig>): {
  ok: boolean;
  config?: InstanceConfig;
  instanceDir?: string;
  error?: string;
} {
  try {
    const detect = { repoPath: "" as string };
    try {
      detect.repoPath = resolveRepoRoot();
    } catch {
      detect.repoPath = input.repoPath || "";
    }
    const bunPath = resolveBunPath(input.bunPath);
    const base = createDefaultInstance({
      ...input,
      repoPath: input.repoPath || detect.repoPath,
      bunPath: bunPath || input.bunPath,
    });
    if (input.id) {
      // An instance is bound to one network for life: its id, folder and DB carry
      // that network's chain. Switching the dropdown must select/create the other
      // network's instance, never retarget this one.
      const existing = getInstance(getAppDb(), input.id);
      if (existing && existing.network !== base.network) {
        return {
          ok: false,
          error: `Instance ${input.id} is a ${existing.network} instance; pick or create a ${base.network} instance instead of retargeting it`,
        };
      }
    } else {
      const reused = findReusableInstance(listNodes(), base.network);
      if (reused) {
        base.id = reused.id;
        base.instanceDir = reused.instanceDir;
        base.dbPath = input.dbPath || reused.dbPath;
        base.snapshotDir = input.snapshotDir || reused.snapshotDir;
      }
    }
    const dir = ensureLayout(base.id);
    const dbPath = normalizeDbPath(input.dbPath || join(dir, "data", "gerolamo.db"));
    const repoSnap = join(base.repoPath || detect.repoPath, "snapshots", "mithril");
    const snapshotDir = assertAbsPath(
      input.snapshotDir || (existsSync(repoSnap) ? repoSnap : join(dir, "snapshots")),
      "snapshotDir",
    );
    if (input.n2cSocket) assertAbsPath(input.n2cSocket, "n2cSocket");
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const config: InstanceConfig = {
      ...base,
      instanceDir: dir,
      dbPath,
      snapshotDir,
      bunPath: bunPath || base.bunPath,
      repoPath: base.repoPath,
      nodeSettings: {
        ...DEFAULT_NODE_SETTINGS,
        ...(base.nodeSettings ?? {}),
        ...(input.nodeSettings ?? {}),
      },
    };

    const overlay = buildConfigOverlay({
      network: config.network,
      port: config.port,
      dbPath: config.dbPath,
      n2cSocket: config.n2cSocket,
      settings: config.nodeSettings ?? DEFAULT_NODE_SETTINGS,
    });
    writeFileSync(join(dir, "config.json"), JSON.stringify(overlay, null, 2), "utf8");
    writeFileSync(join(dir, "instance.json"), JSON.stringify(config, null, 2), "utf8");
    writeFileSync(
      join(dir, "README.txt"),
      [
        "Gerolamo standalone instance",
        `id: ${config.id}`,
        `network: ${config.network}`,
        `HTTP: ${gerolamoHttpBase(config.port)}`,
        `DB: ${config.dbPath}`,
        "MiniBF is a subset. Soft ledger ≠ consensus proof. Not TxPipe.",
        "",
        "Process: bun src/index.ts start-gerolamo (cwd = gerolamo repo)",
        "Logs: logs/daemon.log",
      ].join("\n"),
      "utf8",
    );
    saveInstance(getAppDb(), config);
    return { ok: true, config, instanceDir: dir };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function startNode(input: Partial<InstanceConfig>): Promise<{
  success: boolean;
  pid?: number;
  config?: InstanceConfig;
  error?: string;
}> {
  try {
    let written = writeConfig(input);
    if (!written.ok || !written.config) return { success: false, error: written.error };
    const config = written.config;

    if (config.pid && isPidAlive(config.pid)) {
      return { success: true, pid: config.pid, config };
    }

    if (
      writersConflict({
        nodeDb: config.dbPath,
        nodeAlive: false,
        bootstrapDb: bootstrapDbPath() || config.dbPath,
        bootstrapAlive: bootstrapAlive(),
      }) &&
      bootstrapAlive() &&
      (bootstrapDbPath() === config.dbPath)
    ) {
      return { success: false, error: "Mithril bootstrap holds this DB — stop bootstrap first (one writer)" };
    }

    const detected = await detectInstallation(config.repoPath);
    if (!detected.ok || !detected.bunPath || !detected.repoPath) {
      return { success: false, error: detected.error || "detect failed" };
    }

    const plan = buildNodeSpawn({
      bunPath: detected.bunPath,
      repoRoot: detected.repoPath,
      network: config.network,
      port: config.port,
      dbPath: config.dbPath,
      n2cSocket: config.n2cSocket,
      configPath: join(config.instanceDir, "config.json"),
    });

    const logPath = join(config.instanceDir, "logs", "daemon.log");
    writeFileSync(logPath, `[ui] starting ${new Date().toISOString()}\n`, "utf8");
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

    const pid = child.pid;
    live.set(config.id, child);
    config.pid = pid ?? null;
    config.runState = "running";
    config.lastError = undefined;
    saveInstance(getAppDb(), config);
    appendLog(logPath, `[ui] spawned pid=${pid} network=${config.network}\n`);

    void child.exited.then((code) => {
      live.delete(config.id);
      const row = getInstance(getAppDb(), config.id);
      if (row) {
        saveInstance(getAppDb(), {
          ...row,
          pid: null,
          runState: code === 0 ? "stopped" : "failed",
          lastError: code === 0 ? undefined : `process exited ${code}`,
        });
      }
      appendLog(logPath, `[ui] process exited code=${code} at ${new Date().toISOString()}\n`);
    });

    return { success: true, pid: pid ?? undefined, config };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function stopNode(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const row = getInstance(getAppDb(), id);
    const liveProc = live.get(id);
    const pid = row?.pid ?? liveProc?.pid ?? null;
    if (liveProc) {
      try {
        liveProc.kill();
      } catch {
        /* ignore */
      }
      live.delete(id);
    }
    if (pid && isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      await Bun.sleep(800);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    if (row) {
      saveInstance(getAppDb(), { ...row, pid: null, runState: "stopped" });
      appendLog(join(row.instanceDir, "logs", "daemon.log"), `[ui] stopped at ${new Date().toISOString()}\n`);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function healthCheck(input: Partial<InstanceConfig> | string): Promise<HealthResult> {
  try {
    const config =
      typeof input === "string" ? getInstance(getAppDb(), input) : writeConfig(input).config;
    if (!config) return { healthy: false, message: "Unknown instance" };
    const base = gerolamoHttpBase(config.port);
    const t0 = Date.now();
    let res = await fetch(base + "/health", { signal: AbortSignal.timeout(2500) }).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch(base + "/", { signal: AbortSignal.timeout(2500) });
    }
    const latencyMs = Date.now() - t0;
    const text = await res.text().catch(() => "");
    return {
      healthy: res.ok || res.status === 200,
      statusCode: res.status,
      message: text.slice(0, 160) || res.statusText,
      latencyMs,
    };
  } catch (err: any) {
    return { healthy: false, message: err?.message ?? String(err), latencyMs: null };
  }
}

export async function getNodeStatus(id: string): Promise<StatusResult | null> {
  const row = getInstance(getAppDb(), id);
  if (!row) return null;
  const pid = row.pid ?? null;
  const running = isPidAlive(pid) || live.has(id);
  let health: HealthResult | null = null;
  let sync = null;
  let metrics = null;
  if (running) {
    health = await healthCheck(row);
    metrics = await fetchGerolamoMetrics(gerolamoHttpBase(row.port));
    sync = metrics ? deriveGerolamoSyncStatus(metrics, row.network) : null;
  }
  const resources = resourceSnapshot({
    running,
    pid,
    dbPath: row.dbPath,
    metricsProcess: metrics?.process,
  });
  return {
    id,
    running,
    pid: running ? pid : null,
    instanceDir: row.instanceDir || null,
    baseUrl: gerolamoHttpBase(row.port),
    port: row.port,
    runState: running ? "running" : row.runState || "stopped",
    lastError: row.lastError,
    health,
    sync,
    resources,
    n2c: row.n2cSocket || "off",
  };
}

export function logs(id: string, maxLines = 200): LogsResult {
  try {
    const row = getInstance(getAppDb(), id);
    const dir = row?.instanceDir || instanceDirFor(id);
    const logPath = join(dir, "logs", "daemon.log");
    return { ok: true, lines: tailFile(logPath, maxLines), logPath };
  } catch (err: any) {
    return { ok: false, lines: [], error: err?.message ?? String(err) };
  }
}

export async function pickDirectory(): Promise<{ path: string } | { cancelled: true }> {
  const bin = which("zenity") || which("kdialog");
  if (!bin) return { cancelled: true };
  try {
    const argv = bin.includes("kdialog")
      ? [bin, "--getexistingdirectory", "/"]
      : [bin, "--file-selection", "--directory", "--title=Select folder"];
    const p = spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    const code = await p.exited;
    if (code !== 0 || !out) return { cancelled: true };
    return { path: assertAbsPath(out, "picked") };
  } catch {
    return { cancelled: true };
  }
}

export function openExternal(url: string): { ok: boolean; error?: string } {
  try {
    spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function wipeChainDb(id: string): { ok: boolean; error?: string; path?: string; removed?: string[] } {
  const row = getInstance(getAppDb(), id);
  if (!row) return { ok: false, error: "Unknown instance — save config first" };
  if (live.has(id) || isPidAlive(row.pid)) return { ok: false, error: "Stop the node first (one writer)" };
  if (bootstrapAlive()) return { ok: false, error: "Stop Mithril bootstrap first (one writer)" };
  try {
    const path = assertAbsPath(row.dbPath, "dbPath");
    const { removed } = wipeFiles(dbSidecars(path));
    return { ok: true, path, removed };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function wipeSnapshots(id: string): { ok: boolean; error?: string; path?: string; removed?: number } {
  const row = getInstance(getAppDb(), id);
  if (!row) return { ok: false, error: "Unknown instance — save config first" };
  if (live.has(id) || isPidAlive(row.pid)) return { ok: false, error: "Stop the node first" };
  if (bootstrapAlive()) return { ok: false, error: "Stop Mithril bootstrap first" };
  try {
    const r = wipeDirContents(row.snapshotDir);
    if (!r.ok) return { ok: false, error: r.error, path: r.path };
    return { ok: true, path: r.path, removed: r.removed };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function hydrate(): void {
  for (const n of listNodes()) {
    if (n.pid && !isPidAlive(n.pid) && n.runState === "running") {
      saveInstance(getAppDb(), { ...n, pid: null, runState: "stopped" });
    }
  }
}
