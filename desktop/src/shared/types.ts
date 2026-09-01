import type { GerolamoNetwork, GerolamoSyncStatus } from "./syncStatus";

export type { GerolamoNetwork, GerolamoSyncStatus };

export type RunState = "never" | "running" | "stopped" | "failed";

export type InstanceConfig = {
  id: string;
  name: string;
  network: GerolamoNetwork;
  port: number;
  repoPath: string;
  bunPath?: string;
  instanceDir: string;
  dbPath: string;
  snapshotDir: string;
  n2cSocket?: string | null;
  skipApply?: boolean;
  runState: RunState;
  lastError?: string;
  pid?: number | null;
  bootstrapPid?: number | null;
  bootstrapState?: "idle" | "running" | "ready" | "failed";
};

export type DetectResult = {
  ok: boolean;
  bunPath: string | null;
  bunVersion: string | null;
  repoPath: string | null;
  repoVersion: string | null;
  hasStartEntry: boolean;
  error: string | null;
};

export type HealthResult = {
  healthy: boolean;
  statusCode?: number;
  message?: string;
  latencyMs?: number | null;
};

export type StatusResult = {
  id: string;
  running: boolean;
  pid: number | null;
  instanceDir: string | null;
  baseUrl: string;
  port: number;
  runState: RunState;
  lastError?: string;
  health?: HealthResult | null;
  sync?: GerolamoSyncStatus | null;
  n2c?: "off" | string;
};

export type LogsResult = {
  ok: boolean;
  lines: string[];
  logPath?: string;
  error?: string;
};

export type BootstrapStatus = {
  stage: string;
  stageLabel: string;
  processAlive: boolean;
  snapshotHuman: string | null;
  dataHuman: string | null;
  immutableCount: number | null;
  logPath: string | null;
  pid: number | null;
  exitCode: number | null;
};

export function gerolamoHttpBase(port: number): string {
  return `http://127.0.0.1:${port || 3030}`;
}

export function createDefaultInstance(
  partial: Partial<InstanceConfig> & { network?: GerolamoNetwork } = {},
): Omit<InstanceConfig, "instanceDir" | "dbPath" | "snapshotDir"> & {
  instanceDir?: string;
  dbPath?: string;
  snapshotDir?: string;
} {
  const network = partial.network || "preprod";
  const id = partial.id || `gerolamo-${network}-${Date.now()}`;
  const port = partial.port ?? 3030;
  return {
    id,
    name: partial.name || `Gerolamo ${network}`,
    network,
    port,
    repoPath: partial.repoPath || "",
    bunPath: partial.bunPath,
    instanceDir: partial.instanceDir,
    dbPath: partial.dbPath,
    snapshotDir: partial.snapshotDir,
    n2cSocket: partial.n2cSocket ?? null,
    skipApply: partial.skipApply ?? false,
    runState: partial.runState || "never",
    lastError: partial.lastError,
    pid: partial.pid ?? null,
    bootstrapPid: partial.bootstrapPid ?? null,
    bootstrapState: partial.bootstrapState || "idle",
  };
}

export function findReusableInstance(
  rows: InstanceConfig[],
  network: GerolamoNetwork,
): InstanceConfig | null {
  const same = rows.filter((n) => n.network === network);
  if (!same.length) return null;
  const running = same.find((n) => n.runState === "running" || (n.pid && n.pid > 0));
  if (running) return running;
  const withDir = same.find((n) => !!n.instanceDir);
  if (withDir) return withDir;
  const sorted = [...same].sort((a, b) => {
    const ta = Number((a.id.match(/(\d{10,})$/) || [])[1] || 0);
    const tb = Number((b.id.match(/(\d{10,})$/) || [])[1] || 0);
    return tb - ta;
  });
  return sorted[0] ?? null;
}
