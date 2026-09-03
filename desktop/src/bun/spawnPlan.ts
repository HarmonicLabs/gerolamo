import { assertAbsPath } from "./paths";

export type NodeSpawnInput = {
  bunPath: string;
  repoRoot: string;
  network: string;
  port: number;
  dbPath: string;
  n2cSocket?: string | null;
  /** Absolute path to instance config.json overlay. */
  configPath?: string | null;
};

export type SpawnPlan = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

export function buildNodeSpawn(input: NodeSpawnInput): SpawnPlan {
  const dbPath = assertAbsPath(input.dbPath, "dbPath");
  const env: Record<string, string> = {
    NETWORK: input.network,
    PORT: String(input.port),
    GEROLAMO_PORT: String(input.port),
    GEROLAMO_DB_PATH: dbPath,
    DATABASE_URL: `sqlite://${dbPath}`,
  };
  if (input.n2cSocket) {
    env.GEROLAMO_N2C_SOCKET = assertAbsPath(input.n2cSocket, "n2cSocket");
  } else {
    env.GEROLAMO_N2C = "0";
  }
  if (input.configPath) {
    env.GEROLAMO_CONFIG_PATH = assertAbsPath(input.configPath, "configPath");
  }
  return {
    argv: [input.bunPath, "src/index.ts", "start-gerolamo"],
    cwd: input.repoRoot,
    env,
  };
}

export type MithrilSpawnInput = {
  bunPath: string;
  repoRoot: string;
  network: string;
  dbPath: string;
  snapshotDir: string;
  skipApply?: boolean;
};

export function buildMithrilSpawn(input: MithrilSpawnInput): SpawnPlan {
  const dbPath = assertAbsPath(input.dbPath, "dbPath");
  const snapshotDir = assertAbsPath(input.snapshotDir, "snapshotDir");
  const argv = [
    input.bunPath,
    "src/index.ts",
    "mithril-bootstrap",
    "--network",
    input.network,
    "--engine",
    "ts",
    "--download-dir",
    snapshotDir,
    "--db",
    dbPath,
  ];
  if (input.skipApply) argv.push("--skip-apply");
  return { argv, cwd: input.repoRoot, env: { NETWORK: input.network } };
}
