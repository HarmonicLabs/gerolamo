import { describe, expect, test } from "bun:test";
import { buildMithrilSpawn, buildNodeSpawn } from "./spawnPlan";

describe("buildNodeSpawn", () => {
  test("every setting is a flag; no environment", () => {
    const plan = buildNodeSpawn({
      bunPath: "/opt/bun/bin/bun",
      repoRoot: "/opt/gerolamo",
      network: "preprod",
      port: 3040,
      dbPath: "/tmp/g.db",
    });
    expect(plan.argv).toEqual(["/opt/bun/bin/bun", "src/index.ts", "start-gerolamo", "--network", "preprod", "--port", "3040", "--db-path", "/tmp/g.db", "--no-n2c"]);
    expect(plan.cwd).toBe("/opt/gerolamo");
    expect(plan.env).toEqual({});
  });

  test("rejects relative dbPath", () => {
    expect(() =>
      buildNodeSpawn({
        bunPath: "/usr/bin/bun",
        repoRoot: "/tmp/repo",
        network: "preprod",
        port: 3030,
        dbPath: "data/gerolamo.db",
      }),
    ).toThrow(/absolute/);
  });

  test("N2C socket and instance config as flags", () => {
    const plan = buildNodeSpawn({
      bunPath: "/usr/bin/bun",
      repoRoot: "/tmp/repo",
      network: "preprod",
      port: 3030,
      dbPath: "/tmp/g.db",
      n2cSocket: "/tmp/node.socket",
      configPath: "/tmp/inst/config.json",
    });
    expect(plan.argv.slice(3)).toEqual(["--network", "preprod", "--port", "3030", "--db-path", "/tmp/g.db", "--n2c-socket", "/tmp/node.socket", "--config", "/tmp/inst/config.json"]);
    expect(plan.argv).not.toContain("--no-n2c");
  });
});
describe("buildMithrilSpawn", () => {
  test("uses --engine ts and chosen dirs", () => {
    const plan = buildMithrilSpawn({
      bunPath: "/usr/bin/bun",
      repoRoot: "/tmp/repo",
      network: "preprod",
      dbPath: "/tmp/g.db",
      snapshotDir: "/tmp/snaps",
      skipApply: false,
    });
    expect(plan.argv).toEqual([
      "/usr/bin/bun",
      "src/index.ts",
      "mithril-bootstrap",
      "--network",
      "preprod",
      "--engine",
      "ts",
      "--download-dir",
      "/tmp/snaps",
      "--db",
      "/tmp/g.db",
    ]);
    expect(plan.cwd).toBe("/tmp/repo");
  });

  test("adds --skip-apply when requested", () => {
    const plan = buildMithrilSpawn({
      bunPath: "/usr/bin/bun",
      repoRoot: "/tmp/repo",
      network: "preprod",
      dbPath: "/tmp/g.db",
      snapshotDir: "/tmp/snaps",
      skipApply: true,
    });
    expect(plan.argv).toContain("--skip-apply");
  });
});
