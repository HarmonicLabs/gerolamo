import { describe, expect, test } from "bun:test";
import { createInstanceDb, getInstance, listInstances, saveInstance, getPref, setPref } from "./database";
import type { InstanceConfig } from "../shared/types";

function sample(over: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    id: over.id || "gerolamo-preprod-1",
    name: "Gerolamo preprod",
    network: "preprod",
    port: 3030,
    repoPath: "/tmp/gerolamo",
    instanceDir: "/tmp/inst",
    dbPath: "/tmp/inst/data/gerolamo.db",
    snapshotDir: "/tmp/inst/snapshots",
    runState: "never",
    pid: null,
    ...over,
  };
}

describe("instances db", () => {
  test("save returns id and list round-trips", () => {
    const db = createInstanceDb(":memory:");
    const id = saveInstance(db, sample());
    expect(id).toBe("gerolamo-preprod-1");
    const rows = listInstances(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].dbPath).toBe("/tmp/inst/data/gerolamo.db");
    expect(getInstance(db, id)?.port).toBe(3030);
  });

  test("second boot is idempotent", () => {
    const db = createInstanceDb(":memory:");
    saveInstance(db, sample());
    saveInstance(db, sample({ name: "updated", port: 3040 }));
    expect(listInstances(db)).toHaveLength(1);
    expect(getInstance(db, "gerolamo-preprod-1")?.port).toBe(3040);
    expect(getInstance(db, "gerolamo-preprod-1")?.name).toBe("updated");
  });
});

describe("prefs", () => {
  test("set/get/delete round-trip and upsert", () => {
    const db = createInstanceDb(":memory:");
    expect(getPref(db, "lastInstanceId")).toBeNull();
    setPref(db, "lastInstanceId", "gerolamo-preprod-1");
    expect(getPref(db, "lastInstanceId")).toBe("gerolamo-preprod-1");
    setPref(db, "lastInstanceId", "gerolamo-mainnet-2");
    expect(getPref(db, "lastInstanceId")).toBe("gerolamo-mainnet-2");
    setPref(db, "lastInstanceId", null);
    expect(getPref(db, "lastInstanceId")).toBeNull();
  });
});
