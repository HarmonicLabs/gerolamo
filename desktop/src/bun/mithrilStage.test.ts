import { describe, expect, test } from "bun:test";
import { inferMithrilStage, writersConflict } from "./mithrilStage";

describe("inferMithrilStage", () => {
  test("idle when nothing is running", () => {
    const s = inferMithrilStage({
      pidAlive: false,
      exitCode: null,
      snapshotBytes: 0,
      dbBytes: 0,
      immutableCount: 0,
      logTail: "",
    });
    expect(s.stage).toBe("idle");
  });

  test("starting when pid just spawned", () => {
    const s = inferMithrilStage({
      pidAlive: true,
      exitCode: null,
      snapshotBytes: 0,
      dbBytes: 0,
      immutableCount: 0,
      logTail: "",
    });
    expect(s.stage).toBe("starting");
  });

  test("downloading when snapshot grows", () => {
    const s = inferMithrilStage({
      pidAlive: true,
      exitCode: null,
      snapshotBytes: 50_000_000,
      dbBytes: 0,
      immutableCount: 12,
      logTail: "downloading chunk",
    });
    expect(s.stage).toBe("downloading");
  });

  test("applying when log has chunk progress JSON", () => {
    const s = inferMithrilStage({
      pidAlive: true,
      exitCode: null,
      snapshotBytes: 50_000_000,
      dbBytes: 1_000_000,
      immutableCount: 100,
      logTail: '{"phase":"apply","chunksDone":10,"chunksLeft":90}',
    });
    expect(s.stage).toBe("applying");
  });

  test("ready only when complete line and process gone", () => {
    const s = inferMithrilStage({
      pidAlive: false,
      exitCode: 0,
      snapshotBytes: 50_000_000,
      dbBytes: 64_000_000_000,
      immutableCount: 5000,
      logTail: "mithril-bootstrap complete downloaded=50 applied=50",
    });
    expect(s.stage).toBe("ready");
  });

  test("failed on non-zero exit", () => {
    const s = inferMithrilStage({
      pidAlive: false,
      exitCode: 2,
      snapshotBytes: 10,
      dbBytes: 0,
      immutableCount: 0,
      logTail: "halt-on-zero-applied",
    });
    expect(s.stage).toBe("failed");
  });
});

describe("writersConflict", () => {
  test("true when node and bootstrap share a db", () => {
    expect(
      writersConflict({
        nodeDb: "/tmp/g.db",
        nodeAlive: true,
        bootstrapDb: "/tmp/g.db",
        bootstrapAlive: false,
      }),
    ).toBe(true);
    expect(
      writersConflict({
        nodeDb: "/tmp/g.db",
        nodeAlive: false,
        bootstrapDb: "/tmp/g.db",
        bootstrapAlive: true,
      }),
    ).toBe(true);
  });

  test("false when different files or both stopped", () => {
    expect(
      writersConflict({
        nodeDb: "/tmp/a.db",
        nodeAlive: true,
        bootstrapDb: "/tmp/b.db",
        bootstrapAlive: true,
      }),
    ).toBe(false);
    expect(
      writersConflict({
        nodeDb: "/tmp/g.db",
        nodeAlive: false,
        bootstrapDb: "/tmp/g.db",
        bootstrapAlive: false,
      }),
    ).toBe(false);
  });
});
