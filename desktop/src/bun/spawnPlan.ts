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
  /** Always empty: Gerolamo reads no environment variables, every setting is a flag (docs/CONFIG.md). */
  env: Record<string, string>;
};

export function buildNodeSpawn(input: NodeSpawnInput): SpawnPlan {
  const dbPath = assertAbsPath(input.dbPath, "dbPath");
  const argv = [input.bunPath, "src/index.ts", "start-gerolamo", "--network", input.network, "--port", String(input.port), "--db-path", dbPath];
  if (input.n2cSocket) argv.push("--n2c-socket", assertAbsPath(input.n2cSocket, "n2cSocket"));
  else argv.push("--no-n2c");
  if (input.configPath) argv.push("--config", assertAbsPath(input.configPath, "configPath"));
  return { argv, cwd: input.repoRoot, env: {} };
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
  return { argv, cwd: input.repoRoot, env: {} };
}
