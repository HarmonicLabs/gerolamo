import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dbSidecars, wipeDirContents, wipeFiles } from "./wipe";

describe("wipe", () => {
  test("dbSidecars lists wal/shm/journal", () => {
    const s = dbSidecars("/tmp/g.db");
    expect(s).toEqual(["/tmp/g.db", "/tmp/g.db-wal", "/tmp/g.db-shm", "/tmp/g.db-journal"]);
  });

  test("wipeFiles removes existing only", () => {
    const dir = join(tmpdir(), `gerolamo-wipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = join(dir, "gerolamo.db");
    writeFileSync(db, "x");
    writeFileSync(db + "-wal", "y");
    const r = wipeFiles(dbSidecars(db));
    expect(r.removed).toContain(db);
    expect(r.removed).toContain(db + "-wal");
    expect(existsSync(db)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("wipeDirContents keeps the directory", () => {
    const dir = join(tmpdir(), `gerolamo-snap-${Date.now()}`);
    mkdirSync(join(dir, "immutable"), { recursive: true });
    writeFileSync(join(dir, "immutable", "00000.chunk"), "c");
    writeFileSync(join(dir, ".apply-state.json"), "{}");
    const r = wipeDirContents(dir);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "immutable"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses /", () => {
    const r = wipeDirContents("/");
    expect(r.ok).toBe(false);
  });
});
