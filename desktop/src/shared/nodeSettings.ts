/** User-facing knobs from src/config/{network}/config.json */

export type SyncMode = "tip" | "genesis" | "point";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type BodyValidation = "auto" | "soft" | "strict";
export type ScriptValidation = "off" | "log" | "strict";
/** data = outbound only (default). relay = also accept inbound node-to-node peers. */
export type NodeRole = "data" | "relay";

export type NodeSettings = {
  syncMode: SyncMode;
  syncFromPointSlot: string;
  syncFromPointBlockHash: string;
  logLevel: LogLevel;
  logToFile: boolean;
  logToConsole: boolean;
  bodyValidation: BodyValidation;
  scriptValidation: ScriptValidation;
  tuiEnabled: boolean;
  unixSocket: boolean;
  role: NodeRole;
  /** Legacy mirror of role === "relay"; kept so old saved settings still load. */
  n2nEnabled: boolean;
  n2nPort: number;
  n2nMaxConnections: number;
  peerGovernorEnabled: boolean;
  /** Header-validation workers: "auto" = all cores. */
  validationWorkers: number | "auto";
  targetHot: number;
  targetWarm: number;
  targetCold: number;
};

export const DEFAULT_NODE_SETTINGS: NodeSettings = {
  syncMode: "tip",
  syncFromPointSlot: "0",
  syncFromPointBlockHash:
    "0000000000000000000000000000000000000000000000000000000000000000",
  logLevel: "info",
  logToFile: false,
  logToConsole: true,
  bodyValidation: "auto",
  scriptValidation: "off",
  tuiEnabled: false,
  unixSocket: false,
  role: "data",
  n2nEnabled: false,
  n2nPort: 3001,
  n2nMaxConnections: 64,
  peerGovernorEnabled: true,
  validationWorkers: "auto",
  targetHot: 3,
  targetWarm: 6,
  targetCold: 64,
};

function nest(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(base && typeof base === "object" ? base : {}), ...patch };
}

/** Overlay written to <instance>/config.json and merged onto repo config.json */
export function buildConfigOverlay(input: {
  network: string;
  port: number;
  dbPath: string;
  n2cSocket?: string | null;
  settings: NodeSettings;
}): Record<string, unknown> {
  const s = { ...DEFAULT_NODE_SETTINGS, ...input.settings };
  // Old saved settings have no role: a saved n2nEnabled=true meant relay.
  const role: NodeRole = s.role === "relay" || (input.settings.role == null && s.n2nEnabled) ? "relay" : "data";
  const syncFromTip = s.syncMode === "tip";
  const syncFromGenesis = s.syncMode === "genesis";
  const syncFromPoint = s.syncMode === "point";
  const n2cOn = !!(input.n2cSocket && input.n2cSocket.trim());
  return {
    port: input.port,
    dbPath: input.dbPath,
    unixSocket: s.unixSocket,
    role,
    tuiEnabled: s.tuiEnabled,
    bodyValidation: s.bodyValidation,
    scriptValidation: s.scriptValidation,
    syncFromTip,
    syncFromGenesis,
    syncFromPoint,
    syncFromPointSlot: s.syncFromPointSlot,
    syncFromPointBlockHash: s.syncFromPointBlockHash,
    n2c: {
      enabled: n2cOn,
      socketPath: n2cOn ? input.n2cSocket : "",
    },
    n2n: {
      enabled: role === "relay",
      host: "0.0.0.0",
      port: s.n2nPort,
      maxConnections: s.n2nMaxConnections,
    },
    logs: {
      logToFile: s.logToFile,
      logToConsole: s.logToConsole,
      logLevel: s.logLevel,
    },
    peerGovernor: {
      enabled: s.peerGovernorEnabled,
      targetHot: s.targetHot,
      targetWarm: s.targetWarm,
      targetCold: s.targetCold,
    },
    validation: {
      workers: s.validationWorkers,
    },
  };
}

export function mergeConfigJson(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const nested = ["n2c", "n2n", "logs", "peerGovernor", "snapshot", "blockFetchBatch", "validation", "sync"] as const;
  const out: Record<string, unknown> = { ...base, ...overlay };
  for (const key of nested) {
    if (overlay[key] && typeof overlay[key] === "object") {
      out[key] = nest(
        base[key] as Record<string, unknown> | undefined,
        overlay[key] as Record<string, unknown>,
      );
    }
  }
  return out;
}
