import { describe, expect, test } from "bun:test";
import { buildConfigOverlay, DEFAULT_NODE_SETTINGS, mergeConfigJson } from "./nodeSettings";

describe("buildConfigOverlay", () => {
  test("maps tip sync + n2c off", () => {
    const o = buildConfigOverlay({
      network: "preprod",
      port: 3030,
      dbPath: "/tmp/g.db",
      n2cSocket: "",
      settings: DEFAULT_NODE_SETTINGS,
    });
    expect(o.port).toBe(3030);
    expect(o.dbPath).toBe("/tmp/g.db");
    expect(o.syncFromTip).toBe(true);
    expect(o.syncFromGenesis).toBe(false);
    expect((o.n2c as { enabled: boolean }).enabled).toBe(false);
    expect((o.peerGovernor as { targetWarm: number }).targetWarm).toBe(6);
  });

  test("enables n2c when socket set", () => {
    const o = buildConfigOverlay({
      network: "preprod",
      port: 3030,
      dbPath: "/tmp/g.db",
      n2cSocket: "/tmp/node.socket",
      settings: DEFAULT_NODE_SETTINGS,
    });
    expect((o.n2c as { enabled: boolean; socketPath: string }).enabled).toBe(true);
    expect((o.n2c as { socketPath: string }).socketPath).toBe("/tmp/node.socket");
  });
});

describe("mergeConfigJson", () => {
  test("nests peerGovernor without dropping repo keys", () => {
    const merged = mergeConfigJson(
      { peerGovernor: { enabled: true, tickMs: 15000, targetHot: 2 } },
      { peerGovernor: { targetHot: 4, targetWarm: 8 } },
    );
    const pg = merged.peerGovernor as Record<string, unknown>;
    expect(pg.tickMs).toBe(15000);
    expect(pg.targetHot).toBe(4);
    expect(pg.targetWarm).toBe(8);
  });
});
