import { describe, expect, test } from "bun:test";
import { buildMithrilSpawn, buildNodeSpawn } from "./spawnPlan";

describe("buildNodeSpawn", () => {
  test("argv/cwd/env match agent.md contract", () => {
    const plan = buildNodeSpawn({
      bunPath: "/opt/bun/bin/bun",
      repoRoot: "/opt/gerolamo",
      network: "preprod",
      port: 3040,
      dbPath: "/tmp/g.db",
    });
    expect(plan.argv).toEqual(["/opt/bun/bin/bun", "src/index.ts", "start-gerolamo"]);
    expect(plan.cwd).toBe("/opt/gerolamo");
    expect(plan.env.NETWORK).toBe("preprod");
    expect(plan.env.PORT).toBe("3040");
    expect(plan.env.GEROLAMO_PORT).toBe("3040");
    expect(plan.env.GEROLAMO_DB_PATH).toBe("/tmp/g.db");
    expect(plan.env.DATABASE_URL).toBe("sqlite:///tmp/g.db");
    expect(plan.env.GEROLAMO_N2C).toBe("0");
    expect(plan.env.GEROLAMO_N2C_SOCKET).toBeUndefined();
    expect(plan.env.GEROLAMO_CONFIG_PATH).toBeUndefined();
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

  test("sets N2C socket and omits GEROLAMO_N2C=0 when enabled", () => {
    const plan = buildNodeSpawn({
      bunPath: "/usr/bin/bun",
      repoRoot: "/tmp/repo",
      network: "preprod",
      port: 3030,
      dbPath: "/tmp/g.db",
      n2cSocket: "/tmp/node.socket",
    });
    expect(plan.env.GEROLAMO_N2C_SOCKET).toBe("/tmp/node.socket");
    expect(plan.env.GEROLAMO_N2C).toBeUndefined();
  });

  test("sets GEROLAMO_CONFIG_PATH for instance overlay", () => {
    const plan = buildNodeSpawn({
      bunPath: "/usr/bin/bun",
      repoRoot: "/tmp/repo",
      network: "preprod",
      port: 3030,
      dbPath: "/tmp/g.db",
      configPath: "/tmp/inst/config.json",
    });
    expect(plan.env.GEROLAMO_CONFIG_PATH).toBe("/tmp/inst/config.json");
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
