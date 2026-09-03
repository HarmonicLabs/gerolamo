import type { GerolamoNetwork, GerolamoSyncStatus } from "./syncStatus";
import type { NodeSettings } from "./nodeSettings";
import type { ResourceSnapshot } from "./resources";

export type { GerolamoNetwork, GerolamoSyncStatus, NodeSettings, ResourceSnapshot };
export { DEFAULT_NODE_SETTINGS } from "./nodeSettings";

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
  /** Fillable src/config/{network}/config.json knobs for this instance. */
  nodeSettings?: NodeSettings;
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
  /** Host CPU/memory plus the node's own CPU, RSS, heap and DB-on-disk usage. */
  resources?: ResourceSnapshot | null;
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
    nodeSettings: partial.nodeSettings,
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

/** Result of POST /api/v0/tx/submit through the desktop's bun process. */
export type SubmitTxResult = {
  ok: boolean;
  status: number;
  /** Parsed JSON body from the node (BF error shape or the accepted shape). */
  body: unknown;
  error?: string;
};

export type MempoolSnapshot = { ok: boolean; count: number; txs: Array<{ tx_hash: string; size: number }>; error?: string };
