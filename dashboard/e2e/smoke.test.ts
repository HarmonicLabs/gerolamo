import { describe, it, expect, test } from "bun:test";
import { resolve } from "path";
import { existsSync } from "fs";

const DASHBOARD_ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Vite config validation
// ---------------------------------------------------------------------------

describe("Vite config", () => {
  it("vite.config.ts exists", () => {
    expect(existsSync(resolve(DASHBOARD_ROOT, "vite.config.ts"))).toBe(true);
  });

  it("vite config can be imported and has expected structure", async () => {
    const mod = await import(resolve(DASHBOARD_ROOT, "vite.config.ts"));
    const config = mod.default;
    expect(config).toBeDefined();
    // defineConfig returns an object with plugins, resolve, server, build
    expect(config).toHaveProperty("plugins");
    expect(config).toHaveProperty("resolve");
    expect(config).toHaveProperty("server");
    expect(config).toHaveProperty("build");
  });
});

// ---------------------------------------------------------------------------
// Page modules can be dynamically imported
// ---------------------------------------------------------------------------

describe("Page module imports", () => {
  const pages = [
    "Overview",
    "Blocks",
    "Peers",
    "Mempool",
    "Explorer",
    "Logs",
    "Settings",
  ];

  for (const page of pages) {
    it(`src/pages/${page}.tsx can be imported`, async () => {
      const path = resolve(DASHBOARD_ROOT, `src/pages/${page}.tsx`);
      expect(existsSync(path)).toBe(true);
      const mod = await import(path);
      expect(mod).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Component barrel exports
// ---------------------------------------------------------------------------

describe("Component barrel exports", () => {
  it("Diagram barrel exports ChainDiagram, BlockNode, TxStack, TxCard", async () => {
    const mod = await import(
      resolve(DASHBOARD_ROOT, "src/components/Diagram/index.ts")
    );
    expect(mod).toHaveProperty("ChainDiagram");
    expect(mod).toHaveProperty("BlockNode");
    expect(mod).toHaveProperty("TxStack");
    expect(mod).toHaveProperty("TxCard");
  });

  it("Charts barrel exports ProgressRing, LineChart", async () => {
    const mod = await import(
      resolve(DASHBOARD_ROOT, "src/components/Charts/index.ts")
    );
    expect(mod).toHaveProperty("ProgressRing");
    expect(mod).toHaveProperty("LineChart");
  });

  it("Layout barrel exports Sidebar, Topbar, Footer", async () => {
    const mod = await import(
      resolve(DASHBOARD_ROOT, "src/components/Layout/index.ts")
    );
    expect(mod).toHaveProperty("Sidebar");
    expect(mod).toHaveProperty("Topbar");
    expect(mod).toHaveProperty("Footer");
  });

  it("UI barrel exports Card, Badge, Stat, ProgressBar", async () => {
    const mod = await import(
      resolve(DASHBOARD_ROOT, "src/components/UI/index.ts")
    );
    expect(mod).toHaveProperty("Card");
    expect(mod).toHaveProperty("Badge");
    expect(mod).toHaveProperty("Stat");
    expect(mod).toHaveProperty("ProgressBar");
  });

  it("Blocks barrel exports BlockCard, BlockDetail, TxRow, FilterBar", async () => {
    const mod = await import(
      resolve(DASHBOARD_ROOT, "src/components/Blocks/index.ts")
    );
    expect(mod).toHaveProperty("BlockCard");
    expect(mod).toHaveProperty("BlockDetail");
    expect(mod).toHaveProperty("TxRow");
    expect(mod).toHaveProperty("FilterBar");
  });
});

// ---------------------------------------------------------------------------
// Build verification
// ---------------------------------------------------------------------------

describe("Build", () => {
  it("bun run build exits with code 0", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: DASHBOARD_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("Build stderr:", stderr);
    }
    expect(exitCode).toBe(0);
  }, 60_000); // 60s timeout for build
});
